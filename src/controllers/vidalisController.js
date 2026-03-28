const vidalisService = require('../services/vidalisService');
const cloudinaryService = require('../services/cloudinaryService');
const ayrshareService = require('../services/ayrshareService');
const instagramService = require('../services/instagramService');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);

// --- LOGIN ---
exports.login = async (req, res) => {
  try {
    const { email, password, account_type, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Se requiere email y contraseña' });
    }
    const userData = await vidalisService.loginUser(email, password, account_type || null, name || null);
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

exports.getSignature = (req, res) => {
  try {
    const { folder } = req.query;
    const signatureData = cloudinaryService.generateUploadSignature(folder);
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
    const gallery = await vidalisService.fetchArtistGallery(artistId);
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
    console.log("req.body", req.body);
    const { videoId } = req.params;
    const result = await vidalisService.updateVideoSettings(videoId, req.body);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Endpoint para que n8n actualice el status + datos de análisis IA
exports.n8nCallback = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { status, viral_score, ai_copy_short, ai_copy_long, hashtags } = req.body;

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
 * Sincroniza las plataformas activas desde Upload-Post a la base de datos local.
 */
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
        // Si hay al menos una cuenta vinculada para esa plataforma
        if (Array.isArray(accounts[platform]) && accounts[platform].length > 0) {
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
