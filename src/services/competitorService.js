const axios = require('axios');
const logger = require('./loggerService');

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const SCRAPER_URL = process.env.SCRAPER_URL || 'http://localhost:3002';

// ── ScrapeGraph-AI integration (Python microservice) ─────────────────────────

async function scrapeWithAI(platform, username) {
  try {
    const { data } = await axios.post(`${SCRAPER_URL}/scrape`, {
      platform,
      username: username.replace('@', '').trim(),
    }, { timeout: 30000 });

    if (!data?.data) return null;

    const raw = data.data;
    const result = {
      platform,
      username: raw.username || username.replace('@', '').trim(),
      display_name: raw.display_name || raw.channel_name || raw.page_name || '',
      profile_picture: raw.profile_picture_url || null,
      followers: parseInt(raw.followers || raw.subscribers || 0) || 0,
      following: parseInt(raw.following || 0) || 0,
      likes: parseInt(raw.likes || raw.hearts || 0) || 0,
      videos: parseInt(raw.videos || 0) || 0,
      posts: parseInt(raw.posts || 0) || 0,
      bio: raw.bio || raw.description || '',
      is_verified: raw.is_verified || false,
      source: 'scrapegraph-ai',
    };

    const contentCount = result.videos || result.posts || 1;
    const avgLikes = result.likes > 0 ? Math.round(result.likes / contentCount) : 0;
    result.avg_likes_per_video = avgLikes;
    result.engagement_rate_estimate = result.followers > 0
      ? parseFloat((avgLikes / result.followers * 100).toFixed(2))
      : 0;

    return result;
  } catch (err) {
    logger.log('warn', 'SCRAPEGRAPH_UNAVAILABLE', { platform, username, error: err.message });
    return null;
  }
}

async function scrapeAllWithAI(competitor) {
  try {
    const payload = {
      tiktok_username: competitor.tiktok_username || undefined,
      youtube_username: competitor.youtube_username || undefined,
      instagram_username: competitor.instagram_username || undefined,
      facebook_username: competitor.facebook_username || undefined,
    };
    console.log('[scrapeAllWithAI] payload:', JSON.stringify(payload));

    const { data } = await axios.post(`${SCRAPER_URL}/scrape-all`, payload, { timeout: 60000 });

    console.log('[scrapeAllWithAI] response:', JSON.stringify(data));

    if (!data?.results) return null;

    const results = {};
    for (const [plat, entry] of Object.entries(data.results)) {
      const raw = entry.data || {};
      results[plat] = {
        platform: plat,
        username: raw.username || raw.channel_name || entry.username || '',
        display_name: raw.display_name || raw.channel_name || raw.page_name || '',
        profile_picture: raw.profile_picture_url || null,
        followers: parseInt(raw.followers || raw.subscribers || 0) || 0,
        following: parseInt(raw.following || 0) || 0,
        likes: parseInt(raw.likes || 0) || 0,
        videos: parseInt(raw.videos || 0) || 0,
        posts: parseInt(raw.posts || 0) || 0,
        bio: raw.bio || raw.description || '',
        is_verified: raw.is_verified || false,
        source: 'scrapegraph-ai',
      };

      const r = results[plat];
      const contentCount = r.videos || r.posts || 1;
      const avgLikes = r.likes > 0 ? Math.round(r.likes / contentCount) : 0;
      r.avg_likes_per_video = avgLikes;
      r.engagement_rate_estimate = r.followers > 0
        ? parseFloat((avgLikes / r.followers * 100).toFixed(2))
        : 0;
    }

    return Object.keys(results).length > 0 ? results : null;
  } catch (err) {
    logger.log('warn', 'SCRAPEGRAPH_BULK_UNAVAILABLE', { error: err.message });
    return null;
  }
}

async function isScraperAvailable() {
  try {
    const { data } = await axios.get(`${SCRAPER_URL}/health`, { timeout: 3000 });
    return data?.status === 'ok';
  } catch { return false; }
}

// ── TikTok (same pattern as tiktokScraper.js) ────────────────────────────────

