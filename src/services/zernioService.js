const axios = require('axios');
const logger = require('./loggerService');

const BASE_URL = 'https://zernio.com/api/v1';

function createAxiosInstance() {
  const instance = axios.create({
    baseURL: BASE_URL,
    headers: {
      'Authorization': `Bearer ${process.env.ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  let retryCount = 0;
  instance.interceptors.response.use(
    (response) => {
      retryCount = 0;
      return response;
    },
    async (error) => {
      const config = error.config;
      if (!config || config.__isRetry) {
        return Promise.reject(error);
      }

      const status = error.response?.status;
      const isRetryable = !status || (status >= 500 && status <= 599) || status === 429 || !error.response;

      if (!isRetryable || retryCount >= 3) {
        retryCount = 0;
        return Promise.reject(error);
      }

      retryCount++;
      config.__isRetry = true;

      let delay = Math.min(1000 * Math.pow(2, retryCount - 1) + Math.random() * 1000, 10000);

      if (status === 429 && error.response?.headers?.['retry-after']) {
        delay = parseInt(error.response.headers['retry-after'], 10) * 1000;
      }

      logger.info('ZERNIO_RETRY', {
        attempt: retryCount,
        endpoint: config.url,
        status,
        delay,
      });

      await new Promise(resolve => setTimeout(resolve, delay));
      return instance(config);
    }
  );

  return instance;
}

const api = createAxiosInstance();

// Zernio devuelve IDs de perfil como ObjectId de Mongo (24 hex), no con prefijo 'prof_'
const isZernioProfile = (key) => typeof key === 'string' && /^[a-f0-9]{24}$/i.test(key);

// ========== A. Perfiles y Conexión OAuth ==========

async function createProfile(name, artistId) {
  try {
    const { data } = await api.post('/profiles', {
      name,
      description: `Vidalis.AI Artist ID: ${artistId}`,
    });
    return data.profile?._id || data._id;
  } catch (error) {
    logger.error('ZERNIO_createProfile', {
      artistId,
      status: error.response?.status,
      responseData: error.response?.data || error.message,
    });
    throw new Error(`Error creando perfil Zernio: ${error.response?.data?.message || error.message}`);
  }
}

async function generateConnectUrl(profileId, platform) {
  try {
    const { data } = await api.get(`/connect/${platform}`, {
      params: { profileId },
    });
    return data;
  } catch (error) {
    logger.error('ZERNIO_generateConnectUrl', {
      profileId,
      platform,
      status: error.response?.status,
      responseData: error.response?.data || error.message,
    });
    throw new Error(`Error generando URL de conexión Zernio: ${error.response?.data?.message || error.message}`);
  }
}

async function getActivePlatforms(profileId) {
  try {
    const { data } = await api.get('/accounts', {
      params: { profileId },
    });

    const accounts = Array.isArray(data) ? data : data?.accounts || data?.data || [];
    const ALLOWED = ['instagram', 'tiktok', 'facebook', 'youtube'];

    return accounts
      .filter(acc => ALLOWED.includes(acc.platform))
      .map(acc => ({
        platform: acc.platform,
        username: acc.username || acc.name || '',
        accountId: acc.accountId || acc.id || acc._id || '',
      }));
  } catch (error) {
    logger.error('ZERNIO_getActivePlatforms', {
      profileId,
      status: error.response?.status,
      responseData: error.response?.data || error.message,
    });
    throw new Error(`Error obteniendo plataformas activas: ${error.response?.data?.message || error.message}`);
  }
}

// ========== B. Publicación y Programación ==========

function detectMediaType(url) {
  return url.includes('/video/') || /\.(mp4|mov|webm|ogv)(\?|$)/i.test(url) ? 'video' : 'image';
}

// Builds a platform entry with platformSpecificData nested inside (Zernio API requirement).
// TikTok is excluded here — it uses a top-level tiktokSettings object instead.
function buildPlatformEntry(platform, accountId, hasVideo, options) {
  const entry = { platform, accountId };
  const psd = {};

  if (platform === 'instagram') {
    if (options.contentType) psd.contentType = options.contentType; // 'story' | 'reels'
    if (options.shareToFeed !== undefined) psd.shareToFeed = options.shareToFeed;
  }

  if (platform === 'facebook') {
    const fbContentType = options.contentType || (hasVideo ? 'reel' : null);
    if (fbContentType) psd.contentType = fbContentType;
    if (options.title) psd.title = options.title;
  }

  if (platform === 'youtube') {
    psd.title = (options.title || '').slice(0, 100) || 'Video';
    psd.visibility = options.visibility || 'public';
  }

  if (Object.keys(psd).length > 0) entry.platformSpecificData = psd;
  return entry;
}

async function publishPost(text, platforms, mediaUrls, profileId, options = {}) {
  const accounts = options.accounts || {};
  const urls = mediaUrls || [];
  const hasVideo = urls.some(url => detectMediaType(url) === 'video');

  const resolved = platforms
    .filter(p => accounts[p])
    .map(p => buildPlatformEntry(p, accounts[p], hasVideo, options));

  if (resolved.length === 0) {
    throw new Error('Ninguna de las plataformas solicitadas tiene una cuenta de Zernio conectada (social_keys vacío o desactualizado).');
  }

  // Zernio requires mediaItems as [{type, url}] objects, not a plain URL array
  const mediaItems = urls.map(url => ({ type: detectMediaType(url), url }));

  const payload = {
    content: text,
    publishNow: true,
    platforms: resolved,
  };

  if (mediaItems.length > 0) payload.mediaItems = mediaItems;

  // TikTok uses a top-level tiktokSettings key (snake_case), not platformSpecificData
  if (platforms.includes('tiktok') && accounts['tiktok']) {
    payload.tiktokSettings = {
      privacy_level: 'PUBLIC_TO_EVERYONE',
      allow_comment: true,
      allow_duet: hasVideo,
      allow_stitch: hasVideo,
      content_preview_confirmed: true, // legally required by TikTok API
      express_consent_given: true,     // legally required by TikTok API
    };
  }

  console.log('[ZERNIO] publishPost REQUEST', JSON.stringify({ profileId, platforms, mediaUrls, payload }, null, 2));

  try {
    const response = await api.post('/posts', payload);
    console.log('[ZERNIO] publishPost RESPONSE', JSON.stringify({ httpStatus: response.status, data: response.data }, null, 2));
    const { data } = response;
    return { id: data.post?._id || data._id || data.id, status: data.post?.status || data.status };
  } catch (error) {
    const zernioData = error.response?.data;
    console.error('[ZERNIO] publishPost ERROR', JSON.stringify({
      httpStatus: error.response?.status,
      payloadSent: payload,
      responseData: zernioData,
    }, null, 2));
    const err = new Error(`Error publicando post en Zernio: ${zernioData?.message || error.message}`);
    err.details = zernioData;
    err.status = error.response?.status;
    throw err;
  }
}

async function schedulePost(text, platforms, mediaUrls, scheduleDate, profileId, options = {}) {
  const accounts = options.accounts || {};
  const urls = mediaUrls || [];
  const hasVideo = urls.some(url => detectMediaType(url) === 'video');

  const resolved = platforms
    .filter(p => accounts[p])
    .map(p => buildPlatformEntry(p, accounts[p], hasVideo, options));

  if (resolved.length === 0) {
    throw new Error('Ninguna de las plataformas solicitadas tiene una cuenta de Zernio conectada.');
  }

  // Zernio requires mediaItems as [{type, url}] objects, not a plain URL array
  const mediaItems = urls.map(url => ({ type: detectMediaType(url), url }));

  const payload = {
    content: text,
    platforms: resolved,
    scheduledFor: new Date(scheduleDate).toISOString(),
    timezone: 'UTC',
  };

  if (mediaItems.length > 0) payload.mediaItems = mediaItems;

  // TikTok uses a top-level tiktokSettings key (snake_case), not platformSpecificData
  if (platforms.includes('tiktok') && accounts['tiktok']) {
    payload.tiktokSettings = {
      privacy_level: 'PUBLIC_TO_EVERYONE',
      allow_comment: true,
      allow_duet: hasVideo,
      allow_stitch: hasVideo,
      content_preview_confirmed: true,
      express_consent_given: true,
    };
  }

  console.log('[ZERNIO] schedulePost REQUEST', JSON.stringify({ profileId, platforms, mediaUrls, scheduleDate, payload }, null, 2));

  try {
    const response = await api.post('/posts', payload);
    console.log('[ZERNIO] schedulePost RESPONSE', JSON.stringify({ httpStatus: response.status, data: response.data }, null, 2));
    const { data } = response;
    return { id: data.post?._id || data._id || data.id, status: data.post?.status || data.status };
  } catch (error) {
    const zernioData = error.response?.data;
    console.error('[ZERNIO] schedulePost ERROR', JSON.stringify({
      httpStatus: error.response?.status,
      payloadSent: payload,
      responseData: zernioData,
    }, null, 2));
    const err = new Error(`Error programando post en Zernio: ${zernioData?.message || error.message}`);
    err.details = zernioData;
    err.status = error.response?.status;
    throw err;
  }
}

async function getPostStatus(postId) {
  try {
    const { data } = await api.get(`/posts/${postId}`);
    return data.post?.status || data.status;
  } catch (error) {
    logger.error('ZERNIO_getPostStatus', {
      postId,
      status: error.response?.status,
    });
    throw new Error(`Error obteniendo estado del post: ${error.response?.data?.message || error.message}`);
  }
}

async function getPostAnalytics(postId) {
  try {
    const { data } = await api.get(`/analytics/posts`, {
      params: { postId },
    });
    return data;
  } catch (error) {
    logger.error('ZERNIO_getPostAnalytics', { postId, status: error.response?.status });
    return null;
  }
}

// GET /v1/analytics — lista de posts con sus métricas
async function getAnalyticsPosts(profileId, fromDate, toDate, limit = 100) {
  try {
    const { data } = await api.get('/analytics', {
      params: { profileId, fromDate, toDate, limit, sortBy: 'engagement', order: 'desc' },
    });
    return data;
  } catch (error) {
    logger.error('ZERNIO_getAnalyticsPosts', { profileId, status: error.response?.status, msg: error.response?.data?.message });
    return null;
  }
}

// GET /v1/analytics/daily-metrics — métricas diarias + platformBreakdown
async function getDailyMetrics(profileId, fromDate, toDate) {
  try {
    const { data } = await api.get('/analytics/daily-metrics', {
      params: { profileId, fromDate, toDate },
    });
    return data;
  } catch (error) {
    logger.error('ZERNIO_getDailyMetrics', { profileId, status: error.response?.status, msg: error.response?.data?.message });
    return null;
  }
}

// GET /v1/analytics/best-time — mejor hora/día para publicar
async function getBestPostingTimes(profileId, platform = null) {
  try {
    const params = { profileId };
    if (platform) params.platform = platform;
    const { data } = await api.get('/analytics/best-time', { params });
    return data;
  } catch (error) {
    logger.error('ZERNIO_getBestPostingTimes', { profileId, status: error.response?.status });
    return null;
  }
}

// GET /v1/analytics/instagram/account-insights — métricas de cuenta Instagram
async function getInstagramAccountInsights(accountId, since, until) {
  try {
    const { data } = await api.get('/analytics/instagram/account-insights', {
      params: {
        accountId, since, until,
        metrics: 'reach,views,accounts_engaged,total_interactions,likes,saves,shares,follows_and_unfollows',
      },
    });
    return data;
  } catch (error) {
    logger.error('ZERNIO_getInstagramInsights', { accountId, status: error.response?.status });
    return null;
  }
}

// GET /v1/analytics/youtube/channel-insights — métricas de canal YouTube
async function getYouTubeChannelInsights(accountId, since, until) {
  try {
    const { data } = await api.get('/analytics/youtube/channel-insights', {
      params: {
        accountId, since, until,
        metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost',
        metricType: 'total_value',
      },
    });
    return data;
  } catch (error) {
    logger.error('ZERNIO_getYouTubeInsights', { accountId, status: error.response?.status });
    return null;
  }
}

// ========== C. Bandeja de Entrada y Comentarios ==========

async function getProfileComments(profileId, limit = 20, cursor = null, platform = null) {
  try {
    const params = { profileId, limit };
    if (cursor) params.cursor = cursor;
    if (platform) params.platform = platform;

    const { data } = await api.get('/inbox/comments', { params });
    return data;
  } catch (error) {
    logger.error('ZERNIO_getProfileComments', {
      profileId,
      status: error.response?.status,
    });
    throw new Error(`Error obteniendo comentarios: ${error.response?.data?.message || error.message}`);
  }
}

async function getPostComments(postId, accountId, limit = 50, cursor = null) {
  try {
    const params = { accountId, limit };
    if (cursor) params.cursor = cursor;

    const { data } = await api.get(`/inbox/comments/${postId}`, { params });
    return data;
  } catch (error) {
    logger.error('ZERNIO_getPostComments', {
      postId,
      status: error.response?.status,
    });
    throw new Error(`Error obteniendo comentarios del post: ${error.response?.data?.message || error.message}`);
  }
}

async function postCommentReply(postId, accountId, message, commentId = null) {
  try {
    const payload = { accountId, message };
    if (commentId) payload.commentId = commentId;

    const { data } = await api.post(`/inbox/comments/${postId}`, payload);
    return data;
  } catch (error) {
    logger.error('ZERNIO_postCommentReply', {
      postId,
      status: error.response?.status,
    });
    throw new Error(`Error respondiendo comentario: ${error.response?.data?.message || error.message}`);
  }
}

async function sendPrivateReply(postId, commentId, accountId, message, buttons = [], quickReplies = []) {
  try {
    const payload = {
      accountId,
      message,
    };
    if (buttons.length > 0) payload.buttons = buttons.slice(0, 3);
    if (quickReplies.length > 0) payload.quickReplies = quickReplies.slice(0, 13);

    const { data } = await api.post(`/inbox/comments/${postId}/${commentId}/private-reply`, payload);
    return data;
  } catch (error) {
    logger.error('ZERNIO_sendPrivateReply', {
      postId,
      commentId,
      status: error.response?.status,
    });
    throw new Error(`Error enviando mensaje privado: ${error.response?.data?.message || error.message}`);
  }
}

async function hideComment(postId, commentId, accountId, hide = true) {
  try {
    if (hide) {
      const { data } = await api.post(`/inbox/comments/${postId}/${commentId}/hide`, { accountId });
      return data;
    } else {
      const { data } = await api.delete(`/inbox/comments/${postId}/${commentId}/hide`, {
        params: { accountId },
      });
      return data;
    }
  } catch (error) {
    logger.error('ZERNIO_hideComment', {
      postId,
      commentId,
      hide,
      status: error.response?.status,
    });
    throw new Error(`Error ocultando/mostrando comentario: ${error.response?.data?.message || error.message}`);
  }
}

async function likeComment(postId, commentId, accountId, like = true, cid = null) {
  try {
    if (like) {
      const payload = { accountId };
      if (cid) payload.cid = cid;
      const { data } = await api.post(`/inbox/comments/${postId}/${commentId}/like`, payload);
      return data;
    } else {
      const { data } = await api.delete(`/inbox/comments/${postId}/${commentId}/like`, {
        params: { accountId },
      });
      return data;
    }
  } catch (error) {
    logger.error('ZERNIO_likeComment', {
      postId,
      commentId,
      like,
      status: error.response?.status,
    });
    throw new Error(`Error dando/quitando like: ${error.response?.data?.message || error.message}`);
  }
}

async function deleteComment(postId, commentId, accountId) {
  try {
    const { data } = await api.delete(`/inbox/comments/${postId}`, {
      params: { accountId, commentId },
    });
    return data;
  } catch (error) {
    logger.error('ZERNIO_deleteComment', {
      postId,
      commentId,
      status: error.response?.status,
    });
    throw new Error(`Error eliminando comentario: ${error.response?.data?.message || error.message}`);
  }
}

// ========== D. Automatizaciones Comment-to-DM ==========

async function createCommentAutomation(profileId, accountId, autoData) {
  try {
    const payload = {
      profileId,
      accountId,
      trigger: autoData.trigger || 'comment',
      name: autoData.name || 'Automation',
      keywords: autoData.keywords || [],
      matchMode: autoData.matchMode || 'contains',
      dmMessage: autoData.dmMessage || '',
      commentReply: autoData.commentReply || '',
      buttons: autoData.buttons || [],
      linkTracking: autoData.linkTracking !== undefined ? autoData.linkTracking : true,
    };
    if (autoData.platformPostId) payload.platformPostId = autoData.platformPostId;
    if (autoData.postId) payload.postId = autoData.postId;

    const { data } = await api.post('/comment-automations', payload);
    return data;
  } catch (error) {
    logger.error('ZERNIO_createCommentAutomation', {
      profileId,
      accountId,
      status: error.response?.status,
    });
    throw new Error(`Error creando automatización: ${error.response?.data?.message || error.message}`);
  }
}

async function listCommentAutomations(profileId) {
  try {
    const { data } = await api.get('/comment-automations', {
      params: { profileId },
    });
    return data;
  } catch (error) {
    logger.error('ZERNIO_listCommentAutomations', {
      profileId,
      status: error.response?.status,
    });
    throw new Error(`Error listando automatizaciones: ${error.response?.data?.message || error.message}`);
  }
}

async function getCommentAutomationDetails(automationId) {
  try {
    const { data } = await api.get(`/comment-automations/${automationId}`);
    return data;
  } catch (error) {
    logger.error('ZERNIO_getCommentAutomationDetails', {
      automationId,
      status: error.response?.status,
    });
    throw new Error(`Error obteniendo detalle de automatización: ${error.response?.data?.message || error.message}`);
  }
}

async function updateCommentAutomation(automationId, updateData) {
  try {
    const { data } = await api.patch(`/comment-automations/${automationId}`, updateData);
    return data;
  } catch (error) {
    logger.error('ZERNIO_updateCommentAutomation', {
      automationId,
      status: error.response?.status,
    });
    throw new Error(`Error actualizando automatización: ${error.response?.data?.message || error.message}`);
  }
}

async function deleteCommentAutomation(automationId) {
  try {
    const { data } = await api.delete(`/comment-automations/${automationId}`);
    return data;
  } catch (error) {
    logger.error('ZERNIO_deleteCommentAutomation', {
      automationId,
      status: error.response?.status,
    });
    throw new Error(`Error eliminando automatización: ${error.response?.data?.message || error.message}`);
  }
}

// ========== E. Limpieza de perfiles (para tests) ==========

async function deleteProfile(profileId) {
  try {
    const { data } = await api.delete(`/profiles/${profileId}`);
    return data;
  } catch (error) {
    logger.error('ZERNIO_deleteProfile', {
      profileId,
      status: error.response?.status,
    });
    throw new Error(`Error eliminando perfil: ${error.response?.data?.message || error.message}`);
  }
}

module.exports = {
  isZernioProfile,
  createProfile,
  generateConnectUrl,
  getActivePlatforms,
  publishPost,
  schedulePost,
  getPostStatus,
  getPostAnalytics,
  getAnalyticsPosts,
  getDailyMetrics,
  getBestPostingTimes,
  getInstagramAccountInsights,
  getYouTubeChannelInsights,
  getProfileComments,
  getPostComments,
  postCommentReply,
  sendPrivateReply,
  hideComment,
  likeComment,
  deleteComment,
  createCommentAutomation,
  listCommentAutomations,
  getCommentAutomationDetails,
  updateCommentAutomation,
  deleteCommentAutomation,
  deleteProfile,
};
