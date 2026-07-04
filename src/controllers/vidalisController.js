const crypto = require('crypto');
const vidalisService = require('../services/vidalisService');
const cloudinaryService = require('../services/cloudinaryService');
const instagramService = require('../services/instagramService');
const uploadPostService = require('../services/uploadPostService');
const zernioService = require('../services/zernioService');
const { syncArtistAnalytics } = require('../jobs/syncZernioAnalytics');
const { takeGrowthSnapshotForArtist } = require('../jobs/dailyIdeas');
const { generateInsights } = require('../services/aiService');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);
const aiService = require('../services/aiService');
const growthService = require('../services/growthService');
const ideaBankService = require('../services/ideaBankService');
const trendService = require('../services/trendService');
const tiktokScraper = require('../services/tiktokScraper');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

async function verifyArtistOwnership(artistId, agencyId) {
  const { data } = await supabaseAdmin
    .from('artists')
    .select('agency_id')
    .eq('id', artistId)
    .single();
  return data && data.agency_id === agencyId;
}

// --- SPARKS BILLING HELPER ---
async function deductSparks(userId, cost, action) {
  const { data: artistRow } = await supabase
    .from('artists')
    .select('agencies(id, sparks_balance)')
    .eq('agency_id', userId)
    .limit(1)
    .single();

  let agencyId = artistRow?.agencies?.id;
  let balance = artistRow?.agencies?.sparks_balance ?? 0;

  if (!agencyId) {
    const { data: agency } = await supabase
      .from('agencies')
      .select('id, sparks_balance')
      .eq('id', userId)
      .single();
    if (agency) { agencyId = agency.id; balance = agency.sparks_balance ?? 0; }
  }

  if (!agencyId) return { ok: false, error: 'No se encontró cuenta', balance: 0 };
  if (balance < cost) return { ok: false, error: `Sparks insuficientes. Necesitas ${cost} Sparks (tienes ${balance}).`, balance, required: cost };

  await supabase.from('agencies').update({ sparks_balance: balance - cost }).eq('id', agencyId);

  try {
    await supabase.from('sparks_transactions').insert([{
      agency_id: agencyId,
      amount: -cost,
      action,
      created_at: new Date().toISOString(),
    }]);
  } catch (_) { }

  return { ok: true, balance: balance - cost, agencyId };
}

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

