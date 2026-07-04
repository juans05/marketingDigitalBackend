const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const ideaBankService = require('../services/ideaBankService');
const logger = require('../services/loggerService');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);

async function createNotification(artistId, type, title, message, icon = 'bell', color = '#4F46E5') {
  try {
    await supabase.from('notifications').insert({
      artist_id: artistId,
      type,
      title,
      message,
      icon,
      color
    });
  } catch (e) {
    console.error('Notification insert error:', e.message);
  }
}

async function generateIdeasForAllArtists() {
  try {
    logger.log('info', 'CRON_DAILY_IDEAS_START');

    const { data: artists } = await supabase
      .from('artists')
      .select('id, name')
      .not('id', 'is', null);

    if (!artists || artists.length === 0) {
      logger.log('info', 'CRON_NO_ARTISTS');
      return;
    }

    let generated = 0;
    let failed = 0;

    for (const artist of artists) {
      try {
        const existing = await ideaBankService.getTodayIdeas(artist.id);
        if (existing.length >= 5) continue;

        const ideas = await ideaBankService.generateDailyIdeas(artist.id, 5);
        generated++;

        await createNotification(
          artist.id,
          'idea',
          '💡 5 ideas nuevas para ti',
          'Tienes 5 ideas frescas basadas en tendencias actuales. ¡Revísalas!',
          'lightbulb',
          '#818CF8'
        );
      } catch (err) {
        failed++;
        logger.log('error', 'CRON_IDEA_FAILED', { artistId: artist.id, error: err.message });
      }
    }

    logger.log('success', 'CRON_DAILY_IDEAS_DONE', { generated, failed, total: artists.length });
  } catch (err) {
    logger.log('error', 'CRON_DAILY_IDEAS_ERROR', { error: err.message });
  }
}

async function takeGrowthSnapshotForArtist(artistId) {
  const { data: artist } = await supabase
    .from('artists')
    .select('id, active_platforms')
    .eq('id', artistId)
    .single();

  if (!artist) return;

  const platforms = artist.active_platforms || [];
  for (const platform of platforms) {
    try {
      const { data: latest } = await supabase
        .from('analytics')
        .select('followers, total_views, total_likes, engagement_rate')
        .eq('artist_id', artist.id)
        .eq('platform', platform)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (latest) {
        await supabase.from('growth_snapshots').upsert({
          artist_id: artist.id,
          platform,
          followers: latest.followers || 0,
          total_views: latest.total_views || 0,
          total_likes: latest.total_likes || 0,
          engagement_rate: latest.engagement_rate || 0,
          snapshot_date: new Date().toISOString().split('T')[0]
        }, { onConflict: 'artist_id,platform,snapshot_date' });
      }
    } catch (e) {
      // Skip this platform
    }
  }
}

async function takeGrowthSnapshot() {
  try {
    const { data: artists } = await supabase
      .from('artists')
      .select('id');

    if (!artists) return;

    for (const artist of artists) {
      await takeGrowthSnapshotForArtist(artist.id);
    }

    logger.log('info', 'CRON_GROWTH_SNAPSHOT_DONE');
  } catch (err) {
    logger.log('error', 'CRON_GROWTH_SNAPSHOT_ERROR', { error: err.message });
  }
}

// ── Feature B: Weekly competitor snapshots ──────────────────────────────────