async function scrapeTikTok(username) {
  if (!username) return null;
  username = username.replace('@', '').trim();

  try {
    const { data } = await axios.get(
      `https://tiktok.com/@${encodeURIComponent(username)}?is_copy_url=1&is_from_webapp=v1`,
      {
        headers: { 'User-Agent': 'com.zhiliaoapp.musically/2022600040 (Linux; U; Android 12; en_US; Pixel 6; Build/SQ3A.220705.003.A1; Cronet/58.0.2991.100)' },
        timeout: 12000,
        maxRedirects: 5,
      }
    );

    const extract = (key) => {
      const match = data.match(new RegExp(`"${key}":(\\d+)`));
      return match ? parseInt(match[1]) : 0;
    };

    const stats = {
      followers: extract('followerCount'),
      following: extract('followingCount'),
      likes: extract('heartCount') || extract('heart'),
      videos: extract('videoCount'),
    };

    if (stats.followers === 0 && stats.likes === 0 && stats.videos === 0) return null;

    const avgLikesPerVideo = stats.videos > 0 ? Math.round(stats.likes / stats.videos) : 0;
    const engagementEstimate = stats.followers > 0
      ? parseFloat((avgLikesPerVideo / stats.followers * 100).toFixed(2))
      : 0;

    return {
      platform: 'tiktok',
      username,
      ...stats,
      avg_likes_per_video: avgLikesPerVideo,
      engagement_rate_estimate: engagementEstimate,
    };
  } catch (err) {
    logger.log('error', 'COMPETITOR_TIKTOK_SCRAPE', { username, error: err.message });
    return null;
  }
}

// ── YouTube (Public Data API v3) ─────────────────────────────────────────────

async function scrapeYouTube(channelIdentifier) {
  if (!channelIdentifier) return null;
  channelIdentifier = channelIdentifier.replace('@', '').trim();

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    logger.log('warn', 'COMPETITOR_YT_NO_KEY', { msg: 'YOUTUBE_API_KEY not set' });
    return null;
  }

  try {
    let channelId = channelIdentifier;

    if (!channelIdentifier.startsWith('UC')) {
      const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: { part: 'snippet', q: channelIdentifier, type: 'channel', maxResults: 1, key: apiKey },
        timeout: 10000,
      });
      const items = searchRes.data?.items || [];
      if (items.length === 0) return null;
      channelId = items[0].snippet.channelId;
    }

    const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'statistics,snippet', id: channelId, key: apiKey },
      timeout: 10000,
    });

    const channel = channelRes.data?.items?.[0];
    if (!channel) return null;

    const stats = channel.statistics || {};
    const subscribers = parseInt(stats.subscriberCount) || 0;
    const totalViews = parseInt(stats.viewCount) || 0;
    const videoCount = parseInt(stats.videoCount) || 0;

    const avgViewsPerVideo = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;

    return {
      platform: 'youtube',
      username: channel.snippet?.customUrl || channelIdentifier,
      display_name: channel.snippet?.title || '',
      profile_picture: channel.snippet?.thumbnails?.default?.url || null,
      followers: subscribers,
      total_views: totalViews,
      videos: videoCount,
      avg_views_per_video: avgViewsPerVideo,
    };
  } catch (err) {
    logger.log('error', 'COMPETITOR_YT_SCRAPE', { channelIdentifier, error: err.message });
    return null;
  }
}

// ── Instagram (Public profile scrape) ────────────────────────────────────────

