/**
 * AYRSHARE SERVICE - Vidalis.AI
 * 
 * Servicio centralizado para la API de Ayrshare.
 * Maneja: Publicación, Perfiles, Plataformas Activas y Analíticas.
 * 
 * Cada agencia tiene su propio profileKey para aislar sus redes sociales.
 * 
 * Base URL: https://api.ayrshare.com/api
 * Auth: Bearer API_KEY (header) + Profile-Key (header para multi-tenant)
 */

const axios = require('axios');

const AYRSHARE_BASE = 'https://api.ayrshare.com/api';

/**
 * Helper: Construye los headers de Ayrshare.
 * Si la agencia tiene profileKey, se añade para aislar sus publicaciones.
 */
function buildHeaders(profileKey = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.AYRSHARE_API_KEY}`
  };

  if (profileKey) {
    headers['Profile-Key'] = profileKey;
  }

  return headers;
}

// ============================================================
// 1. PERFILES (Multi-Agencia)
// ============================================================

/**
 * Crear un perfil para una nueva agencia.
 * Cada agencia necesita su propio perfil en Ayrshare.
 * Devuelve el profileKey que se guarda en nuestra DB.
 */
exports.createProfile = async (title) => {
  // Reintento automático — Ayrshare devuelve "Transaction already closed"
  // cuando hay una carrera de condiciones en su DB (Prisma interno).
  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(`${AYRSHARE_BASE}/profiles/profile`, {
        title: title
      }, {
        headers: buildHeaders()
      });

      return {
        profileKey: response.data.profileKey,
        title: response.data.title
      };
    } catch (err) {
      lastError = err;
      const msg = err.response?.data?.message || err.message || '';

      // Si el perfil ya existe, buscarlo en la lista en vez de fallar
      if (err.response?.status === 400 && msg.toLowerCase().includes('already')) {
        const profiles = await axios.get(`${AYRSHARE_BASE}/profiles`, {
          headers: buildHeaders()
        });
        const existing = (profiles.data.profiles || []).find(p => p.title === title);
        if (existing) {
          return { profileKey: existing.profileKey, title: existing.title };
        }
      }

      // "Transaction already closed" — esperar y reintentar
      const isTransactionError = msg.toLowerCase().includes('transaction') ||
        msg.toLowerCase().includes('prisma');
      if (isTransactionError && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, attempt * 500)); // 500ms, 1000ms
        continue;
      }

      throw err;
    }
  }

  throw lastError;
};

/**
 * Eliminar un perfil de agencia.
 */
exports.deleteProfile = async (profileKey) => {
  const response = await axios.delete(`${AYRSHARE_BASE}/profiles/profile`, {
    headers: buildHeaders(),
    data: { profileKey }
  });
  return response.data;
};

/**
 * Generar un JWT token para que la agencia vincule sus redes sociales
 * directamente desde nuestra web (SSO - Single Sign On).
 */
exports.generateJWT = async (profileKey) => {
  const body = { profileKey };
  if (process.env.AYRSHARE_PRIVATE_KEY) {
    body.privateKey = process.env.AYRSHARE_PRIVATE_KEY;
  }
  if (process.env.AYRSHARE_DOMAIN) {
    body.domain = process.env.AYRSHARE_DOMAIN;
  }
  console.error("profileKey", profileKey);
  const response = await axios.post(`${AYRSHARE_BASE}/profiles/generateJWT`, body, {
    headers: buildHeaders()
  });
  return response.data; // { url: "https://..." } ← URL para vincular redes
};

// ============================================================
// 2. PLATAFORMAS ACTIVAS
// ============================================================

/**
 * Obtener las redes sociales vinculadas de una agencia.
 * Devuelve cuáles están activas (ej: ["tiktok", "instagram"]).
 */
exports.getActivePlatforms = async (profileKey = null) => {
  const response = await axios.get(`${AYRSHARE_BASE}/user`, {
    headers: buildHeaders(profileKey)
  });

  // Ayrshare devuelve un objeto con las redes conectadas
  const user = response.data;
  const platforms = [];

  if (user.activeSocialAccounts) {
    return user.activeSocialAccounts; // Array directo
  }

  // Fallback: revisar campos individuales
  const socialNetworks = ['facebook', 'instagram', 'tiktok', 'youtube', 'twitter', 'linkedin', 'pinterest', 'reddit', 'telegram'];
  socialNetworks.forEach((network) => {
    if (user[network] && user[network].connected) {
      platforms.push(network);
    }
  });

  return platforms;
};

// ============================================================
// 3. PUBLICACIÓN
// ============================================================

/**
 * Publicar contenido en las redes de una agencia.
 * Soporta videos, hashtags y opciones específicas por plataforma.
 *
 * @param {string} text        - Texto del post. Incluir hashtags aquí: "Mi video #música #viral"
 * @param {string[]} platforms - Redes destino ["facebook", "instagram", "tiktok", "youtube"]
 * @param {string[]} mediaUrls - URLs públicas de videos/imágenes (Cloudinary)
 * @param {string} profileKey  - Perfil de la agencia en Ayrshare
 * @param {object} options     - Opciones avanzadas por plataforma (ver abajo)
 * @param {boolean} isPreview  - true = simula sin publicar realmente
 *
 * Ejemplo de options:
 * {
 *   facebookOptions: { title: "Mi video", type: "VIDEO" },
 *   instagramOptions: { reels: true },
 *   tiktokOptions: { videoTitle: "Mi video #viral", disableDuet: false },
 *   youtubeOptions: { title: "Mi video", visibility: "public", youtubeShortsPost: true }
 * }
 */
exports.publishPost = async (text, platforms, mediaUrls = [], profileKey = null, options = {}, isPreview = false) => {
  const body = {
    post: text,
    platforms: platforms
  };

  if (mediaUrls && mediaUrls.length > 0) {
    body.mediaUrls = mediaUrls;
  }

  if (isPreview) {
    body.isPreview = true;
  }

  // Opciones específicas por plataforma
  if (options.facebookOptions) body.facebookOptions = options.facebookOptions;
  if (options.instagramOptions) body.instagramOptions = options.instagramOptions;
  if (options.tiktokOptions) body.tiktokOptions = options.tiktokOptions;
  if (options.youtubeOptions) body.youtubeOptions = options.youtubeOptions;
  if (options.linkedinOptions) body.linkedinOptions = options.linkedinOptions;
  if (options.twitterOptions) body.twitterOptions = options.twitterOptions;
  console.log('⚙️ Opciones de body:', JSON.stringify(body, null, 2));
  
  try {
    const response = await axios.post(`${AYRSHARE_BASE}/post`, body, {
      headers: buildHeaders(profileKey)
    });
    console.log('✅ Ayrshare Response:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Ayrshare Error (Detailed):', JSON.stringify(error.response?.data || error.message, null, 2));
    throw error;
  }
};

/**
 * Programar una publicación para una fecha futura.
 */
exports.schedulePost = async (text, platforms, mediaUrls, scheduleDate, profileKey = null, options = {}) => {
  const body = {
    post: text,
    platforms: platforms,
    mediaUrls: mediaUrls,
    scheduleDate: scheduleDate // Formato ISO: "2026-03-20T15:00:00Z"
  };
  console.log("schedulePost", body);
  if (options.instagramOptions) body.instagramOptions = options.instagramOptions;
  if (options.tiktokOptions) body.tiktokOptions = options.tiktokOptions;
  if (options.youtubeOptions) body.youtubeOptions = options.youtubeOptions;
  if (options.facebookOptions) body.facebookOptions = options.facebookOptions;

  const response = await axios.post(`${AYRSHARE_BASE}/post`, body, {
    headers: buildHeaders(profileKey)
  });
  console.log("response", response);
  return response.data;
};

/**
 * Eliminar una publicación.
 */
exports.deletePost = async (postId, profileKey = null) => {
  const response = await axios.delete(`${AYRSHARE_BASE}/post`, {
    headers: buildHeaders(profileKey),
    data: { id: postId }
  });
  return response.data;
};

/**
 * Obtener historial de publicaciones.
 */
exports.getPostHistory = async (profileKey = null, limit = 20) => {
  const response = await axios.get(`${AYRSHARE_BASE}/history`, {
    headers: buildHeaders(profileKey),
    params: { lastRecords: limit }
  });
  return response.data;
};

// ============================================================
// 4. ANALÍTICAS
// ============================================================

/**
 * Obtener analíticas de una publicación específica.
 */
exports.getPostAnalytics = async (postId, platforms, profileKey = null) => {
  const response = await axios.post(`${AYRSHARE_BASE}/analytics/post`, {
    id: postId,
    platforms: platforms
  }, {
    headers: buildHeaders(profileKey)
  });
  return response.data;
};

/**
 * Obtener analíticas generales de las cuentas sociales.
 */
exports.getAccountAnalytics = async (platforms, profileKey = null) => {
  const response = await axios.post(`${AYRSHARE_BASE}/analytics/social`, {
    platforms: platforms
  }, {
    headers: buildHeaders(profileKey)
  });
  return response.data;
};

// ============================================================
// 5. COMENTARIOS
// ============================================================

/**
 * Obtener comentarios de una publicación.
 */
exports.getComments = async (postId, profileKey = null) => {
  const response = await axios.get(`${AYRSHARE_BASE}/comments`, {
    headers: buildHeaders(profileKey),
    params: { id: postId }
  });
  return response.data;
};

/**
 * Responder a un comentario.
 */
exports.replyToComment = async (commentId, text, platforms, profileKey = null) => {
  const response = await axios.post(`${AYRSHARE_BASE}/comments`, {
    id: commentId,
    platforms: platforms,
    comment: text
  }, {
    headers: buildHeaders(profileKey)
  });
  return response.data;
};

// ============================================================
// 6. MEDIA (Librería de Videos/Imágenes)
// ============================================================
// FIN DEL SERVICIO
// ============================================================
