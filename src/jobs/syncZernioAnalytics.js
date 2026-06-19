const { createClient } = require('@supabase/supabase-js');
const zernioService = require('../services/zernioService');
const { calcEngagementRate, engagementToViralScore } = require('../services/uploadPostService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const DAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function today() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Sincroniza analytics de Zernio para un artista y guarda en Supabase.
 * Llamado desde el botón "Sincronizar" y por el cron job.
 */
async function syncArtistAnalytics(artistId) {
  const { data: artist, error } = await supabase
    .from('artists')
    .select('id, ayrshare_profile_key, social_keys, active_platforms, publish_mode, name')
    .eq('id', artistId)
    .single();

  if (error || !artist) {
    console.warn(`⚠️ [ZernioSync] Artista ${artistId} no encontrado`);
    return { ok: false, reason: 'artist_not_found' };
  }

  if (artist.publish_mode !== 'zernio' || !artist.ayrshare_profile_key) {
    return { ok: false, reason: 'not_zernio_artist' };
  }

  const profileId = artist.ayrshare_profile_key;
  const socialKeys = artist.social_keys || {};
  const toDate = today();

  // Primera sync → traer 1 año de historial. Después solo 30 días.
  const { count: existingSnapshots } = await supabase
    .from('platform_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('artist_id', artistId);

  const isFirstSync = !existingSnapshots || existingSnapshots === 0;
  const fromDate = isFirstSync ? daysAgo(730) : daysAgo(30);

  console.log(`🔄 [ZernioSync] ${isFirstSync ? '🆕 PRIMERA SYNC (2 años)' : 'Sync regular (30d)'} para "${artist.name}" (${artistId})`);

  const results = { platform_snapshots: 0, post_analytics: 0, best_times: false, errors: [] };

  // ── 1. MÉTRICAS DIARIAS POR PLATAFORMA ─────────────────────────────────
  try {
    const dailyData = await zernioService.getDailyMetrics(profileId, fromDate, toDate);
    const breakdown = dailyData?.platformBreakdown || [];

    if (breakdown.length > 0) {
      const snapshots = breakdown.map(pb => ({
        artist_id: artistId,
        platform: pb.platform,
        snapshot_date: toDate,
        followers: pb.followers || pb.follower_count || pb.subscribers || 0,
        reach: pb.reach || 0,
        impressions: pb.impressions || 0,
        likes: pb.likes || 0,
        comments: pb.comments || 0,
        shares: pb.shares || 0,
        saves: pb.saves || 0,
        clicks: pb.clicks || 0,
        views: pb.views || 0,
        posts_count: pb.postCount || 0,
        raw_data: pb,
        synced_at: new Date().toISOString(),
      }));

      const { error: snapErr } = await supabase
        .from('platform_snapshots')
        .upsert(snapshots, { onConflict: 'artist_id,platform,snapshot_date' });

      if (snapErr) {
        results.errors.push(`platform_snapshots: ${snapErr.message}`);
      } else {
        results.platform_snapshots = snapshots.length;
        console.log(`  ✅ platform_snapshots: ${snapshots.length} plataformas guardadas`);
      }
    }

    // Guardar también el historial diario de los últimos 30 días para el gráfico
    const dailyHistory = (dailyData?.dailyData || []).map(d => ({
      date: d.date,
      value: (d.metrics?.reach || 0) + (d.metrics?.views || 0),
    }));
    if (dailyHistory.length > 0) {
      await supabase.from('zernio_sync_cache').upsert({
        artist_id: artistId,
        cache_key: 'daily_history',
        data: dailyHistory,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'artist_id,cache_key' });
    }
  } catch (e) {
    results.errors.push(`daily_metrics: ${e.message}`);
    console.warn(`  ⚠️ [ZernioSync] daily-metrics error:`, e.message);
  }

  // ── 2. ANALYTICS POR POST → actualiza analytics_4h en videos ───────────
  try {
    const postsData = await zernioService.getAnalyticsPosts(profileId, fromDate, toDate, isFirstSync ? 500 : 100);
    const posts = postsData?.posts || postsData?.data || (Array.isArray(postsData) ? postsData : []);

    for (const post of posts) {
      const zernioPostId = post.latePostId || post.postId;
      if (!zernioPostId) continue;

      const a = post.analytics || {};
      const engRate = typeof a.engagementRate === 'number' ? a.engagementRate : 0;

      // Buscar el video por su Zernio post ID
      let { data: video } = await supabase
        .from('videos')
        .select('id')
        .eq('ayrshare_post_id', zernioPostId)
        .eq('artist_id', artistId)
        .maybeSingle();

      // Si no existe, crear entrada automática para posts descubiertos desde Zernio
      if (!video) {
        const platform = post.platform || 'unknown';
        const postTitle = post.title || post.caption || post.body || '';
        const displayTitle = postTitle.length > 80
          ? postTitle.slice(0, 80) + '…'
          : postTitle || `Post ${platform} ${(post.publishDate || post.createdAt || '').split('T')[0] || ''}`;
        const postUrl = post.postUrl || post.permalink || post.url || null;
        const publishedAt = post.publishDate || post.createdAt || new Date().toISOString();

        const { data: created, error: createErr } = await supabase
          .from('videos')
          .insert({
            artist_id: artistId,
            title: displayTitle.trim(),
            ayrshare_post_id: zernioPostId,
            platforms: [platform],
            status: 'published',
            source_url: postUrl,
            published_at: publishedAt,
            created_at: publishedAt,
          })
          .select('id')
          .single();

        if (createErr) {
          console.warn(`  ⚠️ No se pudo crear video para post ${zernioPostId}:`, createErr.message);
          continue;
        }
        video = created;
        results.posts_discovered = (results.posts_discovered || 0) + 1;
      }

      const likes = a.likes || 0;
      const comments = a.comments || 0;
      const shares = a.shares || 0;
      const saves = a.saves || 0;
      const views = a.views || 0;
      const impressions = a.impressions || 0;

      const realEngRate = calcEngagementRate(likes, comments, shares, saves, views, impressions);
      const viralScoreReal = engagementToViralScore(realEngRate);

      const analytics4h = {
        likes,
        comments,
        shares,
        saves,
        views,
        reach: a.reach || 0,
        impressions,
        clicks: a.clicks || 0,
        engagement_rate: engRate || parseFloat(realEngRate.toFixed(3)),
        ig_reels_avg_watch_time: a.igReelsAvgWatchTime || 0,
        updated_at: new Date().toISOString(),
      };

      await supabase
        .from('videos')
        .update({
          analytics_4h: analytics4h,
          viral_score_real: viralScoreReal,
        })
        .eq('id', video.id);

      await supabase.from('post_metrics_snapshots').insert({
        video_id: video.id,
        artist_id: artistId,
        platform: post.platform || 'unknown',
        likes,
        comments,
        views,
        shares,
        saves,
        reach: a.reach || 0,
        impressions,
        engagement_rate: parseFloat(realEngRate.toFixed(3)),
        viral_score_real: viralScoreReal,
        raw_data: a,
      }).then(() => {}).catch(() => {});

      results.post_analytics++;
    }

    if (results.posts_discovered) console.log(`  🆕 ${results.posts_discovered} posts nuevos descubiertos desde Zernio`);
    console.log(`  ✅ post_analytics: ${results.post_analytics} posts actualizados`);
  } catch (e) {
    results.errors.push(`post_analytics: ${e.message}`);
    console.warn(`  ⚠️ [ZernioSync] post-analytics error:`, e.message);
  }

  // ── 3. MEJOR HORA PARA PUBLICAR ─────────────────────────────────────────
  try {
    const bestTimesData = await zernioService.getBestPostingTimes(profileId);
    const slots = bestTimesData?.slots || [];

    if (slots.length > 0) {
      const formatted = slots
        .sort((a, b) => b.avg_engagement - a.avg_engagement)
        .slice(0, 7)
        .map(s => ({
          label: `${DAYS_ES[s.day_of_week]} ${String(s.hour).padStart(2, '0')}:00`,
          day: DAYS_ES[s.day_of_week],
          hour: s.hour,
          avg_engagement: parseFloat((s.avg_engagement || 0).toFixed(2)),
          posts: s.post_count || 0,
        }));

      await supabase.from('zernio_sync_cache').upsert({
        artist_id: artistId,
        cache_key: 'best_posting_times',
        data: formatted,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'artist_id,cache_key' });

      results.best_times = true;
      console.log(`  ✅ best_posting_times: ${formatted.length} slots guardados`);
    }
  } catch (e) {
    results.errors.push(`best_times: ${e.message}`);
    console.warn(`  ⚠️ [ZernioSync] best-time error:`, e.message);
  }

  // ── 4. SEGUIDORES ACTUALES POR CUENTA ───────────────────────────────────
  try {
    const accounts = await zernioService.getActivePlatforms(profileId);

    for (const acc of accounts) {
      if (!acc.followers && acc.followers !== 0) continue;

      await supabase.from('platform_snapshots').upsert({
        artist_id: artistId,
        platform: acc.platform,
        snapshot_date: toDate,
        followers: acc.followers || 0,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'artist_id,platform,snapshot_date' });
    }
    console.log(`  ✅ followers: ${accounts.length} cuentas actualizadas`);
  } catch (e) {
    results.errors.push(`followers: ${e.message}`);
    console.warn(`  ⚠️ [ZernioSync] accounts/followers error:`, e.message);
  }

  // ── 5. INSTAGRAM ACCOUNT INSIGHTS (crecimiento, reach histórico) ─────────
  if (socialKeys.instagram) {
    try {
      const igInsights = await zernioService.getInstagramAccountInsights(
        socialKeys.instagram, fromDate, toDate
      );
      if (igInsights?.success) {
        await supabase.from('zernio_sync_cache').upsert({
          artist_id: artistId,
          cache_key: 'instagram_insights',
          data: igInsights,
          synced_at: new Date().toISOString(),
        }, { onConflict: 'artist_id,cache_key' });
        console.log(`  ✅ instagram_insights guardados`);
      }
    } catch (e) {
      results.errors.push(`instagram_insights: ${e.message}`);
      console.warn(`  ⚠️ [ZernioSync] instagram insights error:`, e.message);
    }
  }

  // ── 6. YOUTUBE CHANNEL INSIGHTS (watch time, suscriptores) ──────────────
  if (socialKeys.youtube) {
    try {
      const ytInsights = await zernioService.getYouTubeChannelInsights(
        socialKeys.youtube, fromDate, toDate
      );
      if (ytInsights?.success) {
        await supabase.from('zernio_sync_cache').upsert({
          artist_id: artistId,
          cache_key: 'youtube_insights',
          data: ytInsights,
          synced_at: new Date().toISOString(),
        }, { onConflict: 'artist_id,cache_key' });
        console.log(`  ✅ youtube_insights guardados`);
      }
    } catch (e) {
      results.errors.push(`youtube_insights: ${e.message}`);
      console.warn(`  ⚠️ [ZernioSync] youtube insights error:`, e.message);
    }
  }

  console.log(`✅ [ZernioSync] "${artist.name}" completado`, results);
  return { ok: true, artistId, ...results };
}

/**
 * Sincroniza todos los artistas Zernio — llamado por el cron job de Railway.
 */
async function syncAllZernioArtists() {
  const { data: artists, error } = await supabase
    .from('artists')
    .select('id, name')
    .eq('publish_mode', 'zernio')
    .not('ayrshare_profile_key', 'is', null);

  if (error) {
    console.error('❌ [ZernioSync] Error obteniendo artistas:', error.message);
    return { ok: false, error: error.message };
  }

  console.log(`🔄 [ZernioSync] Sincronizando ${artists?.length || 0} artistas Zernio`);

  const summary = [];
  for (const artist of artists || []) {
    try {
      const result = await syncArtistAnalytics(artist.id);
      summary.push(result);
      // Pequeña pausa para no saturar la API de Zernio
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`❌ [ZernioSync] Error artista ${artist.id}:`, e.message);
      summary.push({ ok: false, artistId: artist.id, error: e.message });
    }
  }

  const succeeded = summary.filter(s => s.ok).length;
  console.log(`✅ [ZernioSync] Completado: ${succeeded}/${summary.length} artistas sincronizados`);
  return { ok: true, total: summary.length, succeeded, summary };
}

module.exports = { syncArtistAnalytics, syncAllZernioArtists };
