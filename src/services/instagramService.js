/**
 * INSTAGRAM / FACEBOOK SERVICE — Vidalis.AI
 *
 * Publicación directa vía Meta Graph API.
 * Cada artista tiene su propio access_token guardado en la tabla artists.
 *
 * Flujo de publicación Instagram:
 *   1. POST /{ig_user_id}/media   → crea container → devuelve container_id
 *   2. Esperar status FINISHED    (solo videos/reels)
 *   3. POST /{ig_user_id}/media_publish → publica → devuelve post_id
 *
 * Flujo OAuth (conectar cuenta):
 *   1. Redirigir a getAuthUrl()
 *   2. Meta callback → handleCallback() → guarda token en DB
 */

const axios = require('axios');

const GRAPH_BASE = 'https://graph.instagram.com/v21.0';
const FB_GRAPH   = 'https://graph.facebook.com/v21.0';

// ============================================================
// 1. OAUTH — Conectar cuenta del artista
// ============================================================

/**
 * Genera la URL de autorización OAuth de Meta.
 * El artista hace clic → autoriza en Facebook/Instagram → Meta redirige al callback.
 *
 * Requiere en Railway:
 *   META_APP_ID        — App ID de tu app en developers.facebook.com
 *   META_APP_SECRET    — App Secret
 *   META_REDIRECT_URI  — ej: https://tu-backend.railway.app/api/vidalis/instagram/callback
 */
