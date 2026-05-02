/**
 * SOCIAL PUBLISHER — Vidalis.AI
 *
 * Router de publicación: decide si usar Upload-Post o la Meta API directa
 * según el campo `publish_mode` del artista.
 *
 *   publish_mode = 'upload-post' (default) → usa uploadPostService
 *   publish_mode = 'direct'                → usa instagramService (Meta API)
 *
 * Nota: la columna DB `ayrshare_profile_key` se reutiliza ahora para guardar
 * el profileKey de Upload-Post — no se renombró para evitar migración.
 */

const uploadPostService = require('./uploadPostService');
const instagramService = require('./instagramService');

// ============================================================
// PUBLICAR AHORA
// ============================================================

exports.publishPost = async (artist, text, platforms, mediaUrls = [], options = {}) => {
  if (artist.publish_mode === 'direct') {
    return publishDirect(artist, text, platforms, mediaUrls, null);
  }
  return uploadPostService.publishPost(text, platforms, mediaUrls, artist.ayrshare_profile_key, options);
};

// ============================================================
// PROGRAMAR
// ============================================================

exports.schedulePost = async (artist, text, platforms, mediaUrls = [], scheduleDate, options = {}) => {
  if (artist.publish_mode === 'direct') {
    return publishDirect(artist, text, platforms, mediaUrls, scheduleDate);
  }
  return uploadPostService.schedulePost(text, platforms, mediaUrls, scheduleDate, artist.ayrshare_profile_key, options);
};

// ============================================================
// CONECTAR REDES SOCIALES
// ============================================================

exports.getConnectUrl = async (artist, allowedPlatforms = [], supabase) => {
  if (artist.publish_mode === 'direct') {
    const url = instagramService.getAuthUrl(artist.id);
    return { url, mode: 'direct' };
  }

  let profileId = artist.ayrshare_profile_key;
  const shortId = artist.id.toString().split('-')[0];
  const isOldFormat = profileId && !profileId.includes(shortId);

  if (!profileId || isOldFormat) {
    console.log('🚀 Creando perfil Upload-Post para:', artist.name);
    profileId = await uploadPostService.createProfile(artist.name, artist.id);

    try {
      await supabase.from('artists').update({
        ayrshare_profile_key: profileId,
        publish_mode: 'upload-post'
      }).eq('id', artist.id);
    } catch (e) {
      console.warn('⚠️ No se pudo actualizar DB:', e.message);
    }
  }

  const connectUrl = await uploadPostService.generateConnectUrl(profileId, allowedPlatforms);
  return { url: connectUrl, mode: 'upload-post', profileKey: profileId };
};

// ============================================================
// PLATAFORMAS ACTIVAS
// ============================================================

exports.getActivePlatforms = async (artist) => {
  if (artist.publish_mode === 'direct') return [];
  if (!artist.ayrshare_profile_key) return [];
  return uploadPostService.getActivePlatforms(artist.ayrshare_profile_key);
};

// ============================================================
// HELPER INTERNO: publicar vía Meta API directa
// ============================================================

async function publishDirect(artist, text, platforms, mediaUrls, scheduleAt) {
  const mediaUrl = mediaUrls[0];
  if (!mediaUrl) throw new Error('No hay mediaUrl para publicar');

  const isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(mediaUrl) || mediaUrl.includes('/video/');
  const results = [];

  for (const platform of platforms) {
    try {
      if (platform === 'instagram') {
        const r = await instagramService.publishToInstagram(artist, text, mediaUrl, isVideo, scheduleAt);
        results.push({ platform: 'instagram', id: r.id });
      } else if (platform === 'facebook') {
        const r = await instagramService.publishToFacebook(artist, text, mediaUrl, isVideo, scheduleAt);
        results.push({ platform: 'facebook', id: r.id });
      } else if (artist.ayrshare_profile_key) {
        // TikTok, YouTube, LinkedIn → caen a Upload-Post aunque el modo sea 'direct'
        const r = await uploadPostService.publishPost(text, [platform], mediaUrls, artist.ayrshare_profile_key, {});
        results.push({ platform, id: r.id });
      } else {
        results.push({ platform, skipped: true, reason: 'Solo Instagram/Facebook disponible en modo directo sin profileKey' });
      }
    } catch (err) {
      results.push({ platform, error: err.response?.data?.error?.message || err.message });
    }
  }

  const firstId = results.find(r => r.id)?.id;
  return { id: firstId, postIds: results.map(r => r.id).filter(Boolean), details: results };
}