async function takeCompetitorSnapshots() {
  try {
    logger.log('info', 'CRON_DAILY_COMPETITOR_SNAPSHOTS_START');

    const now = new Date().toISOString();
    const { data: artists } = await supabase
      .from('artists')
      .select('id')
      .eq('competitor_snapshot_enabled', true)
      .gte('competitor_snapshot_expires_at', now);

    if (!artists || artists.length === 0) {
      logger.log('info', 'CRON_NO_ARTISTS_FOR_COMPETITOR_SNAPSHOTS');
      return;
    }

    let totalSnapshots = 0;

    for (const artist of artists) {
      try {
        const { data: competitors } = await supabase
          .from('competitors')
          .select('*')
          .eq('artist_id', artist.id);

        if (!competitors || competitors.length === 0) continue;

        for (const competitor of competitors) {
          const usernames = [
            { platform: 'tiktok', username: competitor.tiktok_username },
            { platform: 'youtube', username: competitor.youtube_username },
            { platform: 'instagram', username: competitor.instagram_username },
          ];

          for (const { platform, username } of usernames) {
            if (!username) continue;

            let data = null;
            try {
              if (platform === 'tiktok') {
                const axios = require('axios');
                const { data: html } = await axios.get(
                  `https://tiktok.com/@${encodeURIComponent(username.replace('@', '').trim())}?is_copy_url=1&is_from_webapp=v1`,
                  {
                    headers: { 'User-Agent': 'com.zhiliaoapp.musically/2022600040 (Linux; U; Android 12; en_US; Pixel 6; Build/SQ3A.220705.003.A1; Cronet/58.0.2991.100)' },
                    timeout: 10000,
                  }
                );
                const extract = (key) => {
                  const match = html.match(new RegExp(`"${key}":(\\d+)`));
                  return match ? parseInt(match[1]) : 0;
                };
                data = {
                  followers: extract('followerCount'),
                  following: extract('followingCount'),
                  likes: extract('heartCount') || extract('heart'),
                  videos: extract('videoCount'),
                };
              } else if (platform === 'youtube') {
                const ytService = require('../services/competitorService');
                data = await ytService.scrapeYouTube(username);
              } else if (platform === 'instagram') {
                const igService = require('../services/competitorService');
                data = await igService.scrapeInstagram(username);
              }
            } catch (e) {
              logger.log('warn', 'COMPETITOR_SNAPSHOT_FAILED', { competitor: competitor.name, platform, error: e.message });
              continue;
            }

            if (!data) continue;

            const followers = data.followers || 0;
            const avgLikes = data.avg_likes_per_video || data.avg_likes || 0;
            const engagementRate = followers > 0
              ? parseFloat(((avgLikes) / followers * 100).toFixed(2))
              : 0;

            await supabase
              .from('competitor_weekly_snapshots')
              .upsert({
                competitor_id: competitor.id,
                platform,
                snapshot_date: new Date().toISOString().split('T')[0],
                followers,
                following: data.following || 0,
                likes: data.likes || 0,
                videos: data.videos || 0,
                posts: data.posts || 0,
                engagement_rate: engagementRate,
              }, { onConflict: 'competitor_id,platform,snapshot_date' });

            totalSnapshots++;

            // Alert if growth >5%
            const { data: prev } = await supabase
              .from('competitor_weekly_snapshots')
              .select('followers')
              .eq('competitor_id', competitor.id)
              .eq('platform', platform)
              .order('snapshot_date', { ascending: false })
              .limit(2)
              .offset(1);

            if (prev && prev.length > 0 && prev[0].followers > 0) {
              const growth = ((followers - prev[0].followers) / prev[0].followers) * 100;
              if (growth > 5) {
                const { data: artistRow } = await supabase
                  .from('artists')
                  .select('agency_id')
                  .eq('id', artist.id)
                  .single();

                if (artistRow?.agency_id) {
                  await supabase.from('notifications').insert({
                    artist_id: artist.id,
                    type: 'competitor_alert',
                    title: `🚀 ${competitor.name} creció ${growth.toFixed(1)}% en ${platform}`,
                    message: `Tu competidor ${competitor.name} ganó ${followers - prev[0].followers} seguidores en ${platform} esta semana.`,
                    icon: 'trending_up',
                    color: '#EF4444',
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        logger.log('error', 'COMPETITOR_SNAPSHOT_ARTIST_FAILED', { artistId: artist.id, error: e.message });
      }
    }

    logger.log('info', 'CRON_DAILY_COMPETITOR_SNAPSHOTS_DONE', { totalSnapshots });
  } catch (err) {
    logger.log('error', 'CRON_DAILY_COMPETITOR_SNAPSHOTS_ERROR', { error: err.message });
  }
}

function startCronJobs() {
  // Generate daily ideas at 6:00 AM every day
  cron.schedule('0 6 * * *', () => {
    console.log('⏰ Running daily idea generation...');
    generateIdeasForAllArtists();
  });

  // Take growth snapshots at midnight
  cron.schedule('0 0 * * *', () => {
    console.log('📊 Taking growth snapshots...');
    takeGrowthSnapshot();
  });

  // Daily competitor snapshots at 6:00 AM (solo artistas con tracking activo y vigente)
  cron.schedule('0 6 * * *', () => {
    console.log('🕵️ Taking daily competitor snapshots...');
    takeCompetitorSnapshots();
  });

  console.log('✅ Cron jobs registered: daily ideas (6AM), growth snapshots (midnight), competitor snapshots (6AM)');
}

module.exports = { startCronJobs, generateIdeasForAllArtists, takeGrowthSnapshot, takeGrowthSnapshotForArtist, createNotification, takeCompetitorSnapshots };