async function scrapeInstagram(username) {
  if (!username) return null;
  username = username.replace('@', '').trim();

  try {
    const { data } = await axios.get(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
      headers: {
        'User-Agent': MOBILE_UA,
        'x-ig-app-id': '936619743392459',
      },
      timeout: 12000,
    });

    const user = data?.data?.user;
    if (!user) return null;

    const followers = user.edge_followed_by?.count || 0;
    const following = user.edge_follow?.count || 0;
    const posts = user.edge_owner_to_timeline_media?.count || 0;

    const recentPosts = (user.edge_owner_to_timeline_media?.edges || []).slice(0, 12);
    let totalLikes = 0;
    let totalComments = 0;
    recentPosts.forEach(edge => {
      totalLikes += edge.node?.edge_liked_by?.count || 0;
      totalComments += edge.node?.edge_media_to_comment?.count || 0;
    });

    const avgLikes = recentPosts.length > 0 ? Math.round(totalLikes / recentPosts.length) : 0;
    const avgComments = recentPosts.length > 0 ? Math.round(totalComments / recentPosts.length) : 0;
    const engagementRate = followers > 0
      ? parseFloat(((avgLikes + avgComments) / followers * 100).toFixed(2))
      : 0;

    return {
      platform: 'instagram',
      username,
      display_name: user.full_name || username,
      profile_picture: user.profile_pic_url_hd || user.profile_pic_url || null,
      followers,
      following,
      posts,
      avg_likes: avgLikes,
      avg_comments: avgComments,
      engagement_rate_estimate: engagementRate,
      is_verified: user.is_verified || false,
    };
  } catch (err) {
    logger.log('error', 'COMPETITOR_IG_SCRAPE', { username, error: err.message });
    return null;
  }
}

// ── Analyze all platforms for a competitor ────────────────────────────────────

async function analyzeCompetitor(competitor) {
  const aiAvailable = await isScraperAvailable();

  if (!aiAvailable) {
    throw new Error(`El microservicio de scraping no está disponible (${SCRAPER_URL}). Inicia el servidor Python en scraper/.`);
  }

  logger.log('info', 'COMPETITOR_USING_AI_SCRAPER', { competitor: competitor.name });
  const aiResults = await scrapeAllWithAI(competitor) || {};

  // TikTok: the headless browser gets detected — use mobile UA scraper as fallback
  if (competitor.tiktok_username && (!aiResults.tiktok || !aiResults.tiktok.followers)) {
    logger.log('info', 'COMPETITOR_TIKTOK_FALLBACK', { username: competitor.tiktok_username });
    const tiktokData = await scrapeTikTok(competitor.tiktok_username);
    if (tiktokData) aiResults.tiktok = tiktokData;
  }

  if (Object.keys(aiResults).length === 0) {
    throw new Error('No se pudieron obtener datos. Verifica los usernames e intenta de nuevo.');
  }

  return aiResults;
}

// ── Compare competitor vs artist ─────────────────────────────────────────────

function compareMetrics(artistData, competitorData) {
  const comparisons = {};

  for (const [platform, comp] of Object.entries(competitorData)) {
    const artist = artistData[platform];
    if (!artist) {
      comparisons[platform] = { competitor: comp, artist: null, insights: ['No tienes esta plataforma conectada. Considera activarla.'] };
      continue;
    }

    const insights = [];
    const metrics = {};

    const artFollowers = artist.followers || 0;
    const compFollowers = comp.followers || 0;

    metrics.followers = { artist: artFollowers, competitor: compFollowers };
    if (compFollowers > artFollowers && artFollowers > 0) {
      const ratio = (compFollowers / artFollowers).toFixed(1);
      insights.push(`Tiene ${ratio}x más seguidores que tú (${formatNum(compFollowers)} vs ${formatNum(artFollowers)}).`);
    } else if (artFollowers > compFollowers && compFollowers > 0) {
      insights.push(`Tienes más seguidores (${formatNum(artFollowers)} vs ${formatNum(compFollowers)}). Tu ventaja está en la audiencia.`);
    }

    const artER = artist.engagement_rate || artist.engagement_rate_estimate || 0;
    const compER = comp.engagement_rate_estimate || comp.engagement_rate || 0;
    metrics.engagement_rate = { artist: artER, competitor: compER };

    if (artER > 0 && compER > 0) {
      if (artER > compER * 1.2) {
        insights.push(`Tu engagement (${artER.toFixed(1)}%) es superior al suyo (${compER.toFixed(1)}%). Tu contenido conecta mejor con tu audiencia.`);
      } else if (compER > artER * 1.2) {
        insights.push(`Su engagement (${compER.toFixed(1)}%) supera al tuyo (${artER.toFixed(1)}%). Analiza qué tipo de contenido genera más interacción.`);
      } else {
        insights.push(`Engagement similar (~${artER.toFixed(1)}% vs ${compER.toFixed(1)}%). La diferencia está en alcance y frecuencia.`);
      }
    }

    const compVideos = comp.videos || comp.posts || 0;
    const artVideos = artist.posts_count || artist.videos || 0;
    if (compVideos > 0 && artVideos > 0) {
      metrics.content_volume = { artist: artVideos, competitor: compVideos };
      if (compVideos > artVideos * 1.5) {
        insights.push(`Publica mucho más contenido (${compVideos} vs ${artVideos}). Considera aumentar tu frecuencia de publicación.`);
      } else if (artVideos > compVideos * 1.5) {
        insights.push(`Publicas más que tu competidor (${artVideos} vs ${compVideos}). Enfócate en calidad sobre cantidad.`);
      }
    }

    if (comp.avg_likes_per_video || comp.avg_likes) {
      const compAvgLikes = comp.avg_likes_per_video || comp.avg_likes || 0;
      metrics.avg_likes = { competitor: compAvgLikes };
      insights.push(`Promedio de likes por post: ${formatNum(compAvgLikes)}.`);
    }

    comparisons[platform] = {
      competitor: comp,
      artist: {
        followers: artFollowers,
        engagement_rate: artER,
        posts_count: artVideos,
      },
      metrics,
      insights,
    };
  }

  return comparisons;
}

