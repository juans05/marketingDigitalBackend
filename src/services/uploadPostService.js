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

const UPLOAD_POST_BASE = 'https://api.upload-post.com/api';

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
 * @returns {Promise<string>} - El ID del usuario creado.
 */
exports.createProfile = async (name) => {
  try {
    console.log("Creating new profile", name);
    const sanitizedUsername = (name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || `artista_${Date.now()}`;
    console.log("Creating new profile", sanitizedUsername);
    const response = await axios.post(`${UPLOAD_POST_BASE}/uploadposts/users`, {
      username: sanitizedUsername
    }, {
      headers: buildHeaders()
    });

    // Según docs, retorna el ID del usuario creado
    return response.data.user_id || response.data.id || sanitizedUsername;
  } catch (err) {
    console.error('❌ Error al crear perfil en Upload-Post:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Generar una URL para que el artista conecte sus redes sociales.
 * @param {string} userId - El ID del usuario/perfil de Upload-Post.
 * @returns {Promise<string>} - URL de conexión (access_url).
 */
exports.generateConnectUrl = async (userId) => {
  try {
    const response = await axios.post(`${UPLOAD_POST_BASE}/uploadposts/users/generate-jwt`, {
      username: userId,
      profile_username: userId // Cubrimos ambos nombres por inconsistencia en la API
    }, {
      headers: buildHeaders()
    });

    return response.data.access_url;
  } catch (err) {
    console.error('❌ Error al generar JWT en Upload-Post:', err.response?.data || err.message);
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

  // Usuario
  form.append('user', userId);

  // Plataformas como array: platform[]=instagram&platform[]=tiktok
  platforms.forEach(p => form.append('platform[]', p));

  // Título / Caption
  form.append('title', text || '');

  // Async upload
  form.append('async_upload', 'true');

  const mediaUrl = mediaUrls[0];
  let endpoint = '/upload_text';

  if (mediaUrl) {
    const isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(mediaUrl) || mediaUrl.includes('/video/');
    if (isVideo) {
      endpoint = '/upload';
      form.append('video', mediaUrl);

      // Tipo de publicación: REELS o STORIES (viene del frontend)
      const mediaType = (options.postType || 'REELS').toUpperCase();

      // Instagram-specific
      if (platforms.includes('instagram')) {
        form.append('media_type', mediaType);
        if (mediaType === 'REELS') form.append('share_to_feed', 'true');
        form.append('instagram_title', text || '');
      }

      // Facebook-specific
      if (platforms.includes('facebook')) {
        form.append('facebook_media_type', mediaType);
        form.append('video_state', 'PUBLISHED');
      }
    } else {
      endpoint = '/upload_photos';
      form.append('photos', mediaUrl);
    }
  }

  // Opciones extra (ej: scheduleDate)
  if (options.scheduleDate) {
    form.append('scheduleDate', options.scheduleDate);
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
    console.error('❌ Error al publicar en Upload-Post:', err.response?.data || err.message);
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
exports.getAnalytics = async (username, platforms) => {
  try {
    const response = await axios.get(`${UPLOAD_POST_BASE}/analytics/${username}`, {
      headers: buildHeaders(),
      params: {
        platforms: platforms.join(',')
      }
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
        if (Array.isArray(accounts[p]) && accounts[p].length > 0) activePlatforms.push(p);
      });
    }
    return activePlatforms;
  } catch (err) {
    console.error('❌ Error getActivePlatforms:', err.message);
    return [];
  }
};
