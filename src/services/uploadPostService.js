/**
 * UPLOAD-POST SERVICE - Vidalis.AI
 * 
 * Servicio para la API de upload-post.com.
 * Reemplaza a Ayrshare con una arquitectura API-first para agencias.
 * 
 * Base URL: https://api.upload-post.com/api
 * Auth: Authorization: Apikey YOUR_API_KEY
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./loggerService');

const UPLOAD_POST_BASE = 'https://api.upload-post.com/api';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);

// ============================================================
// HELPER: Calcula viral score real (1-10) desde métricas crudas
// ============================================================

/**
 * Normaliza métricas de engagement a un score 1-10.
 * Fórmula: engagement_rate = (likes + comments*2 + shares*3 + saves*2) / max(views, impressions, 1) * 100
 * Scale: 0% → 1, 1% → 4, 3% → 6, 6% → 8, 10%+ → 10
 */
function calcEngagementRate(likes = 0, comments = 0, shares = 0, saves = 0, views = 0, impressions = 0) {
  const denominator = Math.max(views, impressions, 1);
  const weighted = likes + (comments * 2) + (shares * 3) + (saves * 2);
  return (weighted / denominator) * 100;
}

function engagementToViralScore(rate) {
  if (rate >= 15) return 10;
  if (rate >= 10) return 9;
  if (rate >= 7) return 8;
  if (rate >= 5) return 7;
  if (rate >= 3) return 6;
  if (rate >= 2) return 5;
  if (rate >= 1) return 4;
  if (rate >= 0.5) return 3;
  if (rate >= 0.1) return 2;
  return 1;
}

/**
 * Extrae y normaliza métricas desde la respuesta cruda de Upload-Post.
 * Cubre distintos nombres de campo según la plataforma.
 */
function normalizeMetrics(raw) {
  if (!raw) return { likes: 0, comments: 0, views: 0, shares: 0, saves: 0, reach: 0, impressions: 0 };
  return {
    likes: raw.likes || raw.like_count || raw.heart || 0,
    comments: raw.comments || raw.comment_count || 0,
    views: raw.views || raw.view_count || raw.play_count || 0,
    shares: raw.shares || raw.share_count || raw.retweet_count || raw.reposts || 0,
    saves: raw.saves || raw.save_count || raw.bookmarks || 0,
    reach: raw.reach || raw.non_followers_reach || 0,
    impressions: raw.impressions || raw.impression_count || 0,
    engagement_rate: raw.engagement_rate || 0,
  };
}

/**
 * Guarda un snapshot de métricas de un post en la tabla post_metrics_snapshots.
 * También actualiza videos.viral_score_real y videos.analytics_4h.
 *
 * @param {string} videoId
 * @param {string} artistId
 * @param {string} platform
 * @param {object} rawMetrics - Respuesta cruda de Upload-Post post-analytics
 */
exports.saveMetricsSnapshot = async (videoId, artistId, platform, rawMetrics) => {
  const m = normalizeMetrics(rawMetrics);
  const engRate = calcEngagementRate(m.likes, m.comments, m.shares, m.saves, m.views, m.impressions);
  const viralScore = engagementToViralScore(engRate);

  // 1. Guardar snapshot
  const { error: snapErr } = await supabase
    .from('post_metrics_snapshots')
    .insert({
      video_id: videoId,
      artist_id: artistId,
      platform: platform || 'unknown',
      likes: m.likes,
      comments: m.comments,
      views: m.views,
      shares: m.shares,
      saves: m.saves,
      reach: m.reach,
      impressions: m.impressions,
      engagement_rate: parseFloat(engRate.toFixed(3)),
      viral_score_real: viralScore,
      raw_data: rawMetrics || {}
    });

  if (snapErr) {
    console.warn('⚠️ No se pudo guardar snapshot de métricas:', snapErr.message);
  }

  // 2. Actualizar viral_score_real en el video (solo si mejora o hay datos reales)
  if (m.views > 0 || m.likes > 0) {
    const { error: vErr } = await supabase
      .from('videos')
      .update({
        viral_score_real: viralScore,
        analytics_4h: { ...m, engagement_rate: parseFloat(engRate.toFixed(3)), updated_at: new Date().toISOString() }
      })
      .eq('id', videoId);

    if (vErr) console.warn('⚠️ No se pudo actualizar viral_score_real:', vErr.message);
  }

  return { ...m, engagement_rate: engRate, viral_score_real: viralScore };
};

exports.normalizeMetrics = normalizeMetrics;
exports.calcEngagementRate = calcEngagementRate;
exports.engagementToViralScore = engagementToViralScore;

/**
 * Helper: Construye los headers de Upload-Post.
 */