function generateActionPlan(comparisons) {
  const actions = [];

  for (const [platform, data] of Object.entries(comparisons)) {
    if (!data.artist) {
      actions.push({ platform, action: `Conecta ${platform} para poder comparar métricas con tu competencia.`, priority: 'medium' });
      continue;
    }

    const { metrics, insights } = data;

    if (metrics.engagement_rate) {
      const { artist: aER, competitor: cER } = metrics.engagement_rate;
      if (aER > cER * 1.2) {
        actions.push({ platform, action: `Tu engagement es tu ventaja en ${platform}. Aprovéchalo publicando más frecuentemente.`, priority: 'high' });
      } else if (cER > aER * 1.2) {
        actions.push({ platform, action: `Mejora tu engagement en ${platform}. Prueba hooks más directos y CTAs que inviten a comentar.`, priority: 'high' });
      }
    }

    if (metrics.followers) {
      const { artist: aF, competitor: cF } = metrics.followers;
      if (cF > aF * 3 && aF > 0) {
        actions.push({ platform, action: `Tu competidor tiene ${(cF / aF).toFixed(0)}x más seguidores en ${platform}. Enfócate en contenido compartible para crecer orgánicamente.`, priority: 'medium' });
      }
    }

    if (metrics.content_volume) {
      const { artist: aV, competitor: cV } = metrics.content_volume;
      if (cV > aV * 1.5) {
        actions.push({ platform, action: `Estás publicando ${Math.round(cV / aV)}x menos que tu competidor en ${platform}. Sube tu frecuencia gradualmente.`, priority: 'high' });
      }
    }
  }

  if (actions.length === 0) {
    actions.push({ platform: 'general', action: 'Estás al nivel de tu competencia. Mantén tu ritmo y experimenta con nuevos formatos.', priority: 'low' });
  }

  return actions.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.priority] || 2) - (order[b.priority] || 2);
  });
}