// --- ANALIZAR ESTRATEGIA DE CONTENIDO (10 Sparks) ---
exports.analyzeContentStrategy = async (req, res) => {
  try {
    const { script, tone, platform, artist_id } = req.body;
    if (!script?.trim()) return res.status(400).json({ error: 'Se requiere el script o URL del contenido' });

    const userId = req.user?.id || req.user?.userId;
    const sparksResult = await deductSparks(userId, 10, 'analyze_content');
    if (!sparksResult.ok) return res.status(402).json({ error: sparksResult.error, required: sparksResult.required, current: sparksResult.balance });

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

// --- ME (saldo y perfil básico) ---
exports.getMe = async (req, res) => {
  try {
    const { data: agency } = await supabase
      .from('agencies')
      .select('id, name, email, plan_type, sparks_balance')
      .eq('id', req.user.id)
      .single();

    if (!agency) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({
      id: agency.id,
      name: agency.name,
      email: agency.email,
      plan: agency.plan_type,
      sparks_balance: agency.sparks_balance || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    console.log(error);
    console.log(data);
    if (error || !data) return res.status(404).json({ error: 'Video no encontrado methid: getVideoById' });
    res.status(200).json(data);
  } catch (error) {
    console.log(error);
    console.log(data);
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
    if (error || !video) return res.status(404).json({ error: 'Video no encontrado methid: getPublishStatus' });

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

exports.checkHashtags = async (req, res) => {
  try {
    const { checkHashtags } = require('../config/bannedHashtags');
    const { hashtags } = req.body;
    if (!hashtags) return res.status(400).json({ error: 'Se requiere el campo hashtags' });
    const result = checkHashtags(hashtags);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    const userId = req.user?.id || req.user?.userId;
    const sparksResult = await deductSparks(userId, 15, 'analytics_insights');
    if (!sparksResult.ok) return res.status(402).json({ error: sparksResult.error, required: sparksResult.required, current: sparksResult.balance });
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
    }).then(() => { }).catch(e => console.warn('⚠️ analytics_insights_log:', e.message));

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

    // Growth snapshot after successful sync
    if (result.ok) {
      try {
        await takeGrowthSnapshotForArtist(artistId);
        result.growthSnapshotUpdated = true;
      } catch (snapErr) {
        console.warn('⚠️ Growth snapshot failed after sync:', snapErr.message);
      }
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
      .update({ ...updates, onboarding_completed: true })
      .eq('id', userId)
      .select('id, name, bio, handle, avatar_url, email, account_type, onboarding_completed')
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

exports.completeTour = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'No autorizado' });

    const { error } = await supabase
      .from('agencies')
      .update({ tour_completed: true })
      .eq('id', userId);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ completeTour:', err.message);
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
    const userId = req.user?.id || req.user?.userId;
    const { videoId } = req.params;
    console.log(`[generateABVariants] userId=${userId} videoId=${videoId}`);

    const sparksResult = await deductSparks(userId, 10, 'ab_variants');
    console.log(`[generateABVariants] deductSparks → ok=${sparksResult.ok} balance=${sparksResult.balance}`);
    if (!sparksResult.ok) {
      console.warn(`[generateABVariants] Sparks insuficientes: balance=${sparksResult.balance} required=10`);
      return res.status(402).json({ error: sparksResult.error, required: sparksResult.required, current: sparksResult.balance });
    }

    const data = await growthService.generateABVariants(videoId);
    console.log(`[generateABVariants] OK variants=${data?.variants?.length}`);
    res.status(200).json(data);
  } catch (err) {
    console.error('❌ generateABVariants:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
};

exports.getABResult = async (req, res) => {
  try {
    const { videoId } = req.params;
    console.log(`[getABResult] videoId=${videoId}`);
    const data = await growthService.getABResult(videoId);
    console.log(`[getABResult] OK is_complete=${data?.is_complete} variants=${data?.variants?.length}`);
    res.status(200).json(data);
  } catch (err) {
    console.warn(`[getABResult] No result → ${err.message}`);
    res.status(500).json({ error: err.message });
  }
};

exports.generateAdCopy = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const { videoId } = req.params;
    console.log(`[generateAdCopy] userId=${userId} videoId=${videoId}`);

    const sparksResult = await deductSparks(userId, 10, 'ad_copy');
    console.log(`[generateAdCopy] deductSparks → ok=${sparksResult.ok} balance=${sparksResult.balance}`);
    if (!sparksResult.ok) {
      console.warn(`[generateAdCopy] Sparks insuficientes: balance=${sparksResult.balance} required=10`);
      return res.status(402).json({ error: sparksResult.error, required: sparksResult.required, current: sparksResult.balance });
    }

    const data = await growthService.generateAdCopy(videoId);
    console.log(`[generateAdCopy] OK plataformas=${data?.length}`);
    res.status(200).json(data);
  } catch (err) {
    console.error('❌ generateAdCopy:', err.message, err.stack);
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
      .select('ayrshare_profile_key, publish_mode, active_platforms, social_keys')
      .eq('id', artistId)
      .single();
    if (!artist?.ayrshare_profile_key) {
      return res.status(400).json({ error: 'El artista no tiene perfil de Zernio conectado' });
    }
    const profileKey = artist.ayrshare_profile_key;
    const { limit, cursor, platform } = req.query;

    let accounts = [];
    try {
      accounts = await zernioService.getActivePlatforms(profileKey);
    } catch (accErr) {
      console.log('📥 [Inbox] Error checking accounts:', accErr.message);
    }

    const result = await zernioService.getProfileComments(
      profileKey,
      parseInt(limit) || 20,
      cursor || null,
      platform || null
    );
    const meta = result?.meta || {};
    const comments = result?.posts || result?.comments || result?.data || (Array.isArray(result) ? result : []);
    const parsed = Array.isArray(comments) ? comments : [];

    if (parsed.length === 0 && meta.accountsQueried === 0 && accounts.length > 0) {
      const platformNames = accounts.map(a => a.platform);
      const unsupported = platformNames.filter(p => !['instagram', 'facebook'].includes(p));
      console.log('📥 [Inbox] accountsQueried=0 but accounts exist:', platformNames.join(', '));
      return res.status(200).json({
        comments: [],
        pagination: null,
        notice: unsupported.length === platformNames.length
          ? `Las plataformas conectadas (${platformNames.join(', ')}) no soportan lectura de comentarios por API. Conecta Instagram o Facebook para usar el Inbox.`
          : null,
        connectedPlatforms: platformNames,
      });
    }

    res.status(200).json({
      comments: parsed,
      pagination: result?.pagination || result?.nextCursor ? { cursor: result.nextCursor } : null,
    });
  } catch (error) {
    console.error('❌ [Inbox] getArtistComments error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

exports.getPostComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const { accountId, artistId, limit, cursor } = req.query;
    let resolvedAccountId = accountId;
    if (!resolvedAccountId && artistId) {
      const { data: artist } = await supabase
        .from('artists')
        .select('ayrshare_profile_key')
        .eq('id', artistId)
        .single();
      resolvedAccountId = artist?.ayrshare_profile_key;
    }
    if (!resolvedAccountId) return res.status(400).json({ error: 'Se requiere accountId o artistId' });
    const result = await zernioService.getPostComments(
      postId, resolvedAccountId, parseInt(limit) || 50, cursor || null
    );
    console.log('📥 [Inbox] Post comments raw keys:', result ? Object.keys(result) : 'null');
    const comments = result?.comments || result?.data || (Array.isArray(result) ? result : []);
    res.status(200).json({
      comments: Array.isArray(comments) ? comments : [],
      pagination: result?.pagination || null,
    });
  } catch (error) {
    console.error('❌ [Inbox] getPostComments error:', error.message);
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

// ══════════════════════════════════════════════════════════════
// IDEABANK
// ══════════════════════════════════════════════════════════════

exports.getIdeas = async (req, res) => {
  try {
    const ideas = await ideaBankService.getTodayIdeas(req.params.artistId);
    res.json(ideas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.generateIdeas = async (req, res) => {
  try {
    const artistId = req.params.artistId;
    const count = req.body.count || 5;
    const SPARK_COST = 5;

    const { data: agencyData } = await supabase
      .from('artists')
      .select('agencies(id, sparks_balance)')
      .eq('id', artistId)
      .single();

    const agencyId = agencyData?.agencies?.id;
    const balance = agencyData?.agencies?.sparks_balance ?? 0;

    if (balance < SPARK_COST) {
      return res.status(402).json({
        error: `No tienes suficientes Sparks. Necesitas ${SPARK_COST} Sparks para generar ideas. Tu saldo actual: ${balance}.`,
        code: 'INSUFFICIENT_SPARKS',
        required: SPARK_COST,
        balance
      });
    }

    const { data: deductOk } = await supabase.rpc('deduct_sparks', {
      target_agency_id: agencyId,
      cost: SPARK_COST
    });

    if (!deductOk) {
      return res.status(402).json({
        error: 'Error al descontar Sparks. Intenta de nuevo.',
        code: 'DEDUCT_FAILED'
      });
    }

    const ideas = await ideaBankService.generateDailyIdeas(artistId, count);

    await supabase.from('sparks_transactions').insert([{
      agency_id: agencyId,
      amount: -SPARK_COST,
      type: 'idea_generation',
      description: `Generación de ${count} ideas IA`
    }]);

    res.json({ ideas, sparksUsed: SPARK_COST, newBalance: balance - SPARK_COST });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.swipeIdea = async (req, res) => {
  try {
    const { action, artistId } = req.body;
    if (!artistId) return res.status(400).json({ error: 'artistId requerido' });
    const ownerOk = await verifyArtistOwnership(artistId, req.user.id);
    if (!ownerOk) return res.status(403).json({ error: 'No tienes permiso para este artista' });
    if (!['like', 'dislike', 'save'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const result = await ideaBankService.swipeIdea(req.params.ideaId, artistId, action);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.rateIdea = async (req, res) => {
  try {
    const { rating, artistId } = req.body;
    if (!artistId) return res.status(400).json({ error: 'artistId requerido' });
    const ownerOk = await verifyArtistOwnership(artistId, req.user.id);
    if (!ownerOk) return res.status(403).json({ error: 'No tienes permiso para este artista' });
    const result = await ideaBankService.rateIdea(req.params.ideaId, artistId, rating);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getSavedIdeas = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const result = await ideaBankService.getSavedIdeas(req.params.artistId, page);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.expandIdea = async (req, res) => {
  try {
    const artistId = req.body.artistId || req.query.artistId;
    if (!artistId) return res.status(400).json({ error: 'artistId requerido' });
    const ownerOk = await verifyArtistOwnership(artistId, req.user.id);
    if (!ownerOk) return res.status(403).json({ error: 'No tienes permiso para este artista' });

    const sparksResult = await deductSparks(req.user.id, 5, 'expand_idea');
    if (!sparksResult.ok) return res.status(402).json({ error: sparksResult.error, required: sparksResult.required, current: sparksResult.balance });

    const result = await ideaBankService.expandToScript(req.params.ideaId, artistId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getStyleProfile = async (req, res) => {
  try {
    const profile = await ideaBankService.getStyleProfile(req.params.artistId);
    res.json(profile || { message: 'No profile yet' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.analyzeStyle = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const sparksResult = await deductSparks(userId, 10, 'analyze_style');
    if (!sparksResult.ok) return res.status(402).json({ error: sparksResult.error, required: sparksResult.required, current: sparksResult.balance });

    const result = await ideaBankService.analyzeArtistStyle(req.params.artistId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// TRENDS
// ══════════════════════════════════════════════════════════════

exports.getTrends = async (req, res) => {
  try {
    const trends = await trendService.fetchAllTrends(req.params.artistId);
    res.json(trends);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getTrendReferences = async (req, res) => {
  try {
    const refs = await trendService.getTrendReferences(req.params.artistId);
    res.json(refs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.addTrendReference = async (req, res) => {
  try {
    const { type, value, platform } = req.body;
    const ref = await trendService.addTrendReference(req.params.artistId, type, value, platform);
    res.json(ref);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.removeTrendReference = async (req, res) => {
  try {
    const artistId = req.user.artistId;
    if (!artistId) return res.status(401).json({ error: 'Unauthorized' });
    await trendService.removeTrendReference(req.params.refId, artistId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════════════

exports.getNotifications = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('artist_id', req.params.artistId)
      .order('created_at', { ascending: false })
      .limit(limit);
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.markNotificationRead = async (req, res) => {
  try {
    const artistId = req.user.artistId;
    if (!artistId) return res.status(401).json({ error: 'Unauthorized' });
    const { count } = await supabase.from('notifications').update({ is_read: true }).eq('id', req.params.notifId).eq('artist_id', artistId);
    if (!count) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.markAllNotificationsRead = async (req, res) => {
  try {
    await supabase.from('notifications').update({ is_read: true }).eq('artist_id', req.params.artistId).eq('is_read', false);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// GROWTH HISTORY
// ══════════════════════════════════════════════════════════════

exports.getGrowthHistory = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data } = await supabase
      .from('growth_snapshots')
      .select('*')
      .eq('artist_id', req.params.artistId)
      .gte('snapshot_date', since.toISOString().split('T')[0])
      .order('snapshot_date', { ascending: true });

    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// MEDIA KIT
// ══════════════════════════════════════════════════════════════

exports.getMediaKit = async (req, res) => {
  try {
    const { data } = await supabase.from('media_kit').select('*').eq('artist_id', req.params.artistId).single();
    res.json(data || { exists: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.updateMediaKit = async (req, res) => {
  try {
    const artistId = req.params.artistId;
    const updates = req.body;
    updates.artist_id = artistId;

    if (!updates.slug) {
      updates.slug = (updates.display_name || artistId).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    }

    const { data } = await supabase
      .from('media_kit')
      .upsert(updates, { onConflict: 'artist_id' })
      .select()
      .single();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getPublicMediaKit = async (req, res) => {
  try {
    const { data: kit } = await supabase
      .from('media_kit')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('is_public', true)
      .single();

    if (!kit) return res.status(404).json({ error: 'Media kit not found' });

    // Attach live stats
    const { data: artist } = await supabase
      .from('artists')
      .select('name, genre, social_keys, active_platforms')
      .eq('id', kit.artist_id)
      .single();

    const { data: snapshots } = await supabase
      .from('growth_snapshots')
      .select('platform, followers, total_views, engagement_rate')
      .eq('artist_id', kit.artist_id)
      .order('snapshot_date', { ascending: false })
      .limit(5);

    res.json({
      ...kit,
      artist_name: artist?.name,
      genre: artist?.genre,
      platforms: artist?.active_platforms || [],
      stats: snapshots || [],
      social_keys: undefined
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// COLLABORATIONS
// ══════════════════════════════════════════════════════════════

exports.getCollaborations = async (req, res) => {
  try {
    const status = req.query.status;
    let query = supabase.from('collaborations').select('*').eq('artist_id', req.params.artistId).order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data } = await query;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.createCollaboration = async (req, res) => {
  try {
    const collab = { ...req.body, artist_id: req.params.artistId };
    const { data, error } = await supabase.from('collaborations').insert(collab).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.updateCollaboration = async (req, res) => {
  try {
    const artistId = req.user.artistId;
    if (!artistId) return res.status(401).json({ error: 'Unauthorized' });
    const allowed = ['brand_name', 'brand_logo', 'brand_contact', 'brand_email', 'amount', 'currency', 'status', 'platform', 'deliverables', 'start_date', 'end_date', 'notes'];
    const updates = {};
    for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
    const { data } = await supabase
      .from('collaborations')
      .update(updates)
      .eq('id', req.params.collabId)
      .eq('artist_id', artistId)
      .select()
      .single();
    if (!data) return res.status(404).json({ error: 'Collaboration not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.deleteCollaboration = async (req, res) => {
  try {
    const artistId = req.user.artistId;
    if (!artistId) return res.status(401).json({ error: 'Unauthorized' });
    const { count } = await supabase.from('collaborations').delete().eq('id', req.params.collabId).eq('artist_id', artistId);
    if (!count) return res.status(404).json({ error: 'Collaboration not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getCollabStats = async (req, res) => {
  try {
    const { data: collabs } = await supabase
      .from('collaborations')
      .select('amount, currency, status')
      .eq('artist_id', req.params.artistId);

    const stats = {
      total: (collabs || []).length,
      total_earned: 0,
      pending_payment: 0,
      active: 0,
      by_status: {}
    };

    for (const c of (collabs || [])) {
      stats.by_status[c.status] = (stats.by_status[c.status] || 0) + 1;
      if (c.status === 'paid') stats.total_earned += parseFloat(c.amount || 0);
      if (c.status === 'delivered') stats.pending_payment += parseFloat(c.amount || 0);
      if (['confirmed', 'in_progress'].includes(c.status)) stats.active++;
    }

    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// RATE CALCULATOR
// ══════════════════════════════════════════════════════════════

exports.calculateRates = async (req, res) => {
  try {
    const artistId = req.params.artistId;

    // Sync followers from Zernio if artist has a connected profile
    const { data: artist } = await supabaseAdmin
      .from('artists')
      .select('ayrshare_profile_key, publish_mode')
      .eq('id', artistId)
      .single();

    if (artist?.ayrshare_profile_key && artist.publish_mode === 'zernio') {
      try {
        const accounts = await zernioService.getActivePlatforms(artist.ayrshare_profile_key);
        const today = new Date().toISOString().split('T')[0];
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        let platformViews = {};
        let platformEngagement = {};
        try {
          const daily = await zernioService.getDailyMetrics(artist.ayrshare_profile_key, thirtyDaysAgo, today);
          if (daily?.dailyData) {
            for (const day of daily.dailyData) {
              if (day.platformMetrics) {
                for (const [plat, metrics] of Object.entries(day.platformMetrics)) {
                  if (!platformViews[plat]) platformViews[plat] = 0;
                  if (!platformEngagement[plat]) platformEngagement[plat] = { likes: 0, comments: 0, shares: 0, views: 0 };
                  platformViews[plat] += metrics.views || 0;
                  platformEngagement[plat].likes += metrics.likes || 0;
                  platformEngagement[plat].comments += metrics.comments || 0;
                  platformEngagement[plat].shares += metrics.shares || 0;
                  platformEngagement[plat].views += metrics.views || 0;
                }
              }
            }
          }
        } catch (metricsErr) {
          console.log('⚠️ [Rates] Zernio daily metrics failed:', metricsErr.message);
        }

        for (const acc of accounts) {
          let followers = acc.followers || 0;

          if (followers === 0 && acc.platform === 'tiktok' && acc.username) {
            try {
              const scraped = await tiktokScraper.getProfileStats(acc.username);
              if (scraped?.followers > 0) followers = scraped.followers;
            } catch (e) {
              console.log('⚠️ [Rates] TikTok scraper fallback failed:', e.message);
            }
          }

          const views = platformViews[acc.platform] || 0;
          const eng = platformEngagement[acc.platform] || {};
          const totalInteractions = (eng.likes || 0) + (eng.comments || 0) + (eng.shares || 0);
          const engRate = eng.views > 0 ? parseFloat(((totalInteractions / eng.views) * 100).toFixed(1)) : 0;

          await supabaseAdmin.from('growth_snapshots').upsert({
            artist_id: artistId,
            platform: acc.platform,
            followers,
            engagement_rate: engRate,
            total_views: views,
            snapshot_date: today
          }, { onConflict: 'artist_id,platform,snapshot_date' });
        }
      } catch (syncErr) {
        console.log('⚠️ [Rates] Zernio sync failed, using cached data:', syncErr.message);
      }
    }

    const { data: allSnapshots } = await supabaseAdmin
      .from('growth_snapshots')
      .select('platform, followers, engagement_rate, total_views, snapshot_date')
      .eq('artist_id', artistId)
      .order('snapshot_date', { ascending: false });

    const latestByPlatform = {};
    for (const s of (allSnapshots || [])) {
      if (!latestByPlatform[s.platform]) latestByPlatform[s.platform] = s;
    }

    const platforms = Object.entries(latestByPlatform).map(([platform, s]) => ({
      platform,
      followers: s.followers || 0,
      engagement_rate: parseFloat(s.engagement_rate) || 0,
      total_views: s.total_views || 0
    }));

    const totalFollowers = platforms.reduce((sum, p) => sum + p.followers, 0);
    const avgEngagement = platforms.length > 0
      ? platforms.reduce((sum, p) => sum + p.engagement_rate, 0) / platforms.length
      : 2.0;
    const totalViews = platforms.reduce((sum, p) => sum + p.total_views, 0);

    function calcTierAndRates(followers, engagementRate, views) {
      let tier = 'nano', cpmBase = 5;
      if (followers >= 1000000) { tier = 'mega'; cpmBase = 25; }
      else if (followers >= 500000) { tier = 'macro'; cpmBase = 20; }
      else if (followers >= 100000) { tier = 'mid'; cpmBase = 15; }
      else if (followers >= 10000) { tier = 'micro'; cpmBase = 10; }

      const mult = engagementRate > 5 ? 1.5 : engagementRate > 3 ? 1.2 : 1.0;
      const baseCpm = cpmBase * mult;

      return {
        tier,
        suggested_rates: {
          reel: Math.round(baseCpm * (views / 1000) * 0.8) || Math.round(followers * 0.02),
          story: Math.round(baseCpm * (views / 1000) * 0.3) || Math.round(followers * 0.005),
          feed_post: Math.round(baseCpm * (views / 1000) * 0.5) || Math.round(followers * 0.01),
          bundle_3: Math.round(baseCpm * (views / 1000) * 1.5 * 0.85) || Math.round(followers * 0.04),
          ugc_video: Math.round(150 + (followers / 10000) * 50),
        }
      };
    }

    const combined = calcTierAndRates(totalFollowers, avgEngagement, totalViews);

    const perPlatform = platforms.map(p => ({
      platform: p.platform,
      followers: p.followers,
      engagement_rate: p.engagement_rate,
      ...calcTierAndRates(p.followers, p.engagement_rate, p.total_views)
    }));

    res.json({
      tier: combined.tier,
      followers: totalFollowers,
      engagement_rate: parseFloat(avgEngagement.toFixed(1)),
      suggested_rates: combined.suggested_rates,
      platforms: perPlatform,
      currency: 'USD',
      note: 'Tarifas sugeridas basadas en tu audiencia y engagement. Ajusta segun tu nicho y la marca.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// ══  PLATFORM ANALYTICS — per-platform command center data  ══
// ══════════════════════════════════════════════════════════════

const METRIC_EXPLANATIONS_ES = {
  followers: 'Personas que eligieron seguir tu cuenta. Es tu audiencia base.',
  reach: 'Cuántas personas DISTINTAS vieron tu contenido.',
  impressions: 'Cuántas veces se mostró tu contenido en total. Una persona puede verlo 3 veces = 3 impresiones.',
  views: 'Cuántas veces se reprodujo tu video.',
  likes: 'Personas que dieron like a tu publicación.',
  comments: 'Personas que escribieron algo en tu publicación. Vale mucho más que un like.',
  shares: 'Personas que enviaron tu contenido a alguien. Es la forma más poderosa de crecer.',
  saves: 'La métrica más valiosa de Instagram. Cuando alguien guarda tu post es porque quiere volver a verlo.',
  clicks: 'Cuántas personas hicieron clic en tu perfil o link desde tu contenido.',
  engagement_rate: 'De cada 100 personas que ven tu contenido, cuántas interactúan. Más de 3% es bueno, más de 6% es excelente.',
  growth_rate: 'Porcentaje de crecimiento de seguidores en los últimos 7 días. Positivo = estás creciendo. Negativo = estás perdiendo audiencia.',
  reach_follower_ratio: 'Tu alcance dividido entre tus seguidores. Si es mayor a 100% tu contenido llega más allá de quien te sigue (viral). Si es menor a 30% el algoritmo te está limitando.',
  save_rate: 'De cada 100 personas que ven tu post, cuántas lo guardan. Un save rate alto indica que creas contenido de valor que la gente quiere revisitar.',
  share_rate: 'De cada 100 personas que ven tu post, cuántas lo comparten. Es la señal #1 para los algoritmos en 2026.',
  frequency_score: 'Impresiones divididas entre alcance. Si es mayor a 1.5 tu contenido se ve varias veces (bueno). Si es 1 la gente lo ve y se va.',
  engagement_per_post: 'Engagement total dividido entre cantidad de posts. Te dice si cada publicación rinde más o menos que tu promedio.',
  content_lifespan: 'Cuántos días tu contenido sigue generando engagement después de publicarse. Un post con vida larga indica contenido evergreen.',
  optimal_frequency: 'La cantidad de publicaciones por semana que maximiza tu engagement. Publicar de más puede bajar tu rendimiento.',
  follow_conversion: 'De cada 100 personas que ven tu contenido, cuántas te empiezan a seguir. Indica qué tan atractivo es tu perfil para nuevos visitantes.',
  churn_rate: 'Porcentaje de seguidores que te dejaron de seguir. Si es alto, tu contenido no cumple la expectativa que generaste.',
  avg_watch_time: 'Tiempo promedio que las personas ven tus videos. Un avg watch time alto indica que tu contenido retiene la atención.',
  sub_conversion_rate: 'De cada 100 personas que ven tu video, cuántas se suscriben. Indica qué tan efectivo es tu contenido para convertir viewers en suscriptores.',
  net_sub_growth: 'Suscriptores ganados menos suscriptores perdidos. Es tu balance real de crecimiento en YouTube.',
  watch_time_total: 'Tiempo total que las personas pasaron viendo tus videos. El algoritmo de YouTube premia los canales con más watch time acumulado.',
  views_per_follower: 'Views divididos entre seguidores. Si es mayor a 1 tu contenido llega más allá de tu base. En TikTok valores de 5-10x son comunes.',
  click_rate: 'De cada 100 impresiones, cuántas generan un clic. Indica qué tan efectivo es tu CTA o bio para llevar tráfico.',
  viral_score_avg: 'Promedio del viral score de tus publicaciones. Más de 7 indica contenido con alto potencial de explotar.',
  best_times: 'Los días y horas en que tu audiencia interactuó más. Publicar en esos momentos aumenta las probabilidades de que más personas lo vean.',
  content_decay: 'Cómo decae el engagement de tu contenido con el tiempo. Una curva lenta = contenido evergreen. Una caída rápida = contenido efímero.',
  posting_frequency: 'Relación entre cuántos posts publicas por semana y el engagement que obtienes. Te ayuda a encontrar tu ritmo ideal.',
};

exports.getPlatformAnalytics = async (req, res) => {
  try {
    const { artistId } = req.params;
    const { platform } = req.query;

    const [
      snapshotsRes,
      prevSnapshotsRes,
      postsRes,
      cacheDecayRes,
      cacheFreqRes,
      cacheBestTimesRes,
      cacheBestTimesPlatRes,
      igInsightsRes,
      ytInsightsRes,
    ] = await Promise.all([
      supabase.from('platform_snapshots')
        .select('*')
        .eq('artist_id', artistId)
        .order('snapshot_date', { ascending: false })
        .limit(200),
      supabase.from('platform_snapshots')
        .select('platform, followers, snapshot_date')
        .eq('artist_id', artistId)
        .lt('snapshot_date', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0])
        .order('snapshot_date', { ascending: false })
        .limit(200),
      supabase.from('videos')
        .select('id, title, platforms, viral_score_real, analytics_4h, published_at, created_at, source_url')
        .eq('artist_id', artistId)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
        .limit(100),
      supabase.from('zernio_sync_cache').select('data').eq('artist_id', artistId).eq('cache_key', 'content_decay').single(),
      supabase.from('zernio_sync_cache').select('data').eq('artist_id', artistId).eq('cache_key', 'posting_frequency').single(),
      supabase.from('zernio_sync_cache').select('data').eq('artist_id', artistId).eq('cache_key', 'best_posting_times').single(),
      supabase.from('zernio_sync_cache').select('data').eq('artist_id', artistId).eq('cache_key', 'best_times_by_platform').single(),
      supabase.from('zernio_sync_cache').select('data').eq('artist_id', artistId).eq('cache_key', 'instagram_insights').single(),
      supabase.from('zernio_sync_cache').select('data').eq('artist_id', artistId).eq('cache_key', 'youtube_insights').single(),
    ]);

    const allSnapshots = snapshotsRes.data || [];
    const prevSnapshots = prevSnapshotsRes.data || [];
    const allPosts = postsRes.data || [];
    const contentDecay = cacheDecayRes.data?.data || {};
    const postingFrequency = cacheFreqRes.data?.data || {};
    const bestTimesGlobal = cacheBestTimesRes.data?.data || [];
    const bestTimesByPlatform = cacheBestTimesPlatRes.data?.data || {};
    const igInsights = igInsightsRes.data?.data || null;
    const ytInsights = ytInsightsRes.data?.data || null;

    // Get platforms from snapshots + artist's active_platforms + posts
    const snapshotPlatforms = allSnapshots.map(s => s.platform);
    const postPlatforms = allPosts.flatMap(p => p.platforms || []);

    // Also fetch artist's active_platforms from DB
    const { data: artistRow } = await supabase
      .from('artists')
      .select('active_platforms, social_keys')
      .eq('id', artistId)
      .single();
    const activePlatforms = artistRow?.active_platforms || [];
    const socialKeys = artistRow?.social_keys || {};
    const socialKeyPlatforms = Object.keys(socialKeys);

    const connectedPlatforms = [...new Set([
      ...snapshotPlatforms,
      ...postPlatforms,
      ...activePlatforms,
      ...socialKeyPlatforms,
    ])].filter(p => ['instagram', 'tiktok', 'youtube', 'facebook'].includes(p));

    const buildPlatformData = (plat) => {
      const latest = allSnapshots.find(s => s.platform === plat) || {};
      const prev = prevSnapshots.find(s => s.platform === plat) || {};
      const platPosts = allPosts.filter(p => Array.isArray(p.platforms) && p.platforms.includes(plat));

      const followers = latest.followers || 0;
      const prevFollowers = prev.followers || 0;
      const reach = latest.reach || 0;
      const impressions = latest.impressions || 0;
      const likes = latest.likes || 0;
      const comments = latest.comments || 0;
      const shares = latest.shares || 0;
      const saves = latest.saves || 0;
      const clicks = latest.clicks || 0;
      const views = latest.views || 0;
      const postsCount = latest.posts_count || platPosts.length;
      const engRate = latest.engagement_rate || 0;

      const growthRate = prevFollowers > 0
        ? parseFloat(((followers - prevFollowers) / prevFollowers * 100).toFixed(1))
        : 0;
      const reachFollowerRatio = followers > 0
        ? parseFloat((reach / followers * 100).toFixed(1))
        : 0;
      const saveRate = reach > 0
        ? parseFloat((saves / reach * 100).toFixed(2))
        : 0;
      const shareRate = reach > 0
        ? parseFloat((shares / reach * 100).toFixed(2))
        : 0;
      const frequencyScore = reach > 0
        ? parseFloat((impressions / reach).toFixed(2))
        : 0;
      const engagementPerPost = postsCount > 0
        ? Math.round((likes + comments + shares + saves) / postsCount)
        : 0;
      const clickRate = impressions > 0
        ? parseFloat((clicks / impressions * 100).toFixed(2))
        : 0;
      const viewsPerFollower = followers > 0
        ? parseFloat((views / followers).toFixed(1))
        : 0;

      const viralScores = platPosts
        .map(p => p.viral_score_real)
        .filter(s => typeof s === 'number' && s > 0);
      const viralScoreAvg = viralScores.length > 0
        ? parseFloat((viralScores.reduce((a, b) => a + b, 0) / viralScores.length).toFixed(1))
        : 0;

      const result = {
        platform: plat,
        kpis: {
          followers,
          reach,
          impressions,
          views,
          likes,
          comments,
          shares,
          saves,
          clicks,
          engagement_rate: engRate,
          posts_count: postsCount,
        },
        calculated: {
          growth_rate: growthRate,
          reach_follower_ratio: reachFollowerRatio,
          save_rate: saveRate,
          share_rate: shareRate,
          frequency_score: frequencyScore,
          engagement_per_post: engagementPerPost,
          click_rate: clickRate,
          views_per_follower: viewsPerFollower,
          viral_score_avg: viralScoreAvg,
        },
        content_decay: contentDecay[plat] || contentDecay._global || [],
        posting_frequency: postingFrequency[plat] || postingFrequency._global || [],
        best_times: bestTimesByPlatform[plat] || bestTimesGlobal,
        posts: platPosts.slice(0, 30).map(p => {
          const a = p.analytics_4h || {};
          const pReach = a.reach || 0;
          return {
            id: p.id,
            title: p.title,
            date: p.published_at || p.created_at,
            source_url: p.source_url,
            viral_score: p.viral_score_real || 0,
            likes: a.likes || 0,
            comments: a.comments || 0,
            views: a.views || 0,
            shares: a.shares || 0,
            saves: a.saves || 0,
            reach: pReach,
            impressions: a.impressions || 0,
            clicks: a.clicks || 0,
            engagement_rate: a.engagement_rate || 0,
            ig_avg_watch_time: a.ig_reels_avg_watch_time || 0,
            save_rate: pReach > 0 ? parseFloat(((a.saves || 0) / pReach * 100).toFixed(2)) : 0,
            share_rate: pReach > 0 ? parseFloat(((a.shares || 0) / pReach * 100).toFixed(2)) : 0,
          };
        }),
      };

      if (plat === 'instagram' && igInsights) {
        const metrics = igInsights.metrics || igInsights.data || igInsights;
        result.platform_insights = {
          accounts_engaged: metrics.accounts_engaged || 0,
          total_interactions: metrics.total_interactions || 0,
          follows: metrics.follows_and_unfollows?.follows || metrics.follows || 0,
          unfollows: metrics.follows_and_unfollows?.unfollows || metrics.unfollows || 0,
        };
        const follows = result.platform_insights.follows || 0;
        const unfollows = result.platform_insights.unfollows || 0;
        result.calculated.follow_conversion = reach > 0
          ? parseFloat((follows / reach * 100).toFixed(2))
          : 0;
        result.calculated.churn_rate = followers > 0
          ? parseFloat((unfollows / followers * 100).toFixed(2))
          : 0;
      }

      if (plat === 'instagram') {
        const watchTimes = platPosts
          .map(p => p.analytics_4h?.ig_reels_avg_watch_time)
          .filter(t => typeof t === 'number' && t > 0);
        result.calculated.avg_watch_time = watchTimes.length > 0
          ? parseFloat((watchTimes.reduce((a, b) => a + b, 0) / watchTimes.length).toFixed(1))
          : 0;
      }

      if (plat === 'youtube' && ytInsights) {
        const metrics = ytInsights.metrics || ytInsights.data || ytInsights;
        const subGained = metrics.subscribersGained || 0;
        const subLost = metrics.subscribersLost || 0;
        const watchMin = metrics.estimatedMinutesWatched || 0;
        result.platform_insights = {
          watch_time_total: watchMin,
          subscribers_gained: subGained,
          subscribers_lost: subLost,
        };
        result.calculated.net_sub_growth = subGained - subLost;
        result.calculated.sub_conversion_rate = views > 0
          ? parseFloat((subGained / views * 100).toFixed(3))
          : 0;
        result.calculated.avg_watch_time = views > 0
          ? parseFloat((watchMin / views).toFixed(1))
          : 0;
      }

      return result;
    };

    if (platform && platform !== 'all') {
      return res.json({
        platform: buildPlatformData(platform),
        explanations: METRIC_EXPLANATIONS_ES,
      });
    }

    const totalFollowers = connectedPlatforms.reduce((s, p) => {
      const snap = allSnapshots.find(x => x.platform === p);
      return s + (snap?.followers || 0);
    }, 0);
    const totalReach = connectedPlatforms.reduce((s, p) => {
      const snap = allSnapshots.find(x => x.platform === p);
      return s + (snap?.reach || 0);
    }, 0);
    const totalViews = connectedPlatforms.reduce((s, p) => {
      const snap = allSnapshots.find(x => x.platform === p);
      return s + (snap?.views || 0);
    }, 0);
    const totalLikes = connectedPlatforms.reduce((s, p) => {
      const snap = allSnapshots.find(x => x.platform === p);
      return s + (snap?.likes || 0);
    }, 0);
    const avgER = connectedPlatforms.length > 0
      ? parseFloat((connectedPlatforms.reduce((s, p) => {
        const snap = allSnapshots.find(x => x.platform === p);
        return s + (snap?.engagement_rate || 0);
      }, 0) / connectedPlatforms.length).toFixed(1))
      : 0;

    const totalPrevFollowers = connectedPlatforms.reduce((s, p) => {
      const prev = prevSnapshots.find(x => x.platform === p);
      return s + (prev?.followers || 0);
    }, 0);
    const overallGrowth = totalPrevFollowers > 0
      ? parseFloat(((totalFollowers - totalPrevFollowers) / totalPrevFollowers * 100).toFixed(1))
      : 0;

    const allViralScores = allPosts
      .map(p => p.viral_score_real)
      .filter(s => typeof s === 'number' && s > 0);
    const overallViralAvg = allViralScores.length > 0
      ? parseFloat((allViralScores.reduce((a, b) => a + b, 0) / allViralScores.length).toFixed(1))
      : 0;

    const platformRanking = connectedPlatforms
      .map(p => {
        const snap = allSnapshots.find(x => x.platform === p);
        return { platform: p, engagement_rate: snap?.engagement_rate || 0, followers: snap?.followers || 0 };
      })
      .sort((a, b) => b.engagement_rate - a.engagement_rate);

    const topPosts = [...allPosts]
      .map(p => {
        const a = p.analytics_4h || {};
        const score = (a.views || 0) + (a.likes || 0) * 5 + (a.comments || 0) * 10 + (a.shares || 0) * 8;
        return { ...p, _rank_score: score, analytics: a };
      })
      .sort((a, b) => b._rank_score - a._rank_score)
      .slice(0, 5)
      .map(p => ({
        id: p.id,
        title: p.title,
        platforms: p.platforms,
        date: p.published_at || p.created_at,
        viral_score: p.viral_score_real || 0,
        likes: p.analytics.likes || 0,
        comments: p.analytics.comments || 0,
        views: p.analytics.views || 0,
        shares: p.analytics.shares || 0,
        saves: p.analytics.saves || 0,
      }));

    res.json({
      overview: {
        total_followers: totalFollowers,
        total_reach: totalReach,
        total_views: totalViews,
        total_likes: totalLikes,
        avg_engagement_rate: avgER,
        growth_rate: overallGrowth,
        viral_score_avg: overallViralAvg,
        platform_ranking: platformRanking,
        top_posts: topPosts,
        content_decay_global: contentDecay._global || [],
        posting_frequency_global: postingFrequency._global || [],
        best_times_global: bestTimesGlobal,
      },
      platforms: Object.fromEntries(
        connectedPlatforms.map(p => [p, buildPlatformData(p)])
      ),
      connected_platforms: connectedPlatforms,
      explanations: METRIC_EXPLANATIONS_ES,
    });
  } catch (e) {
    console.error('getPlatformAnalytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// ══  CONTENT LEARNINGS — what the AI learned from posts     ══
// ══════════════════════════════════════════════════════════════

exports.getContentLearnings = async (req, res) => {
  try {
    const { artistId } = req.params;

    const [postsRes, cacheDecayRes, cacheFreqRes, cacheBestTimesRes] = await Promise.all([
      supabase.from('videos')
        .select('id, title, platforms, viral_score_real, analytics_4h, published_at, created_at, ai_copy_short')
        .eq('artist_id', artistId)
        .eq('status', 'published')
        .not('analytics_4h', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('zernio_sync_cache').select('data').eq('artist_id', artistId).eq('cache_key', 'content_decay').single(),
      supabase.from('zernio_sync_cache').select('data').eq('artist_id', artistId).eq('cache_key', 'posting_frequency').single(),
      supabase.from('zernio_sync_cache').select('data').eq('artist_id', artistId).eq('cache_key', 'best_times_by_platform').single(),
    ]);

    const posts = postsRes.data || [];
    const contentDecay = cacheDecayRes.data?.data || {};
    const postingFreq = cacheFreqRes.data?.data || {};
    const bestTimesByPlat = cacheBestTimesRes.data?.data || {};

    if (posts.length < 3) {
      return res.json({ learnings: {}, message: 'Necesitas al menos 3 publicaciones con métricas para generar aprendizajes.' });
    }

    const platformPosts = {};
    posts.forEach(p => {
      (p.platforms || []).forEach(plat => {
        if (!platformPosts[plat]) platformPosts[plat] = [];
        platformPosts[plat].push(p);
      });
    });

    const learnings = {};

    for (const [plat, platPosts] of Object.entries(platformPosts)) {
      if (platPosts.length < 2) continue;

      const insights = [];
      const postsWithMetrics = platPosts.map(p => {
        const a = p.analytics_4h || {};
        return {
          ...p,
          likes: a.likes || 0,
          comments: a.comments || 0,
          shares: a.shares || 0,
          saves: a.saves || 0,
          views: a.views || 0,
          reach: a.reach || 0,
          eng_rate: a.engagement_rate || 0,
          watch_time: a.ig_reels_avg_watch_time || 0,
        };
      });

      const avgER = postsWithMetrics.reduce((s, p) => s + p.eng_rate, 0) / postsWithMetrics.length;
      const avgShares = postsWithMetrics.reduce((s, p) => s + p.shares, 0) / postsWithMetrics.length;
      const avgSaves = postsWithMetrics.reduce((s, p) => s + p.saves, 0) / postsWithMetrics.length;

      const questionPosts = postsWithMetrics.filter(p => (p.title || p.ai_copy_short || '').includes('?'));
      const nonQuestionPosts = postsWithMetrics.filter(p => !(p.title || p.ai_copy_short || '').includes('?'));

      if (questionPosts.length >= 2 && nonQuestionPosts.length >= 2) {
        const qER = questionPosts.reduce((s, p) => s + p.eng_rate, 0) / questionPosts.length;
        const nqER = nonQuestionPosts.reduce((s, p) => s + p.eng_rate, 0) / nonQuestionPosts.length;
        if (qER > nqER * 1.3) {
          insights.push({
            type: 'hook_pattern',
            title: 'Hooks con pregunta generan más engagement',
            detail: `Posts con pregunta: ${qER.toFixed(1)}% ER vs ${nqER.toFixed(1)}% ER sin pregunta (${(qER / nqER).toFixed(1)}x más).`,
            impact: 'high',
          });
        } else if (nqER > qER * 1.3) {
          insights.push({
            type: 'hook_pattern',
            title: 'Afirmaciones directas funcionan mejor que preguntas',
            detail: `Posts sin pregunta: ${nqER.toFixed(1)}% ER vs ${qER.toFixed(1)}% ER con pregunta.`,
            impact: 'medium',
          });
        }
      }

      const sorted = [...postsWithMetrics].sort((a, b) => b.eng_rate - a.eng_rate);
      const topHalf = sorted.slice(0, Math.ceil(sorted.length / 2));
      const bottomHalf = sorted.slice(Math.ceil(sorted.length / 2));

      if (plat === 'instagram' && topHalf.length > 0) {
        const topSaveRate = topHalf.reduce((s, p) => s + (p.reach > 0 ? p.saves / p.reach : 0), 0) / topHalf.length * 100;
        const bottomSaveRate = bottomHalf.length > 0 ? bottomHalf.reduce((s, p) => s + (p.reach > 0 ? p.saves / p.reach : 0), 0) / bottomHalf.length * 100 : 0;
        if (topSaveRate > 0) {
          insights.push({
            type: 'save_pattern',
            title: `Save rate en top posts: ${topSaveRate.toFixed(1)}%`,
            detail: `Tus mejores posts tienen ${topSaveRate.toFixed(1)}% save rate vs ${bottomSaveRate.toFixed(1)}% en los demás. Los saves son la señal más fuerte para el algoritmo de Instagram.`,
            impact: topSaveRate > 2 ? 'high' : 'medium',
          });
        }
      }

      if (avgShares > 0) {
        const topShareRate = topHalf.reduce((s, p) => s + (p.reach > 0 ? p.shares / p.reach : 0), 0) / topHalf.length * 100;
        insights.push({
          type: 'share_pattern',
          title: `Share rate promedio: ${topShareRate.toFixed(1)}%`,
          detail: `De ${platPosts.length} posts, los mejores tienen ${topShareRate.toFixed(1)}% share rate. Shares son la señal #1 del algoritmo en 2026.`,
          impact: topShareRate > 1 ? 'high' : 'medium',
        });
      }

      if (plat === 'instagram') {
        const withWatch = postsWithMetrics.filter(p => p.watch_time > 0);
        if (withWatch.length >= 2) {
          const avgWatch = withWatch.reduce((s, p) => s + p.watch_time, 0) / withWatch.length;
          insights.push({
            type: 'watch_time',
            title: `Avg watch time: ${avgWatch.toFixed(1)}s`,
            detail: `Tus Reels se ven en promedio ${avgWatch.toFixed(1)} segundos. ${avgWatch > 10 ? 'Buena retención — tu audiencia se queda.' : 'Retención baja — mejora el gancho de los primeros 2 segundos.'}`,
            impact: avgWatch > 10 ? 'positive' : 'needs_work',
          });
        }
      }

      const decay = contentDecay[plat] || [];
      if (decay.length > 0) {
        const lastBucket = decay[decay.length - 1];
        const lastPct = lastBucket?.avg_pct || lastBucket?.percentage || lastBucket?.value || 0;
        const lifespan = lastPct > 20 ? 'larga (evergreen)' : lastPct > 5 ? 'media' : 'corta (efímero)';
        insights.push({
          type: 'content_lifespan',
          title: `Vida útil: ${lifespan}`,
          detail: `Tu contenido retiene ${lastPct.toFixed(0)}% del engagement al final del ciclo. ${lastPct > 20 ? 'Tu contenido sigue generando interacción días después.' : 'Tu contenido muere rápido — considera formatos evergreen.'}`,
          impact: lastPct > 20 ? 'positive' : 'needs_work',
        });
      }

      const freq = postingFreq[plat] || [];
      if (freq.length > 0) {
        const best = freq.reduce((b, r) => (r.avg_engagement || r.engagement_rate || 0) > (b.avg_engagement || b.engagement_rate || 0) ? r : b, freq[0]);
        const bestFreq = best.posts_per_week || best.frequency || '?';
        const bestEng = best.avg_engagement || best.engagement_rate || 0;
        insights.push({
          type: 'optimal_frequency',
          title: `Frecuencia óptima: ${bestFreq} posts/semana`,
          detail: `Con ${bestFreq} posts por semana obtienes ${bestEng.toFixed(1)}% engagement. Publicar más o menos reduce tu rendimiento.`,
          impact: 'high',
        });
      }

      const bestTimes = bestTimesByPlat[plat] || [];
      if (bestTimes.length > 0) {
        const top = bestTimes[0];
        insights.push({
          type: 'best_time',
          title: `Mejor momento: ${top.label}`,
          detail: `Tu engagement sube significativamente publicando ${top.label}. Segundo mejor: ${bestTimes[1]?.label || 'N/A'}.`,
          impact: 'medium',
        });
      }

      learnings[plat] = insights;
    }

    res.json({ learnings });
  } catch (e) {
    console.error('getContentLearnings error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
