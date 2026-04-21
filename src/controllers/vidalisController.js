const vidalisService = require('../services/vidalisService');
const cloudinaryService = require('../services/cloudinaryService');
const ayrshareService = require('../services/ayrshareService');
const instagramService = require('../services/instagramService');
const uploadPostService = require('../services/uploadPostService');
const { generateInsights } = require('../services/aiService');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);
const aiService = require('../services/aiService');

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
    const result = await vidalisService.connectSocialAccounts(artistId);
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
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message, details: error.response?.data });
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
      text, platforms, mediaUrls, profileKey, isPreview,
      facebookOptions, instagramOptions, tiktokOptions, youtubeOptions,
      linkedinOptions, twitterOptions, publish_mode
    } = req.body;

    if (!text || !platforms || platforms.length === 0) {
      return res.status(400).json({ error: 'Se requiere text y al menos una plataforma' });
    }

    const options = { facebookOptions, instagramOptions, tiktokOptions, youtubeOptions, linkedinOptions, twitterOptions };

    let result;
    if (publish_mode === 'upload-post') {
      const uploadPostService = require('../services/uploadPostService');
      result = await uploadPostService.publishPost(text, platforms, mediaUrls || [], profileKey || null, options);
    } else {
      result = await ayrshareService.publishPost(text, platforms, mediaUrls || [], profileKey || null, options, isPreview || false);
    }

    res.status(200).json(result);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.response?.data?.message || error.message });
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
    const { publish_mode } = req.body; // 'ayrshare' | 'direct' | 'upload-post'
    if (!['ayrshare', 'direct', 'upload-post'].includes(publish_mode)) {
      return res.status(400).json({ error: "publish_mode debe ser 'ayrshare', 'direct' o 'upload-post'" });
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
    const { platforms, postType } = req.body || {};
    const result = await vidalisService.publishVideoNow(videoId, { platforms, postType });
    res.status(200).json(result);
  } catch (error) {
    console.error('❌ Error en publishNow:', error.message);
    const status = error.response?.status || 400;
    res.status(status).json({
      error: error.message,
      details: error.response?.data || null
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

    // Consultar métricas reales y guardar snapshots en paralelo
    const withMetrics = await Promise.all((videos || []).map(async (video) => {
      if (!video.ayrshare_post_id) return { ...video, metrics: null };

      const rawMetrics = await uploadPostService.getPostAnalytics(video.ayrshare_post_id);
      if (!rawMetrics) return { ...video, metrics: null };

      // Detectar plataforma principal del post
      const platform = Array.isArray(video.platforms) ? video.platforms[0] : 'unknown';

      // Guardar snapshot + actualizar viral_score_real en el video
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
      .select('name, ayrshare_profile_key, active_platforms')
      .eq('id', artistId)
      .single();

    if (error || !artist) return res.status(404).json({ error: 'Artista no encontrado' });

    // 1. Analytics de perfil (seguidores, reach por plataforma)
    let profileAnalytics = {};
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

    // 2. Últimos posts con métricas reales (incluye viral_score_real guardado)
    const { data: videos } = await supabase
      .from('videos')
      .select('id, title, platforms, published_at, created_at, viral_score, viral_score_real, ayrshare_post_id, status, analytics_4h')
      .eq('artist_id', artistId)
      .order('created_at', { ascending: false })
      .limit(15);

    const postsWithMetrics = await Promise.all((videos || []).map(async (video) => {
      // Usar datos ya guardados en analytics_4h si existen (evita llamadas redundantes)
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

      if (!video.ayrshare_post_id) return { ...video, likes: 0, comments: 0, views: 0, shares: 0, engagement_rate: 0 };

      const rawMetrics = await uploadPostService.getPostAnalytics(video.ayrshare_post_id);
      if (!rawMetrics) return { ...video, likes: 0, comments: 0, views: 0, shares: 0, engagement_rate: 0 };

      const platform = Array.isArray(video.platforms) ? video.platforms[0] : 'unknown';
      const normalized = await uploadPostService.saveMetricsSnapshot(video.id, artistId, platform, rawMetrics);
      return { ...video, ...normalized };
    }));

    // 3. Leer historial de análisis anteriores (últimos 3) para que Claude aprenda
    const { data: prevInsights } = await supabase
      .from('analytics_insights_log')
      .select('generated_at, insights, decisions, engagement_rate, followers_total, best_platform')
      .eq('artist_id', artistId)
      .order('generated_at', { ascending: false })
      .limit(3);

    // 4. Generar insights con Claude (con contexto histórico)
    const insights = await generateInsights(
      profileAnalytics,
      postsWithMetrics,
      artist.name,
      prevInsights || []
    );

    // 5. Guardar este análisis en el log para futuras comparaciones
    const followersTotal = Object.values(profileAnalytics || {})
      .reduce((acc, p) => acc + (p?.followers || 0), 0);
    const totalReach = Object.values(profileAnalytics || {})
      .reduce((acc, p) => acc + (p?.reach || 0), 0);

    const { error: logErr } = await supabase
      .from('analytics_insights_log')
      .insert({
        artist_id: artistId,
        insights: insights.insights || [],
        decisions: insights.decisions || [],
        best_platform: insights.best_platform || null,
        best_post_title: insights.best_post_title || null,
        engagement_rate: insights.engagement_rate || 0,
        followers_total: followersTotal,
        total_reach: totalReach,
        profile_data: profileAnalytics
      });

    if (logErr) console.warn('⚠️ No se pudo guardar analytics_insights_log:', logErr.message);

    // 6. Obtener uso mensual y límites
    const firstDayOfMonth = new Date();
    firstDayOfMonth.setDate(1);
    firstDayOfMonth.setHours(0, 0, 0, 0);

    const { count: usageCount } = await supabase
      .from('videos')
      .select('id', { count: 'exact', head: true })
      .eq('artist_id', artistId)
      .gte('created_at', firstDayOfMonth.toISOString());

    const planType = (artist.agencies?.plan_type || artist.plan_type || 'Mini').trim();
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
      plan_name: planType
    });
  } catch (err) {
    console.error('❌ getAnalyticsInsights:', err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.syncSocialAccounts = async (req, res) => {
  const { artistId } = req.params;
  try {
    // 1. Obtener el artista
    const { data: artist, error: artistError } = await supabase
      .from('artists')
      .select('*')
      .eq('id', artistId)
      .single();

    if (artistError || !artist) {
      return res.status(404).json({ error: 'Artista no encontrado' });
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