function formatNum(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ── Feature A: Scrape recent posts for content analysis ────────────────────

async function scrapeCompetitorPosts(competitor) {
  const results = {};
  const usernames = [
    { platform: 'tiktok', username: competitor.tiktok_username },
    { platform: 'youtube', username: competitor.youtube_username },
    { platform: 'instagram', username: competitor.instagram_username },
  ];

  for (const { platform, username } of usernames) {
    if (!username) continue;
    try {
      const posts = await scrapePostsForPlatform(platform, username);
      if (posts && posts.length > 0) results[platform] = posts;
    } catch (e) {
      logger.log('warn', 'CONTENT_SCRAPE_FAILED', { platform, username, error: e.message });
    }
  }

  return Object.keys(results).length > 0 ? results : null;
}

async function scrapePostsForPlatform(platform, username) {
  username = username.replace('@', '').trim();
  const maxPosts = 20;

  try {
    if (platform === 'tiktok') {
      const { data } = await axios.get(
        `https://tiktok.com/@${encodeURIComponent(username)}?is_copy_url=1&is_from_webapp=v1`,
        {
          headers: { 'User-Agent': 'com.zhiliaoapp.musically/2022600040 (Linux; U; Android 12; en_US; Pixel 6; Build/SQ3A.220705.003.A1; Cronet/58.0.2991.100)' },
          timeout: 15000,
        }
      );

      const postRegex = /"itemList":(\[.*?\]),/;
      const match = data.match(postRegex);
      if (!match) return [];

      const items = JSON.parse(match[1]).slice(0, maxPosts);
      return items.map(item => ({
        id: item.id || item.aweme_id || '',
        title: item.desc || item.title || '',
        likes: item.stats?.diggCount || item.stats?.likeCount || 0,
        comments: item.stats?.commentCount || 0,
        shares: item.stats?.shareCount || 0,
        views: item.stats?.playCount || item.stats?.viewCount || 0,
        duration: item.video?.duration ? `${Math.round(item.video.duration)}s` : null,
        hashtags: (item.challenges || []).map(c => c.title).filter(Boolean),
        url: `https://tiktok.com/@${username}/video/${item.id || ''}`,
        platform: 'tiktok',
      }));
    }

    if (platform === 'instagram') {
      const { data } = await axios.get(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            'x-ig-app-id': '936619743392459',
          },
          timeout: 15000,
        }
      );

      const edges = data?.data?.user?.edge_owner_to_timeline_media?.edges || [];
      return edges.slice(0, maxPosts).map(edge => {
        const node = edge.node;
        const hashtags = [];
        if (node.edge_media_to_caption?.edges?.[0]?.node?.text) {
          const tagMatch = node.edge_media_to_caption.edges[0].node.text.match(/#\w+/g);
          if (tagMatch) hashtags.push(...tagMatch);
        }
        return {
          id: node.id || '',
          title: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
          likes: node.edge_liked_by?.count || node.like_count || 0,
          comments: node.edge_media_to_comment?.count || node.comment_count || 0,
          views: node.video_view_count || 0,
          duration: node.video_duration ? `${Math.round(node.video_duration)}s` : null,
          hashtags,
          url: `https://instagram.com/p/${node.shortcode || ''}/`,
          platform: 'instagram',
          is_video: node.is_video || false,
          taken_at: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
        };
      });
    }

    if (platform === 'youtube') {
      const apiKey = process.env.YOUTUBE_API_KEY;
      if (!apiKey) return [];

      let channelId = username;
      if (!username.startsWith('UC')) {
        const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
          params: { part: 'snippet', q: username, type: 'channel', maxResults: 1, key: apiKey },
          timeout: 10000,
        });
        const items = searchRes.data?.items || [];
        if (items.length === 0) return [];
        channelId = items[0].snippet.channelId;
      }

      const videosRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          part: 'snippet',
          channelId,
          maxResults: Math.min(maxPosts, 50),
          order: 'date',
          type: 'video',
          key: apiKey,
        },
        timeout: 10000,
      });

      const videoIds = (videosRes.data?.items || []).map(v => v.id.videoId).filter(Boolean);
      if (videoIds.length === 0) return [];

      const statsRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: {
          part: 'statistics,contentDetails',
          id: videoIds.join(','),
          key: apiKey,
        },
        timeout: 10000,
      });

      const statsMap = {};
      (statsRes.data?.items || []).forEach(item => {
        statsMap[item.id] = {
          likes: parseInt(item.statistics?.likeCount) || 0,
          comments: parseInt(item.statistics?.commentCount) || 0,
          views: parseInt(item.statistics?.viewCount) || 0,
          duration: item.contentDetails?.duration || null,
        };
      });

      return (videosRes.data?.items || []).slice(0, maxPosts).map(v => {
        const sid = v.id.videoId;
        const stats = statsMap[sid] || {};
        return {
          id: sid,
          title: v.snippet?.title || '',
          likes: stats.likes,
          comments: stats.comments,
          views: stats.views,
          duration: stats.duration ? convertYouTubeDuration(stats.duration) : null,
          hashtags: [],
          url: `https://youtube.com/watch?v=${sid}`,
          platform: 'youtube',
          published_at: v.snippet?.publishedAt || null,
        };
      });
    }

    return [];
  } catch (err) {
    logger.log('error', `CONTENT_SCRAPE_${platform.toUpperCase()}`, { username, error: err.message });
    return [];
  }
}