function buildHeaders() {
  console.log("buildHeaders", process.env.UPLOAD_POST_API_KEY);
  return {
    'Content-Type': 'application/json',
    'Authorization': `Apikey ${process.env.UPLOAD_POST_API_KEY}`
  };
}

// ============================================================
// 1. PERFILES (Sub-cuentas para Artistas)
// ============================================================

/**
 * Crear un perfil (sub-cuenta) para un nuevo artista.
 * @param {string} name - Nombre del artista/cliente.
 * @param {string} artistId - ID único del artista en Supabase.
 * @returns {Promise<string>} - El ID del usuario creado.
 */
exports.createProfile = async (name, artistId = null) => {
  const shortId = artistId ? artistId.toString().split('-')[0] : '';
  let sanitizedUsername = (name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  
  if (shortId) {
    sanitizedUsername = `${sanitizedUsername}_${shortId}`;
  }

  if (!sanitizedUsername) sanitizedUsername = `artista_${Date.now()}`;
  
  console.log("Creating new profile in Upload-Post:", sanitizedUsername);

  try {
    const response = await axios.post(`${UPLOAD_POST_BASE}/uploadposts/users`, {
      username: sanitizedUsername
    }, {
      headers: buildHeaders()
    });
    return response.data.user_id || response.data.id || sanitizedUsername;
  } catch (err) {
    const status = err.response?.status;
    const errCode = err.response?.data?.details?.error_code || err.response?.data?.error_code;

    // Si el perfil ya existe, intentar obtenerlo directamente
    if (status === 400 || (status === 403 && errCode === 'USERNAME_TAKEN')) {
      console.warn('⚠️ Perfil ya existe en Upload-Post, reutilizando:', sanitizedUsername);
      return sanitizedUsername;
    }

    // Límite de perfiles del plan alcanzado — error claro para el usuario
    if (status === 403 && errCode === 'PROFILE_LIMIT_REACHED') {
      const limitErr = new Error('PROFILE_LIMIT_REACHED');
      limitErr.profileLimitReached = true;
      limitErr.details = err.response?.data?.details || {};
      throw limitErr;
    }

    console.error('❌ Error al crear perfil en Upload-Post:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Generar una URL para que el artista conecte sus redes sociales.
 * @param {string} userId - El ID del usuario/perfil de Upload-Post.
 * @returns {Promise<string>} - URL de conexión (access_url).
 */
exports.generateConnectUrl = async (userId, allowedPlatforms = []) => {
  try {
    logger.log('info', 'CONNECT_URL_REQUEST', { userId, allowedPlatforms });
    
    const response = await axios.post(`${UPLOAD_POST_BASE}/uploadposts/users/generate-jwt`, {
      username: userId,
      profile_username: userId,
      platforms: allowedPlatforms.length > 0 ? allowedPlatforms : undefined
    }, {
      headers: buildHeaders(),
      timeout: 10000 // 10 segundos máximo
    });

    if (!response.data || !response.data.access_url) {
       logger.log('error', 'CONNECT_URL_EMPTY', { userId, response: response.data });
       throw new Error('La API de proveedor no devolvió una URL de acceso.');
    }

    logger.log('success', 'CONNECT_URL_GENERATED', { userId });
    return response.data.access_url;
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    logger.log('error', 'CONNECT_URL_FAILED', { userId, error: errorMsg });
    console.error('❌ Error al generar JWT en Upload-Post:', errorMsg);
    throw err;
  }
};

// ============================================================
// 2. PLATAFORMAS ACTIVAS
// ============================================================

/**
 * Obtener las redes sociales vinculadas de un perfil.
 * NOTA: Si no hay endpoint directo, retornamos un array vacío o lo inferimos de analytics.
 */
exports.getActivePlatforms = async (userId) => {
  try {
    // Intentamos obtener info del usuario, que suele incluir plataformas conectadas
    const response = await axios.get(`${UPLOAD_POST_BASE}/uploadposts/users/${userId}`, {
      headers: buildHeaders()
    });

    return response.data.platforms || response.data.activeSocialAccounts || [];
  } catch (err) {
    console.warn('⚠️ No se pudo obtener plataformas activas de Upload-Post:', err.message);
    return [];
  }
};

// ============================================================
// 3. PUBLICACIÓN
// ============================================================

/**
 * Publicar contenido.
 * Usa FormData (multipart/form-data) como requiere la API de Upload-Post.
 */
exports.publishPost = async (text, platforms, mediaUrls = [], userId, options = {}) => {
  const FormData = require('form-data');
  const form = new FormData();

  form.append('user', userId);
  platforms.forEach(p => form.append('platform[]', p));

  // Campo principal de texto (caption/título por defecto para todas las plataformas)
  form.append('title', text || '');

  // Descripción larga (YouTube, Facebook, LinkedIn la usan)
  if (options.description) {
    form.append('description', options.description);
  }

  form.append('async_upload', 'true');

  const mediaUrl = mediaUrls[0];
  let endpoint = '/upload_text';

  if (mediaUrl) {
    const isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(mediaUrl) || mediaUrl.includes('/video/');

    if (isVideo) {
      endpoint = '/upload';
      form.append('video', mediaUrl);

      // postType viene del frontend: 'REELS' | 'STORIES' | 'FEED' | 'VIDEO'
      const postType = (options.postType || 'REELS').toUpperCase();

      // --- Instagram ---
      if (platforms.includes('instagram')) {
        // media_type: REELS | STORIES
        const igType = postType === 'STORIES' ? 'STORIES' : 'REELS';
        form.append('media_type', igType);
        form.append('share_to_feed', 'true');
        form.append('instagram_title', text || '');
      }

      // --- Facebook ---
      if (platforms.includes('facebook')) {
        // facebook_media_type: FEED | STORIES | REELS | VIDEO
        const fbType = ['FEED', 'STORIES', 'REELS', 'VIDEO'].includes(postType) ? postType : 'REELS';
        form.append('facebook_media_type', fbType);
        form.append('video_state', 'PUBLISHED');
        form.append('facebook_title', text || '');
        if (options.description) form.append('facebook_description', options.description);
        // facebook_page_id: requerido si hay más de una página conectada
        if (options.facebookPageId) form.append('facebook_page_id', options.facebookPageId);
      }

      // --- TikTok ---
      if (platforms.includes('tiktok')) {
        // privacy_level: PUBLIC | PRIVATE | FRIENDS — default PUBLIC
        form.append('privacy_level', options.tiktokPrivacy || 'PUBLIC');
        // post_mode: FEED | STORY — default FEED
        form.append('post_mode', postType === 'STORIES' ? 'STORY' : 'FEED');
        form.append('tiktok_title', (text || '').slice(0, 150)); // TikTok limita el título
        // cover_timestamp en ms (thumbnail del video, default 1000ms)
        form.append('cover_timestamp', String(options.coverTimestamp || 1000));
      }

      // --- YouTube ---
      if (platforms.includes('youtube')) {
        form.append('youtube_title', text || '');
        form.append('youtube_description', options.description || text || '');
        // privacyStatus: PUBLIC | UNLISTED | PRIVATE — default PUBLIC
        form.append('privacyStatus', options.youtubePrivacy || 'PUBLIC');
        // categoryId: 22 = People & Blogs (default razonable)
        form.append('categoryId', String(options.youtubeCategoryId || 22));
        if (options.youtubeTags?.length) {
          options.youtubeTags.forEach(tag => form.append('tags[]', tag));
        }
      }

      // --- LinkedIn ---
      if (platforms.includes('linkedin')) {
        if (options.linkedinDescription) form.append('linkedin_description', options.linkedinDescription);
        form.append('visibility', 'PUBLIC');
        if (options.linkedinPageId) form.append('target_linkedin_page_id', options.linkedinPageId);
      }


      // YouTube-specific
      if (platforms.includes('youtube')) {
        form.append('youtube_visibility', options.youtubeOptions?.visibility || 'public');
        if (options.youtubeOptions?.youtubeShortsPost) {
          form.append('youtube_as_shorts', 'true');
        }
        form.append('youtube_title', text || '');
      }

      // TikTok-specific
      if (platforms.includes('tiktok')) {
        form.append('tiktok_title', text || '');
      }
    } else {
      // FOTOS — campo correcto es image[]
      endpoint = '/upload_photos';
      form.append('image[]', mediaUrl);
    }
  }

  // Scheduling — campo correcto es scheduled_date (snake_case, ISO 8601)
  const scheduleDate = options.scheduleDate || options.scheduled_date;
  if (scheduleDate) {
    form.append('scheduled_date', new Date(scheduleDate).toISOString());
    if (options.timezone) form.append('timezone', options.timezone);
  }

  try {
    console.log('📤 [Upload-Post] Publicando en', endpoint);
    console.log('   - User:', userId);
    console.log('   - Platforms:', platforms.join(', '));
    console.log('   - Media:', mediaUrl || 'texto');

    const response = await axios.post(`${UPLOAD_POST_BASE}${endpoint}`, form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Apikey ${process.env.UPLOAD_POST_API_KEY}`
      }
    });

    console.log('✅ Upload-Post Response:', response.data);

    return {
      id: response.data.request_id || response.data.id,
      status: response.data.status,
      details: response.data
    };
  } catch (err) {
    const errorData = err.response?.data;
    console.error('❌ Error al publicar en Upload-Post:', errorData || err.message);
    
    // Si es un error de límite (429) o validación, propagar el mensaje detallado
    if (err.response?.status === 429) {
      if (errorData?.violations) {
        const violation = errorData.violations[0];
        const platform = violation.platform || 'la red social';
        const msg = `Límite diario alcanzado para ${platform}: ${violation.used_last_24h}/${violation.cap}. Por favor, espera unas horas.`;
        const customErr = new Error(msg);
        customErr.status = 429;
        customErr.details = errorData;
        throw customErr;
      }
      
      const remoteMessage = errorData?.message || errorData?.error || "Límite de publicaciones alcanzado.";
      logger.log('error', 'PUBLISH_API_LIMIT', { error: remoteMessage, userId }, null, 'backend');
      const customErr = new Error(`Error de Proveedor (429): ${remoteMessage}`);
      customErr.status = 429;
      customErr.details = errorData;
      throw customErr;
    }

    if (errorData?.message) {
      logger.log('error', 'PUBLISH_API_ERROR', { error: errorData.message, status: err.response?.status, userId }, null, 'backend');
      const msgErr = new Error(errorData.message);
      msgErr.status = err.response?.status;
      throw msgErr;
    }

    logger.log('error', 'PUBLISH_SYSTEM_ERROR', { error: err.message, userId }, null, 'backend');
    throw err;
  }
};

/**
 * Programar una publicación.
 */
exports.schedulePost = async (text, platforms, mediaUrls, scheduleDate, userId, options = {}) => {
  // En Upload-Post, el scheduling se hace enviando 'scheduleDate' en el mismo upload
  const enhancedOptions = {
    ...options,
    scheduleDate: scheduleDate // Formato ISO
  };

  return exports.publishPost(text, platforms, mediaUrls, userId, enhancedOptions);
};

// ============================================================
// 4. ANALÍTICAS
// ============================================================

/**
 * Obtener analíticas de un perfil.
 * @param {string} username - El nombre de usuario del perfil (o ID si aplica).
 * @param {string[]} platforms - Array de plataformas ej: ['instagram', 'tiktok'].
 */
exports.getAnalytics = async (username, platforms, options = {}) => {
  try {
    const params = {
      platforms: platforms.join(',')
    };
    if (options.facebookPageId) {
      params.page_id = options.facebookPageId;
    }

    const response = await axios.get(`${UPLOAD_POST_BASE}/analytics/${username}`, {
      headers: buildHeaders(),
      params
    });

    return response.data;
  } catch (err) {
    console.error('❌ Error al obtener analíticas en Upload-Post:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Obtener perfil completo (incluyendo redes sociales vinculadas).
 */
exports.getProfile = async (username) => {
  try {
    const response = await axios.get(`${UPLOAD_POST_BASE}/uploadposts/users/${username}`, {
      headers: buildHeaders()
    });
    return response.data;
  } catch (error) {
    console.error('❌ Error al obtener perfil en Upload-Post:', error.response?.data || error.message);
    throw error;
  }
};

// ============================================================
// 5. ANALÍTICAS POR POST
// ============================================================

/**
 * Obtener métricas reales de un post publicado (likes, comments, views, shares).
 * @param {string} requestId - El request_id devuelto al publicar.
 */
exports.getPostAnalytics = async (requestId) => {
  try {
    const response = await axios.get(`${UPLOAD_POST_BASE}/uploadposts/post-analytics/${requestId}`, {
      headers: buildHeaders()
    });
    return response.data;
  } catch (err) {
    console.warn('⚠️ No se pudo obtener analytics del post:', err.response?.data || err.message);
    return null;
  }
};

/**
 * Obtener impresiones totales del perfil.
 * @param {string} username - Username del perfil.
 */
exports.getTotalImpressions = async (username) => {
  try {
    const response = await axios.get(`${UPLOAD_POST_BASE}/uploadposts/total-impressions/${username}`, {
      headers: buildHeaders()
    });
    return response.data;
  } catch (err) {
    console.warn('⚠️ No se pudo obtener total-impressions:', err.response?.data || err.message);
    return null;
  }
};

/**
 * Devuelve un array con los nombres de las plataformas vinculadas.
 */
exports.getActivePlatforms = async (username) => {
  try {
    const profileData = await exports.getProfile(username);
    const activePlatforms = [];
    if (profileData.success && profileData.profile.social_accounts) {
      const accounts = profileData.profile.social_accounts;
      Object.keys(accounts).forEach(p => {
        const acc = accounts[p];
        if (acc && (typeof acc === 'object' || (typeof acc === 'string' && acc.trim() !== ''))) {
          activePlatforms.push(p);
        }
      });
    }
    return activePlatforms;
  } catch (err) {
    console.error('❌ Error getActivePlatforms:', err.message);
    return [];
  }
};
