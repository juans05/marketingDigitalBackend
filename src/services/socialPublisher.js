/**
 * SOCIAL PUBLISHER — Vidalis.AI
 *
 * Router de publicación: decide si usar Ayrshare o la Meta API directa
 * según el campo `publish_mode` del artista.
 *
 *   publish_mode = 'ayrshare'  → usa ayrshareService (comportamiento actual)
 *   publish_mode = 'direct'    → usa instagramService + facebookService (Meta API)
 *
 * Todos los módulos que antes llamaban a ayrshareService directamente
 * deben pasar por aquí para soportar ambos modos de forma transparente.
 */

const ayrshareService  = require('./ayrshareService');
const uploadPostService = require('./uploadPostService');
const instagramService = require('./instagramService');

// ============================================================
// PUBLICAR AHORA
// ============================================================

/**
 * Publica inmediatamente en todas las plataformas del artista.
 *
 * @param {object} artist     - Fila completa de artists (necesita publish_mode, tokens, etc.)
 * @param {string} text       - Caption / hashtags
 * @param {string[]} platforms - Plataformas destino ['instagram','facebook','tiktok',...]
 * @param {string[]} mediaUrls - URLs de Cloudinary
 * @param {object} options    - Opciones por plataforma (para Ayrshare)
 */
exports.publishPost = async (artist, text, platforms, mediaUrls = [], options = {}) => {
  if (artist.publish_mode === 'direct') {
    return publishDirect(artist, text, platforms, mediaUrls, null);
  }
  // Default: Upload-Post (Replacing Ayrshare)
  return uploadPostService.publishPost(text, platforms, mediaUrls, artist.ayrshare_profile_key, options);
};

// ============================================================
// PROGRAMAR
// ============================================================

/**
 * Programa una publicación para una fecha futura.
 *
 * @param {object} artist    - Fila completa de artists
 * @param {string} text      - Caption / hashtags
 * @param {string[]} platforms
 * @param {string[]} mediaUrls
 * @param {string} scheduleDate - ISO string (ej: "2026-04-01T15:00:00Z")
 * @param {object} options   - Opciones por plataforma (para Ayrshare)
 */
exports.schedulePost = async (artist, text, platforms, mediaUrls = [], scheduleDate, options = {}) => {
  if (artist.publish_mode === 'direct') {
    return publishDirect(artist, text, platforms, mediaUrls, scheduleDate);
  }
  // Default: Upload-Post (Replacing Ayrshare)
  return uploadPostService.schedulePost(text, platforms, mediaUrls, scheduleDate, artist.ayrshare_profile_key, options);
};

// ============================================================
// CONECTAR REDES SOCIALES
// ============================================================

/**
 * Devuelve la URL para que el artista conecte sus redes sociales.
 *
 * Ayrshare:  devuelve { url } — abre el portal de Ayrshare
 * Direct:    devuelve { url } — abre el OAuth de Meta
 */
exports.getConnectUrl = async (artist, supabase) => {
  if (artist.publish_mode === 'direct') {
    const url = instagramService.getAuthUrl(artist.id);
    return { url, mode: 'direct' };
  }
  
  // Default to Upload-Post (Replacing Ayrshare)
  let profileId = artist.ayrshare_profile_key;

  // Si tiene un profileId de Ayrshare (ID alfanumérico largo), forzamos creación en Upload-Post
  // El ID de Ayrshare suele ser 'profile-XYZ...' o similar.
  // El ID de Upload-Post suele ser un ID de usuario numérico o UUID.
  // Si no estamos seguros, es mejor intentar crear uno nuevo si el modo cambia.
  
  if (!profileId || artist.publish_mode === 'ayrshare') {
    profileId = await uploadPostService.createProfile(artist.name);
    await supabase.from('artists').update({ 
      ayrshare_profile_key: profileId, 
      publish_mode: 'upload-post' 
    }).eq('id', artist.id);
  }

  const connectUrl = await uploadPostService.generateConnectUrl(profileId);
  return { url: connectUrl, mode: 'upload-post', profileKey: profileId };
};

// ============================================================
// PLATAFORMAS ACTIVAS
// ============================================================

/**
 * Devuelve las plataformas conectadas del artista (según su publish_mode).
 */
exports.getActivePlatforms = async (artist) => {
  if (artist.publish_mode === 'upload-post' || !artist.publish_mode || artist.publish_mode === 'ayrshare') {
    if (!artist.ayrshare_profile_key) return [];
    return uploadPostService.getActivePlatforms(artist.ayrshare_profile_key);
  }
  // Fallback for legacy Ayrshare if needed (Optional)
  // return ayrshareService.getActivePlatforms(artist.ayrshare_profile_key);
  return [];
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
      } else {
        // TikTok, YouTube, etc. → redirigir a Ayrshare si tiene profileKey
        if (artist.ayrshare_profile_key) {
          const r = await ayrshareService.publishPost(text, [platform], mediaUrls, artist.ayrshare_profile_key, {});
          results.push({ platform, id: r.id });
        } else {
          results.push({ platform, skipped: true, reason: 'Solo Instagram/Facebook disponible en modo directo' });
        }
      }
    } catch (err) {
      results.push({ platform, error: err.response?.data?.error?.message || err.message });
    }
  }

  // Devolver formato compatible con el resultado de Ayrshare
  const firstId = results.find(r => r.id)?.id;
  return { id: firstId, postIds: results.map(r => r.id).filter(Boolean), details: results };
}
