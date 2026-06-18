const crypto = require('crypto');
const vidalisService = require('../services/vidalisService');
const cloudinaryService = require('../services/cloudinaryService');
const instagramService = require('../services/instagramService');
const uploadPostService = require('../services/uploadPostService');
const zernioService = require('../services/zernioService');
const { syncArtistAnalytics } = require('../jobs/syncZernioAnalytics');
const { generateInsights } = require('../services/aiService');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);
const aiService = require('../services/aiService');
const growthService = require('../services/growthService');

// --- CONFIG PÚBLICA ---
exports.getConfig = async (req, res) => {
  try {
    const { key } = req.params;
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', key)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Config not found' });
    res.status(200).json({ key, value: data.value });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// --- ANALIZAR ESTRATEGIA DE CONTENIDO ---
exports.analyzeContentStrategy = async (req, res) => {
  try {
    const { script, tone, platform, artist_id } = req.body;
    if (!script?.trim()) return res.status(400).json({ error: 'Se requiere el script o URL del contenido' });

    const [artistPromise, videosPromise, configRes] = await Promise.all([
      artist_id ? supabase.from('artists').select('ai_tone, name').eq('id', artist_id).single() : { data: null },
      artist_id ? supabase.from('videos')
        .select('title, viral_score, viral_score_real, status, platforms')
        .eq('artist_id', artist_id)
        .not('viral_score_real', 'is', null)
        .order('created_at', { ascending: false })
        .limit(15) : { data: [] },
      supabase.from('app_config').select('value').eq('key', 'content_analysis').single(),
    ]);

    let artistContext = null;
    if (artistPromise.data) {
      const videos = videosPromise.data || [];
      const scores = videos.map(v => v.viral_score_real).filter(Boolean);
      artistContext = {
        artistId: artist_id,
        tono: artistPromise.data.ai_tone,
        nombre: artistPromise.data.name,
        videoHistory: videos.map(v => ({
          title: v.title,
          score: v.viral_score_real,
          platforms: v.platforms,
        })),
        avgScore: scores.length ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null,
        bestScore: scores.length ? Math.max(...scores) : null,
        totalVideos: scores.length,
      };
    }

    const aiConfig = configRes.data?.value || {};
    const result = await aiService.analyzeContentStrategy(script, tone || 'natural', platform || 'tiktok', artistContext, aiConfig);
    res.status(200).json(result);
  } catch (error) {
    console.error('❌ analyzeContentStrategy:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// --- VISUAL VIRAL SCORE (análisis de imagen/video) ---
exports.scoreVisualVirality = async (req, res) => {
  try {
    const { media_url, media_type, platform, artist_id } = req.body;
    if (!media_url) return res.status(400).json({ error: 'Se requiere media_url' });
    const result = await aiService.scoreVisualVirality(
      media_url,
      media_type || 'image',
      platform || 'tiktok',
      artist_id || null
    );
    res.status(200).json(result);
  } catch (error) {
    console.error('❌ scoreVisualVirality:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// --- REFINAR COPY (Marketing Skills) ---
exports.refineCopy = async (req, res) => {
  try {
    const { text, artist_id } = req.body;
    if (!text) throw new Error('Se requiere el texto a refinar');

    let artistContext = null;
    if (artist_id) {
      const { data } = await supabase.from('artists').select('ai_tone').eq('id', artist_id).single();
      if (data) artistContext = { tono: data.ai_tone };
    }

    const refined = await aiService.refineCopy(text, artistContext);
    res.status(200).json({ refined });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// --- LOGIN ---
exports.login = async (req, res) => {
  try {
    const { email, password, account_type, name, birth_date } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Se requiere email y contraseña' });
    }
    const userData = await vidalisService.loginUser(email, password, account_type || null, name || null, birth_date || null);
    res.status(200).json(userData);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
};

// --- LOGIN CON GOOGLE ---
exports.googleLogin = async (req, res) => {
  try {
    const { idToken, platform } = req.body;
    if (!idToken) throw new Error('Se requiere idToken de Google');
    
    const userData = await vidalisService.loginWithGoogle(idToken, platform || 'android');
    res.status(200).json(userData);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
};

exports.createAgency = async (req, res) => {
  try {
    const result = await vidalisService.createAgency(req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createArtist = async (req, res) => {
  try {
    const result = await vidalisService.createArtist(req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Listar artistas de una agencia
exports.getArtists = async (req, res) => {
  try {
    const { agencyId } = req.params;
    const artists = await vidalisService.getArtistsByAgency(agencyId);
    res.status(200).json(artists);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.completeOnboarding = async (req, res) => {
  try {
    const result = await vidalisService.completeOnboarding(req.body);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getSignature = (req, res) => {
  try {
    const { folder, resourceType } = req.query;
    const signatureData = cloudinaryService.generateUploadSignature(folder, resourceType || 'video');
    res.status(200).json(signatureData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.processVideo = async (req, res) => {
  try {
    const { videoData } = req.body;
    const result = await vidalisService.registerVideo(videoData);
    const platformWarning = result._platformWarning || null;
    delete result._platformWarning;
    res.status(201).json({ ...result, platformWarning });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getGallery = async (req, res) => {
  try {
    const { artistId } = req.params;
    const { limit, page } = req.query;
    
    const gallery = await vidalisService.fetchArtistGallery(artistId, {
      limit: parseInt(limit) || 20,
      page: parseInt(page) || 1
    });
    
    res.status(200).json(gallery);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getVideoAnalytics = async (req, res) => {
  try {
    const { videoId } = req.params;
    const data = await vidalisService.getVideoAnalytics(videoId);
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { artistId } = req.query;
    const stats = await vidalisService.getDashboardStats(agencyId, artistId);
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.purchaseSparks = async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId || !amount) throw new Error('Se requiere userId y amount');
    const result = await vidalisService.purchaseSparks(userId, amount);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.redeemCoupon = async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code) throw new Error('Se requiere userId y código');
    const result = await vidalisService.redeemCoupon(userId, code);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getViralScore = async (req, res) => {
  try {
    const { videoUrl } = req.body;
    const score = await vidalisService.analyzeViralPotential(videoUrl);
    res.status(200).json(score);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Conectar redes sociales de un ARTISTA
exports.connectSocial = async (req, res) => {
  try {
    const { artistId } = req.params;
    const { platform } = req.query;
    const result = await vidalisService.connectSocialAccounts(artistId, platform || null);
    res.status(200).json(result);
  } catch (error) {
    if (error.profileLimitReached) {
      return res.status(403).json({
        error: 'Límite de perfiles alcanzado',
        code: 'PROFILE_LIMIT_REACHED',
        message: 'Tu plan actual no permite más perfiles de redes sociales. Contacta a soporte para ampliar tu plan.',
        details: error.details
      });
    }
    const status = error.status || error.response?.status || 500;
    res.status(status).json({ error: error.message, details: error.response?.data || error.details || null });
  }
};

// Verificar plataformas conectadas de un ARTISTA
exports.getSocialStatus = async (req, res) => {
  try {
    const { artistId } = req.params;
    const refresh = req.query.refresh === 'true';
    const result = await vidalisService.getSocialStatus(artistId, refresh);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.publishToSocial = async (req, res) => {
  try {
    const {
      text, platforms, mediaUrls, profileKey,
      facebookOptions, instagramOptions, tiktokOptions, youtubeOptions,
      linkedinOptions, twitterOptions
    } = req.body;

    if (!text || !platforms || platforms.length === 0) {
      return res.status(400).json({ error: 'Se requiere text y al menos una plataforma' });
    }

    const options = { facebookOptions, instagramOptions, tiktokOptions, youtubeOptions, linkedinOptions, twitterOptions };
    const result = await uploadPostService.publishPost(text, platforms, mediaUrls || [], profileKey || null, options);
    res.status(200).json(result);
  } catch (error) {
    const status = error.status || error.response?.status || 500;
    res.status(status).json({ error: error.message, details: error.response?.data || error.details || null });
  }
};

exports.getVideoById = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );
    const { data, error } = await supabase
      .from('videos')
      .select('id, artist_id, title, status, viral_score, viral_score_real, ai_copy_short, ai_copy_long, hashtags, platforms, post_type, ayrshare_post_id, scheduled_for, published_at, analytics_4h, source_url, processed_url, error_log, created_at, thumbnail_url')
      .eq('id', videoId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Video no encontrado' });
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getPublishStatus = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );
    const { data: video, error } = await supabase
      .from('videos')
      .select('id, status, platforms, ayrshare_post_id, published_at, error_log')
      .eq('id', videoId)
      .single();
    if (error || !video) return res.status(404).json({ error: 'Video no encontrado' });

    if (!video.ayrshare_post_id) {
      return res.status(200).json({
        video_id: videoId,
        status: video.status,
        message: 'Aún no se ha publicado este video',
        platforms: {}
      });
    }

    const uploadPostService = require('../services/uploadPostService');
    const remote = await uploadPostService.getPostStatus(video.ayrshare_post_id);

    res.status(200).json({
      video_id: videoId,
      request_id: video.ayrshare_post_id,
      status: video.status,
      published_at: video.published_at,
      platforms_requested: video.platforms || [],
      remote_status: remote,
      error_log: video.error_log
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const updateData = req.body;
    const updated = await vidalisService.updateVideoSettings(videoId, updateData);
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.retryVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const result = await vidalisService.retryVideoProcessing(videoId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.deleteVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    await vidalisService.deleteVideo(videoId);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Endpoint para que n8n actualice el status + datos de análisis IA
exports.n8nCallback = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { status, viral_score, ai_copy_short, ai_copy_long, hashtags, secret } = req.body;

    // Validación de seguridad opcional si se define WEBHOOK_SECRET
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      console.warn(`⚠️ Intento de callback no autorizado para video ${videoId}`);
      return res.status(401).json({ error: 'Unauthorized secret' });
    }

    const updates = {};
    if (status) updates.status = status;
    if (viral_score !== undefined) updates.viral_score = viral_score;
    if (ai_copy_short) updates.ai_copy_short = ai_copy_short;
    if (ai_copy_long) updates.ai_copy_long = ai_copy_long;
    if (hashtags) updates.hashtags = hashtags;

    await vidalisService.updateVideoRaw(videoId, updates);
    console.log(`✅ n8n callback: video ${videoId} → status: ${status}`);
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// --- META OAUTH CALLBACK (modo directo) ---
exports.instagramCallback = async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.status(400).json({ error: `Meta OAuth rechazado: ${oauthError}` });
    if (!code || !state) return res.status(400).json({ error: 'Faltan code o state' });

    const { artistId } = JSON.parse(Buffer.from(state, 'base64').toString());
    await instagramService.handleCallback(code, artistId, supabase);

    // Redirigir al dashboard con mensaje de éxito
    const frontendUrl = process.env.FRONTEND_URL || 'https://vidalis-frontend-production.up.railway.app';
    res.redirect(`${frontendUrl}/dashboard?instagram=connected`);
  } catch (error) {
    console.error('❌ Error Instagram callback:', error.message);
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
};

// --- CAMBIAR MODO DE PUBLICACIÓN DEL ARTISTA ---
exports.setPublishMode = async (req, res) => {
  try {
    const { artistId } = req.params;
    const { publish_mode } = req.body; // 'direct' | 'upload-post' | 'zernio'
    if (!['direct', 'upload-post', 'zernio'].includes(publish_mode)) {
      return res.status(400).json({ error: "publish_mode debe ser 'direct', 'upload-post' o 'zernio'" });
    }
    const { error } = await supabase.from('artists').update({ publish_mode }).eq('id', artistId);
    if (error) throw error;
    res.status(200).json({ artistId, publish_mode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.publishNow = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { platforms, postType, tiktokPrivacy } = req.body || {};
    const result = await vidalisService.publishVideoNow(videoId, { platforms, postType, tiktokPrivacy });
    res.status(200).json(result);
  } catch (error) {
    console.error('❌ Error en publishNow:', error.message);
    const status = error.status || error.response?.status || 400;
    res.status(status).json({
      error: error.message,
      details: error.response?.data || error.details || null
    });
  }
};

exports.getClips = async (req, res) => {
  try {
    const { parentId } = req.params;
    const clips = await vidalisService.getClipsByParent(parentId);
    res.status(200).json(clips);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.deleteArtist = async (req, res) => {
  try {
    const { artistId } = req.params;
    const result = await vidalisService.deleteArtist(artistId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /analytics-posts/:artistId
 * Devuelve métricas reales por post consultando Upload-Post y guarda snapshots en DB.
 */
exports.getPostMetrics = async (req, res) => {
  const { artistId } = req.params;
  try {
    const { data: artist, error } = await supabase
      .from('artists')
      .select('ayrshare_profile_key, active_platforms')
      .eq('id', artistId)
      .single();

    if (error || !artist) return res.status(404).json({ error: 'Artista no encontrado' });

    const { data: videos, error: vErr } = await supabase
      .from('videos')
      .select('id, title, platforms, published_at, created_at, viral_score, viral_score_real, ayrshare_post_id, source_url, processed_url, status, analytics_4h')
      .eq('artist_id', artistId)
      .in('status', ['published', 'scheduled', 'needs_review'])
      .order('created_at', { ascending: false })
      .limit(20);

    if (vErr) throw vErr;

    // Consultar métricas reales — usa analytics_4h como fuente primaria para Zernio artists
    const withMetrics = await Promise.all((videos || []).map(async (video) => {
      const cached = video.analytics_4h;
      if (cached && (cached.likes > 0 || cached.views > 0 || cached.comments > 0)) {
        return {
          ...video,
          likes: cached.likes || 0,
          comments: cached.comments || 0,
          views: cached.views || 0,
          shares: cached.shares || 0,
          saves: cached.saves || 0,
          engagement_rate: cached.engagement_rate || 0,
          metrics: cached,
        };
      }

      if (!video.ayrshare_post_id) return { ...video, metrics: null };

      const rawMetrics = await uploadPostService.getPostAnalytics(video.ayrshare_post_id);
      if (!rawMetrics) return { ...video, metrics: null };

      const platform = Array.isArray(video.platforms) ? video.platforms[0] : 'unknown';
      const normalized = await uploadPostService.saveMetricsSnapshot(
        video.id, artistId, platform, rawMetrics
      );

      return { ...video, metrics: rawMetrics, ...normalized };
    }));

    res.json({ posts: withMetrics });
  } catch (err) {
    console.error('❌ getPostMetrics:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /analytics-insights/:artistId
 * Genera insights IA con historial, guarda el resultado en analytics_insights_log.
 */
exports.getAnalyticsInsights = async (req, res) => {
  const { artistId } = req.params;
  try {
    const { data: artist, error } = await supabase
      .from('artists')
      .select('name, ayrshare_profile_key, active_platforms, publish_mode, plan_type')
      .eq('id', artistId)
      .single();

    if (error || !artist) return res.status(404).json({ error: 'Artista no encontrado' });

    const isZernio = artist.publish_mode === 'zernio';

    // ── 1. Analytics de perfil ────────────────────────────────────────────────
    let profileAnalytics = {};

    if (isZernio) {
      // Leer platform_snapshots (último snapshot por plataforma)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const { data: snapshots } = await supabase
        .from('platform_snapshots')
        .select('platform, followers, reach, impressions, likes, comments, shares, saves, views, posts_count, engagement_rate, snapshot_date')
        .eq('artist_id', artistId)
        .gte('snapshot_date', thirtyDaysAgo)
        .order('snapshot_date', { ascending: false });

      // Tomar el snapshot más reciente por plataforma
      const latestByPlatform = {};
      for (const snap of snapshots || []) {
        if (!latestByPlatform[snap.platform]) {
          latestByPlatform[snap.platform] = snap;
        }
      }
      profileAnalytics = latestByPlatform;

      // Leer datos adicionales del cache (best times, ig/yt insights)
      const { data: cacheRows } = await supabase
        .from('zernio_sync_cache')
        .select('cache_key, data, synced_at')
        .eq('artist_id', artistId);

      const cacheMap = {};
      for (const row of cacheRows || []) cacheMap[row.cache_key] = row.data;

      if (cacheMap.best_posting_times) profileAnalytics._best_times = cacheMap.best_posting_times;
      if (cacheMap.instagram_insights) profileAnalytics._ig_insights = cacheMap.instagram_insights;
      if (cacheMap.youtube_insights) profileAnalytics._yt_insights = cacheMap.youtube_insights;
    } else {
      // Upload-Post flow original
      if (artist.ayrshare_profile_key && artist.active_platforms?.length) {
        try {
          profileAnalytics = await uploadPostService.getAnalytics(
            artist.ayrshare_profile_key,
            artist.active_platforms
          );
        } catch (e) {
          console.warn('⚠️ No se pudieron obtener analytics de perfil:', e.message);
        }
      }
    }

    // ── 2. Últimos posts con métricas ─────────────────────────────────────────
    const { data: videos } = await supabase
      .from('videos')
      .select('id, title, platforms, published_at, created_at, viral_score, viral_score_real, ayrshare_post_id, status, analytics_4h')
      .eq('artist_id', artistId)
      .order('created_at', { ascending: false })
      .limit(15);

    const postsWithMetrics = await Promise.all((videos || []).map(async (video) => {
      const cached = video.analytics_4h;
      if (cached && (cached.likes > 0 || cached.views > 0)) {
        return {
          ...video,
          likes: cached.likes || 0,
          comments: cached.comments || 0,
          views: cached.views || 0,
          shares: cached.shares || 0,
          saves: cached.saves || 0,
          engagement_rate: cached.engagement_rate || 0,
        };
      }

      if (!video.ayrshare_post_id || isZernio) {
        return { ...video, likes: 0, comments: 0, views: 0, shares: 0, engagement_rate: 0 };
      }

      const rawMetrics = await uploadPostService.getPostAnalytics(video.ayrshare_post_id);
      if (!rawMetrics) return { ...video, likes: 0, comments: 0, views: 0, shares: 0, engagement_rate: 0 };

      const platform = Array.isArray(video.platforms) ? video.platforms[0] : 'unknown';
      const normalized = await uploadPostService.saveMetricsSnapshot(video.id, artistId, platform, rawMetrics);
      return { ...video, ...normalized };
    }));

    // ── 3. Historial de análisis anteriores ───────────────────────────────────
    const { data: prevInsights } = await supabase
      .from('analytics_insights_log')
      .select('generated_at, insights, decisions, engagement_rate, followers_total, best_platform')
      .eq('artist_id', artistId)
      .order('generated_at', { ascending: false })
      .limit(3);

    // ── 4. Generar insights con Claude ────────────────────────────────────────
    const insights = await generateInsights(
      profileAnalytics,
      postsWithMetrics,
      artist.name,
      prevInsights || []
    );

    // ── 5. Guardar log para comparaciones futuras ─────────────────────────────
    const followersTotal = isZernio
      ? Object.values(profileAnalytics).reduce((acc, p) => acc + (p?.followers || 0), 0)
      : Object.values(profileAnalytics || {}).reduce((acc, p) => acc + (p?.followers || 0), 0);
    const totalReach = isZernio
      ? Object.values(profileAnalytics).reduce((acc, p) => acc + (p?.reach || 0), 0)
      : Object.values(profileAnalytics || {}).reduce((acc, p) => acc + (p?.reach || 0), 0);

    await supabase.from('analytics_insights_log').insert({
      artist_id: artistId,
      insights: insights.insights || [],
      decisions: insights.decisions || [],
      best_platform: insights.best_platform || null,
      best_post_title: insights.best_post_title || null,
      engagement_rate: insights.engagement_rate || 0,
      followers_total: followersTotal,
      total_reach: totalReach,
      profile_data: profileAnalytics
    }).then(() => {}).catch(e => console.warn('⚠️ analytics_insights_log:', e.message));

    // ── 6. Uso mensual ────────────────────────────────────────────────────────
    const firstDayOfMonth = new Date();
    firstDayOfMonth.setDate(1);
    firstDayOfMonth.setHours(0, 0, 0, 0);

    const { count: usageCount } = await supabase
      .from('videos')
      .select('id', { count: 'exact', head: true })
      .eq('artist_id', artistId)
      .gte('created_at', firstDayOfMonth.toISOString());

    const planType = (artist.plan_type || 'Mini').trim();
    const PLAN_CONFIG = {
      'Mini': { videos: 5 },
      'Artista': { videos: 20 },
      'Estrella': { videos: 60 },
      'Agencia Pro': { videos: Infinity },
    };
    const config = PLAN_CONFIG[planType] || PLAN_CONFIG['Mini'];

    res.json({
      ...insights,
      profile: profileAnalytics,
      posts: postsWithMetrics,
      monthly_usage: usageCount || 0,
      monthly_limit: config.videos === Infinity ? 9999 : config.videos,
      plan_name: planType,
      data_source: isZernio ? 'zernio_supabase' : 'upload_post',
    });
  } catch (err) {
    console.error('❌ getAnalyticsInsights:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /artists/:artistId/sync-analytics
 * Dispara la sincronización de analytics Zernio → Supabase para un artista.
 * Llamado por el botón "Sincronizar" del dashboard.
 */
exports.syncZernioAnalytics = async (req, res) => {
  const { artistId } = req.params;
  try {
    const result = await syncArtistAnalytics(artistId);
    if (!result.ok && result.reason === 'artist_not_found') {
      return res.status(404).json({ error: 'Artista no encontrado' });
    }
    if (!result.ok && result.reason === 'not_zernio_artist') {
      return res.status(400).json({ error: 'Este artista no usa Zernio como modo de publicación' });
    }
    res.status(200).json(result);
  } catch (err) {
    console.error('❌ syncZernioAnalytics:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.syncSocialAccounts = async (req, res) => {
  const { artistId } = req.params;
  try {
    // 1. Obtener el artista
    const { data: artist, error: artistError } = await supabase
      .from('artists')
      .select('id, name, ayrshare_profile_key, active_platforms, social_keys, publish_mode, facebook_page_id')
      .eq('id', artistId)
      .single();

    if (artistError || !artist) {
      return res.status(404).json({ error: 'Artista no encontrado' });
    }

    // Artistas Zernio no usan Upload-Post — sus cuentas se sincronizan via sync-analytics
    if (artist.publish_mode === 'zernio') {
      return res.json({
        success: true,
        active_platforms: artist.active_platforms || [],
        social_keys: artist.social_keys || {},
        note: 'Artista Zernio — usa /sync-analytics para sincronizar métricas'
      });
    }

    const profileKey = artist.ayrshare_profile_key;
    if (!profileKey) {
      return res.status(400).json({ error: 'El artista no tiene un perfil vinculado (ayrshare_profile_key está vacío)' });
    }

    console.log(`🔄 Sincronizando plataformas para: ${artist.name} (${profileKey})`);

    let activePlatforms = [];
    let socialKeys = {};

    // 2. Consultar Upload-Post
    const profileData = await uploadPostService.getProfile(profileKey);

    if (profileData.success && profileData.profile.social_accounts) {
      const accounts = profileData.profile.social_accounts;
      Object.keys(accounts).forEach(platform => {
        const acc = accounts[platform];
        // Upload-Post devuelve un objeto o un string no vacío si está conectado
        if (acc && (typeof acc === 'object' || (typeof acc === 'string' && acc.trim() !== ''))) {
          activePlatforms.push(platform);
          socialKeys[platform] = 'linked';
        }
      });
    }

    console.log(`📡 Plataformas detectadas: ${activePlatforms.join(', ')}`);

    // 3. Actualizar la base de datos (con lógica resiliente por si falta la columna)
    const updatePayload = {
      social_keys: socialKeys
    };

    // Solo incluimos active_platforms si sabemos que la columna existe o confiamos en la migración
    updatePayload.active_platforms = activePlatforms;

    const { error: updateError } = await supabase
      .from('artists')
      .update(updatePayload)
      .eq('id', artistId);

    if (updateError) {
      console.warn("⚠️ Error parcial al actualizar DB (posiblemente falta la columna active_platforms):", updateError.message);
    }

    res.json({
      success: true,
      active_platforms: activePlatforms,
      social_keys: socialKeys
    });
  } catch (error) {
    console.error('❌ Error en syncSocialAccounts:', error.message);
    res.status(500).json({ error: error.message });
  }
};
/**
 * PATCH /profile
 * Actualiza nombre, bio, handle y avatar_url.
 * Todos los tipos (agency, individual, artist) viven en la tabla agencies.
 * Para cuentas individual/artist también sincroniza el name al registro de artists.
 */
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const accountType = req.user?.account_type;
    if (!userId) return res.status(401).json({ error: 'No autorizado' });

    const allowed = ['name', 'bio', 'handle', 'avatar_url'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('agencies')
      .update(updates)
      .eq('id', userId)
      .select('id, name, bio, handle, avatar_url, email, account_type')
      .single();

    if (error) throw error;

    // Para cuentas individuales/artist sincronizar el nombre al perfil de artista
    const resolvedType = accountType || data.account_type;
    if (updates.name && (resolvedType === 'individual' || resolvedType === 'artist')) {
      await supabase
        .from('artists')
        .update({ name: updates.name })
        .eq('agency_id', userId);
    }

    res.status(200).json({ ok: true, user: data });
  } catch (err) {
    console.error('❌ updateProfile:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.updateArtistStyle = async (req, res) => {
  try {
    const { artistId } = req.params;
    const { creative_dna } = req.body;
    const result = await vidalisService.updateArtistStyle(artistId, creative_dna);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.uploadFromUrl = async (req, res) => {
  try {
    const { artist_id, remote_url, title } = req.body;
    if (!artist_id || !remote_url) {
      return res.status(400).json({ error: 'artist_id y remote_url son requeridos' });
    }
    const video = await vidalisService.uploadFromUrl(
      artist_id,
      remote_url,
      title,
      req.user.id
    );
    res.status(201).json(video);
  } catch (error) {
    console.error('uploadFromUrl error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

exports.runDeepAudit = async (req, res) => {
  const { artistId } = req.params;
  const { allow_full_audit } = req.body;
  
  try {
    const result = await vidalisService.runArtistDeepAudit(artistId, allow_full_audit);
    res.json(result);
  } catch (err) {
    console.error('❌ runDeepAudit Controller:', err.message);
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
};

// --- PROGRAMAR VIDEO (Calendario) ---
exports.scheduleVideo = async (req, res) => {
  const { videoId } = req.params;
  const { scheduled_at, platforms, format } = req.body;

  try {
    if (!scheduled_at) {
      return res.status(400).json({ error: 'Se requiere scheduled_at' });
    }

    const scheduledDate = new Date(scheduled_at);
    if (isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ error: 'Fecha de programación inválida' });
    }

    const { data, error } = await supabase
      .from('videos')
      .update({
        scheduled_at: scheduledDate.toISOString(),
        platforms: platforms || [],
        format: format || 'Reel',
        status: 'scheduled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', videoId)
      .select()
      .single();

    if (error) throw new Error(error.message);

    console.log(`📅 Video ${videoId} programado para ${scheduledDate.toISOString()}`);
    res.status(200).json({ success: true, video: data });
  } catch (err) {
    console.error('❌ scheduleVideo:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Growth Pro ────────────────────────────────────────────────────────────────

exports.getGrowthInsights = async (req, res) => {
  try {
    const { artistId } = req.params;
    const insights = await growthService.getInsights(artistId);
    res.status(200).json(insights);
  } catch (err) {
    console.error('❌ getGrowthInsights:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getGrowthBestTime = async (req, res) => {
  try {
    const { artistId } = req.params;
    const data = await growthService.getBestTime(artistId);
    res.status(200).json(data);
  } catch (err) {
    console.error('❌ getGrowthBestTime:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getGrowthStrategy = async (req, res) => {
  try {
    const { artistId } = req.params;
    const data = await growthService.getContentStrategy(artistId);
    res.status(200).json(data);
  } catch (err) {
    console.error('❌ getGrowthStrategy:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getViralHistory = async (req, res) => {
  try {
    const { artistId } = req.params;
    const data = await growthService.getViralHistory(artistId);
    res.status(200).json(data);
  } catch (err) {
    console.error('❌ getViralHistory:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.generateABVariants = async (req, res) => {
  try {
    const { videoId } = req.params;
    const data = await growthService.generateABVariants(videoId);
    res.status(200).json(data);
  } catch (err) {
    console.error('❌ generateABVariants:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.getABResult = async (req, res) => {
  try {
    const { videoId } = req.params;
    const data = await growthService.getABResult(videoId);
    res.status(200).json(data);
  } catch (err) {
    console.error('❌ getABResult:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.generateAdCopy = async (req, res) => {
  try {
    const { videoId } = req.params;
    const data = await growthService.generateAdCopy(videoId);
    res.status(200).json(data);
  } catch (err) {
    console.error('❌ generateAdCopy:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ================================================================
// ZERNIO: Comentarios & Inbox
// ================================================================

exports.getArtistComments = async (req, res) => {
  try {
    const { artistId } = req.params;
    const { data: artist } = await supabase
      .from('artists')
      .select('ayrshare_profile_key')
      .eq('id', artistId)
      .single();
    if (!artist?.ayrshare_profile_key) {
      return res.status(400).json({ error: 'El artista no tiene perfil de Zernio conectado' });
    }
    const { limit, cursor, platform } = req.query;
    const result = await zernioService.getProfileComments(
      artist.ayrshare_profile_key,
      parseInt(limit) || 20,
      cursor || null,
      platform || null
    );
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getPostComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const { accountId, limit, cursor } = req.query;
    if (!accountId) return res.status(400).json({ error: 'Se requiere accountId' });
    const result = await zernioService.getPostComments(
      postId, accountId, parseInt(limit) || 50, cursor || null
    );
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.replyToComment = async (req, res) => {
  try {
    const { postId } = req.params;
    const { accountId, message, commentId, isPrivate, buttons, quickReplies } = req.body;
    if (!accountId || !message) {
      return res.status(400).json({ error: 'Se requiere accountId y message' });
    }
    let result;
    if (isPrivate) {
      result = await zernioService.sendPrivateReply(postId, commentId, accountId, message, buttons, quickReplies);
    } else {
      result = await zernioService.postCommentReply(postId, accountId, message, commentId);
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.hideCommentToggle = async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const { accountId, hide } = req.body;
    if (!accountId) return res.status(400).json({ error: 'Se requiere accountId' });
    const result = await zernioService.hideComment(postId, commentId, accountId, hide !== false);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.likeCommentToggle = async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const { accountId, like, cid } = req.body;
    if (!accountId) return res.status(400).json({ error: 'Se requiere accountId' });
    const result = await zernioService.likeComment(postId, commentId, accountId, like !== false, cid || null);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.deleteComment = async (req, res) => {
  try {
    const { postId } = req.params;
    const { accountId, commentId } = req.query;
    if (!accountId || !commentId) {
      return res.status(400).json({ error: 'Se requiere accountId y commentId' });
    }
    const result = await zernioService.deleteComment(postId, commentId, accountId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ================================================================
// ZERNIO: Automatizaciones Comment-to-DM
// ================================================================

exports.getAutomations = async (req, res) => {
  try {
    const { artistId } = req.params;
    const { data: artist } = await supabase
      .from('artists')
      .select('ayrshare_profile_key')
      .eq('id', artistId)
      .single();
    if (!artist?.ayrshare_profile_key) {
      return res.status(400).json({ error: 'El artista no tiene perfil de Zernio conectado' });
    }
    const result = await zernioService.listCommentAutomations(artist.ayrshare_profile_key);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createAutomation = async (req, res) => {
  try {
    const { artistId } = req.params;
    const { accountId, ...autoData } = req.body;
    if (!accountId) return res.status(400).json({ error: 'Se requiere accountId' });
    const { data: artist } = await supabase
      .from('artists')
      .select('ayrshare_profile_key')
      .eq('id', artistId)
      .single();
    if (!artist?.ayrshare_profile_key) {
      return res.status(400).json({ error: 'El artista no tiene perfil de Zernio conectado' });
    }
    const result = await zernioService.createCommentAutomation(artist.ayrshare_profile_key, accountId, autoData);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getAutomationDetails = async (req, res) => {
  try {
    const { automationId } = req.params;
    const result = await zernioService.getCommentAutomationDetails(automationId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateAutomation = async (req, res) => {
  try {
    const { automationId } = req.params;
    const result = await zernioService.updateCommentAutomation(automationId, req.body);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.deleteAutomation = async (req, res) => {
  try {
    const { automationId } = req.params;
    const result = await zernioService.deleteCommentAutomation(automationId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ================================================================
// ZERNIO: Webhook Receptor
// ================================================================

exports.zernioWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-zernio-signature'];
    const secret = process.env.ZERNIO_WEBHOOK_SECRET;

    if (secret && signature) {
      const rawBody = req.rawBody || JSON.stringify(req.body);
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
      const receivedSig = signature.startsWith('sha256=') ? signature.slice(7) : signature;

      if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(receivedSig))) {
        return res.status(401).json({ error: 'Firma de webhook inválida' });
      }
    }

    const event = req.body;
    const eventType = event.event || event.type;

    if (eventType === 'post.published') {
      const postId = event.post?._id || event._id || event.id;
      const platformPostUrl = event.platformPostUrl || event.post?.url || null;

      if (postId) {
        await supabase
          .from('videos')
          .update({
            status: 'published',
            published_at: new Date().toISOString(),
            ...(platformPostUrl ? { platform_post_url: platformPostUrl } : {}),
          })
          .eq('ayrshare_post_id', postId);
      }
    } else if (eventType === 'post.failed') {
      const postId = event.post?._id || event._id || event.id;
      const errorMsg = event.error || event.message || 'Error desconocido en publicación Zernio';

      if (postId) {
        await supabase
          .from('videos')
          .update({ status: 'failed', error_log: errorMsg })
          .eq('ayrshare_post_id', postId);
      }
    } else if (eventType === 'post.scheduled') {
      const postId = event.post?._id || event._id || event.id;

      if (postId) {
        await supabase
          .from('videos')
          .update({ status: 'scheduled' })
          .eq('ayrshare_post_id', postId);
      }
    } else if (eventType === 'post.cancelled') {
      const postId = event.post?._id || event._id || event.id;

      if (postId) {
        await supabase
          .from('videos')
          .update({ status: 'cancelled' })
          .eq('ayrshare_post_id', postId);
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ zernioWebhook:', error.message);
    res.status(200).json({ received: true });
  }
};