exports.getAuthUrl = (artistId) => {
  const appId       = process.env.META_APP_ID;
  const redirectUri = encodeURIComponent(process.env.META_REDIRECT_URI || '');
  const scope       = 'instagram_business_basic,instagram_business_content_publish,pages_read_engagement,pages_show_list';
  const state       = Buffer.from(JSON.stringify({ artistId })).toString('base64');

  return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&response_type=code`;
};

/**
 * Maneja el callback de Meta después del OAuth.
 * Intercambia el code por un access_token de larga duración y guarda en DB.
 */
exports.handleCallback = async (code, artistId, supabase) => {
  const appId       = process.env.META_APP_ID;
  const appSecret   = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;

  // 1. Intercambiar code por short-lived token
  const tokenRes = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }
  });
  const shortToken = tokenRes.data.access_token;

  // 2. Convertir a long-lived token (60 días)
  const longRes = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
    params: {
      grant_type:        'fb_exchange_token',
      client_id:         appId,
      client_secret:     appSecret,
      fb_exchange_token: shortToken
    }
  });
  const longToken   = longRes.data.access_token;
  const expiresIn   = longRes.data.expires_in; // segundos

  // 3. Obtener Instagram User ID vinculado
  const meRes = await axios.get(`${GRAPH_BASE}/me`, {
    params: { fields: 'id,username', access_token: longToken }
  });
  const instagramUserId = meRes.data.id;

  // 4. Guardar en DB
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const { error } = await supabase.from('artists').update({
    instagram_user_id:          instagramUserId,
    instagram_access_token:     longToken,
    instagram_token_expires_at: expiresAt,
    active_platforms:           ['instagram'],
    publish_mode:               'direct'
  }).eq('id', artistId);

  if (error) throw new Error(`Error guardando token: ${error.message}`);

  return { instagramUserId, expiresAt };
};

// ============================================================
// 2. PUBLICACIÓN INSTAGRAM
// ============================================================

/**
 * Espera hasta que el container de Instagram esté FINISHED.
 * Reintenta hasta 10 veces cada 3 segundos (30 segundos máximo).
 */
async function waitForContainer(containerId, token) {
  for (let i = 0; i < 10; i++) {
    const res = await axios.get(`${GRAPH_BASE}/${containerId}`, {
      params: { fields: 'status_code', access_token: token }
    });
    const status = res.data.status_code;
    if (status === 'FINISHED') return;
    if (status === 'ERROR')    throw new Error('Container Instagram falló: ERROR');
    if (status === 'EXPIRED')  throw new Error('Container Instagram expirado');
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Timeout esperando container de Instagram');
}

/**
 * Publica o programa en Instagram.
 *
 * @param {object} artist    - Fila de artists con instagram_user_id e instagram_access_token
 * @param {string} caption   - Texto/hashtags del post
 * @param {string} mediaUrl  - URL pública de Cloudinary (imagen JPEG o video MP4)
 * @param {boolean} isVideo  - true si es video/reel
 * @param {string|null} scheduleAt - ISO string para programar, null = publicar ahora
 */
exports.publishToInstagram = async (artist, caption, mediaUrl, isVideo = false, scheduleAt = null) => {
  const { instagram_user_id: igId, instagram_access_token: token } = artist;
  if (!igId || !token)   throw new Error('Artista sin cuenta Instagram conectada');

  // 1. Crear container
  const containerParams = {
    caption,
    access_token: token
  };

  if (isVideo) {
    containerParams.media_type = 'REELS';
    containerParams.video_url  = mediaUrl;
  } else {
    containerParams.image_url  = mediaUrl;
  }

  // Programar: agregar published=false y publish_time (Unix timestamp)
  if (scheduleAt) {
    containerParams.published    = false;
    containerParams.publish_time = Math.floor(new Date(scheduleAt).getTime() / 1000);
  }

  const containerRes = await axios.post(`${GRAPH_BASE}/${igId}/media`, null, {
    params: containerParams
  });
  const containerId = containerRes.data.id;

  // 2. Esperar si es video
  if (isVideo) await waitForContainer(containerId, token);

  // 3. Publicar (o encolar si es programado)
  const publishRes = await axios.post(`${GRAPH_BASE}/${igId}/media_publish`, null, {
    params: { creation_id: containerId, access_token: token }
  });

  return { id: publishRes.data.id, containerId };
};

// ============================================================
// 3. PUBLICACIÓN FACEBOOK PAGE
// ============================================================

/**
 * Publica en una página de Facebook.
 * Requiere facebook_page_id y facebook_access_token del artista.
 */
exports.publishToFacebook = async (artist, message, mediaUrl, isVideo = false, scheduleAt = null) => {
  const { facebook_page_id: pageId, facebook_access_token: token } = artist;
  if (!pageId || !token) throw new Error('Artista sin página Facebook conectada');

  const params = { access_token: token };

  if (scheduleAt) {
    params.published          = false;
    params.scheduled_publish_time = Math.floor(new Date(scheduleAt).getTime() / 1000);
  }

  let res;
  if (isVideo) {
    res = await axios.post(`${FB_GRAPH}/${pageId}/videos`, null, {
      params: { ...params, description: message, file_url: mediaUrl }
    });
  } else {
    res = await axios.post(`${FB_GRAPH}/${pageId}/photos`, null, {
      params: { ...params, message, url: mediaUrl }
    });
  }

  return { id: res.data.id };
};

// ============================================================
// 4. PLATAFORMAS ACTIVAS (para modo directo)
// ============================================================

/**
 * Obtiene el historial de publicaciones del artista directamente de Instagram.
 * Se usa para la Auditoría Profunda.
 */
exports.getMediaHistory = async (artist, limit = 20) => {
  const { instagram_user_id: igId, instagram_access_token: token } = artist;
  if (!igId || !token) throw new Error('Artista sin cuenta Instagram conectada');

  try {
    const res = await axios.get(`${GRAPH_BASE}/${igId}/media`, {
      params: {
        fields: 'id,caption,media_type,media_url,timestamp,like_count,comments_count,permalink',
        access_token: token,
        limit
      }
    });

    return res.data.data || [];
  } catch (err) {
    console.error('❌ Error getMediaHistory:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Retorna qué plataformas tiene conectadas el artista en modo directo.
 */
exports.getActivePlatforms = (artist) => {
  const platforms = [];
  if (artist.instagram_user_id && artist.instagram_access_token) platforms.push('instagram');
  if (artist.facebook_page_id  && artist.facebook_access_token)  platforms.push('facebook');
  return platforms;
};