function convertYouTubeDuration(iso) {
  if (!iso) return null;
  const match = iso.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  if (!match) return null;
  const h = parseInt(match[1]) || 0;
  const m = parseInt(match[2]) || 0;
  const s = parseInt(match[3]) || 0;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min`;
  return `${s}s`;
}

// ── Feature C: Generate steal ideas from competitor content ────────────────

async function generateStealIdeas(competitorContent, artist) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const viralPosts = [];
  for (const [platform, posts] of Object.entries(competitorContent)) {
    (posts || []).slice(0, 5).forEach(p => {
      const score = (p.likes || 0) + (p.comments || 0) + (p.shares || 0) + (p.views || 0) / 100;
      viralPosts.push({ ...p, _score: score, _platform: platform });
    });
  }

  viralPosts.sort((a, b) => b._score - a._score);
  const topViral = viralPosts.slice(0, 5);

  const postsText = topViral.map((p, i) =>
    `Post ${i + 1} [${p._platform}]: "${(p.title || '').substring(0, 200)}" | Likes: ${p.likes || 0} | Comments: ${p.comments || 0} | Views: ${p.views || 0} | Duration: ${p.duration || 'N/A'} | Hashtags: ${(p.hashtags || []).join(', ')}`
  ).join('\n\n');

  const prompt = `Eres un estratega de contenido viral. Tu tarea es generar ideas ORIGINALES adaptadas al estilo del artista, basándote en los posts virales de su competencia.

CONTEXTO DEL ARTISTA:
- Nombre: ${artist.name || 'N/A'}
- Género/Estilo: ${artist.ai_genre || 'N/A'}
- Audiencia: ${artist.ai_audience || 'N/A'}
- Tono: ${artist.ai_tone || 'N/A'}
- Plataformas activas: ${(artist.active_platforms || []).join(', ') || 'N/A'}

TOP POSTS VIRALES DEL COMPETIDOR (basados en engagement):
${postsText}

INSTRUCCIONES:
1. NO copies los posts del competidor — ADAPTA los temas que funcionan al estilo único del artista
2. Cada idea debe ser viable para al menos una plataforma del artista
3. Incluye variedad de formatos (tutorial, opinión, detrás de cámara, storytime, reacción, etc.)
4. Los hooks deben generar curiosidad instantánea
5. El CTA debe provocar interacción (comentario, compartir, guardar)

Responde ÚNICAMENTE con un JSON array. Sin texto adicional:
[
  {
    "title": "Título sugerido del contenido",
    "hook": "Hook de apertura (1-2 líneas que detienen el scroll)",
    "cta": "Call to action final",
    "platforms": {
      "tiktok": "formato sugerido para TikTok o null",
      "instagram": "formato sugerido para Instagram o null",
      "youtube": "formato sugerido para YouTube o null"
    },
    "inspiration_source": "qué post del competidor inspiró esta idea (tema general, no copia literal)"
  }
]`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.log('error', 'STEAL_IDEAS_FAILED', { error: err.message });
    throw err;
  }
}

module.exports = {
  scrapeTikTok,
  scrapeYouTube,
  scrapeInstagram,
  scrapeWithAI,
  scrapeAllWithAI,
  isScraperAvailable,
  analyzeCompetitor,
  compareMetrics,
  generateActionPlan,
  scrapeCompetitorPosts,
  generateStealIdeas,
};
