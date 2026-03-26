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
    const sanitizedUsername = name.trim().replace(/[^a-zA-Z0-9@_-]/g, '_');
    const response = await axios.post(`${UPLOAD_POST_BASE}/uploadposts/users`, {
      username: sanitizedUsername
    }, {
      headers: buildHeaders()
    });

    // Según docs, retorna el ID del usuario creado
    return response.data.user_id || response.data.id;
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
      user: userId
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
 * Detecta automáticamente si es video, foto o texto.
 */
exports.publishPost = async (text, platforms, mediaUrls = [], userId, options = {}) => {
  const mediaUrl = mediaUrls[0];
  let endpoint = '/upload_text';
  const payload = {
    user: userId,
    platform: platforms,
    title: text, // En Upload-Post, 'title' suele ser el caption
    ...options
  };

  if (mediaUrl) {
    const isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(mediaUrl) || mediaUrl.includes('/video/');
    if (isVideo) {
      endpoint = '/upload';
      payload.video = mediaUrl;
    } else {
      endpoint = '/upload_photos';
      payload.photos = [mediaUrl];
    }
  }

  try {
    const response = await axios.post(`${UPLOAD_POST_BASE}${endpoint}`, payload, {
      headers: buildHeaders()
    });
    
    console.log('✅ Upload-Post Response:', response.data);
    
    // Retornamos un formato compatible con lo que espera el resto del sistema
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
