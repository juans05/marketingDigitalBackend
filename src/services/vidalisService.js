const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ ERROR: Faltan SUPABASE_URL o SUPABASE_ANON_KEY en las variables de entorno.");
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);

// --- AUTENTICACIÓN ---
// accountType: 'agency' | 'artist' | null (login existente)
// displayName: nombre para el registro (opcional)
exports.loginUser = async (email, password, accountType = null, displayName = null) => {
  // Buscar cuenta existente por email o por nombre (compatibilidad hacia atrás)
  const { data: existing } = await supabase
    .from('agencies')
    .select('*')
    .or(`email.eq.${email},name.ilike.%${email.split('@')[0]}%`)
    .limit(1);

  if (existing && existing.length > 0) {
    const agency = existing[0];
    const resolvedType = agency.account_type || 'agency';

    let artist_id = null;
    if (resolvedType === 'artist') {
      const { data: artists } = await supabase
        .from('artists')
        .select('id')
        .eq('agency_id', agency.id)
        .limit(1);
      if (artists?.[0]) artist_id = artists[0].id;
    }

    return {
      id: agency.id,
      email: agency.email || email,
      name: agency.name,
      plan: agency.plan_type,
      account_type: resolvedType,
      artist_id,
    };
  }

  // Crear nueva cuenta
  const name = displayName || email.split('@')[0];
  const { data: newAgency, error: agencyErr } = await supabase
    .from('agencies')
    .insert([{ name, email, plan_type: 'Pro', account_type: accountType || 'agency' }])
    .select();

  if (agencyErr) throw new Error('Error al crear cuenta');
  const agency = newAgency[0];

  if (accountType === 'artist') {
    // Artista solo: crear su perfil de artista automáticamente
    const { data: newArtist, error: artistErr } = await supabase
      .from('artists')
      .insert([{ agency_id: agency.id, name }])
      .select();
    if (artistErr) throw new Error('Error al crear perfil de artista');

    return {
      id: agency.id,
      email,
      name,
      plan: agency.plan_type,
      account_type: 'artist',
      artist_id: newArtist[0].id,
    };
  }

  return {
    id: agency.id,
    email,
    name,
    plan: agency.plan_type,
    account_type: 'agency',
    artist_id: null,
  };
};

// --- GESTIÓN DE AGENCIAS ---
exports.createAgency = async (agencyData) => {
  const { data, error } = await supabase
    .from('agencies')
    .insert([agencyData])
    .select();
  if (error) throw error;
  return data[0];
};

// --- GESTIÓN DE ARTISTAS ---
exports.createArtist = async (artistData) => {
  const { data, error } = await supabase
    .from('artists')
    .insert([artistData])
    .select();
  if (error) throw error;
  return data[0];
};

exports.getArtistsByAgency = async (agencyId) => {
  const { data, error } = await supabase
    .from('artists')
    .select('id, name, active_platforms, ayrshare_profile_key, created_at')
    .eq('agency_id', agencyId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
};

// --- SUBIR VIDEO ---
exports.registerVideo = async (videoData) => {
  // Recorte inteligente 9:16 en Cloudinary
  const isCloudinary = videoData.source_url.includes('cloudinary.com');
  // Mejor detección: si es video o si tiene extensión de video
  const looksLikeVideo = videoData.source_url.includes('/video/') || videoData.source_url.match(/\.(mp4|mov|webm|ogv)$/i);

  if (isCloudinary && looksLikeVideo) {
    // Aplicamos transformación 9:16 y forzamos que sea un .mp4 si es video
    videoData.processed_url = videoData.source_url.replace('/upload/', '/upload/c_fill,g_auto,ar_9:16/');
    if (!videoData.processed_url.match(/\.(mp4|mov|webm|ogv)$/i)) {
      videoData.processed_url += '.mp4';
    }
  } else if (isCloudinary) {
    videoData.processed_url = videoData.source_url;
  }

  // Verificar que el artist_id es válido
  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('id, ayrshare_profile_key, active_platforms')
    .eq('id', videoData.artist_id)
    .single();

  if (artistErr || !artist) throw new Error(`Artista no encontrado: ${videoData.artist_id}`);

  // Guardar en Supabase
  const { data, error } = await supabase
    .from('videos')
    .insert([videoData])
    .select();

  if (error) throw error;
  const video = data[0];
  console.log(`✅ Video registrado: ${video.id}`);

  // Disparar n8n para procesamiento IA
  if (process.env.N8N_WEBHOOK_URL) {
    try {
      const hasActivePlatforms = artist.active_platforms?.length > 0;
      let targetPlatforms = (video.platforms?.length ? video.platforms : null) ||
        (hasActivePlatforms ? artist.active_platforms : null) ||
        ['tiktok', 'instagram', 'facebook', 'youtube'];

      let platformWarning = null;

      if (!looksLikeVideo) {
        const imageCompatible = targetPlatforms.filter(p => !['tiktok', 'youtube'].includes(p.toLowerCase()));
        if (imageCompatible.length === 0 && hasActivePlatforms) {
          // El artista tiene redes conectadas pero ninguna acepta imágenes
          platformWarning = 'Tu cuenta solo tiene conectadas TikTok y/o YouTube, que no aceptan imágenes. Conecta Instagram o Facebook para publicar imágenes.';
          targetPlatforms = []; // no disparar publicación
        } else {
          targetPlatforms = imageCompatible.length > 0 ? imageCompatible : ['instagram', 'facebook'];
        }
      }

      if (targetPlatforms.length > 0) {
        await axios.post(process.env.N8N_WEBHOOK_URL, {
          videoUrl: video.processed_url || video.source_url,
          videoId: video.id,
          title: video.title,
          mediaType: looksLikeVideo ? 'video' : 'image',
          profileKey: artist.ayrshare_profile_key || null,
          platforms: targetPlatforms,
        });
        console.log(`✅ n8n disparado para video: ${video.id}`);
      } else {
        console.warn(`⚠️ Video ${video.id} no disparado a n8n: ${platformWarning}`);
      }

      if (platformWarning) video._platformWarning = platformWarning;
    } catch (err) {
      console.error('❌ Error al disparar n8n:', err.response?.data || err.message);
    }
  }

  return video;
};

// --- GALERÍA ---
exports.fetchArtistGallery = async (artistId) => {
  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

// --- ANALYTICS DE UN VIDEO ---
exports.getVideoAnalytics = async (videoId) => {
  const { data, error } = await supabase
    .from('videos')
    .select('id, title, status, viral_score, ai_copy_short, ai_copy_long, ayrshare_post_id, scheduled_for, published_at, analytics_4h, source_url, created_at')
    .eq('id', videoId)
    .single();
  if (error) throw error;
  return data;
};

// --- ESTADÍSTICAS DEL DASHBOARD ---
// Funciona tanto para agencias (todos sus artistas) como para artistas solos
exports.getDashboardStats = async (agencyId) => {
  // Obtener todos los artistas de la agencia
  const { data: artists } = await supabase
    .from('artists')
    .select('id')
    .eq('agency_id', agencyId);

  if (!artists || artists.length === 0) {
    return { total: 0, published: 0, avgScore: 0 };
  }

  const artistIds = artists.map(a => a.id);

  const { data: videos, error } = await supabase
    .from('videos')
    .select('viral_score, status')
    .in('artist_id', artistIds);

  if (error) throw error;

  const total = videos.length;
  const published = videos.filter(v => v.status === 'published' || v.status === 'scheduled').length;
  const scores = videos.filter(v => v.viral_score).map(v => v.viral_score);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
    : 0;

  return { total, published, avgScore };
};

// --- CONECTAR REDES SOCIALES (por ARTISTA) ---
exports.connectSocialAccounts = async (artistId) => {
  const ayrshareService = require('./ayrshareService');

  const { data: artist, error } = await supabase
    .from('artists')
    .select('id, name, ayrshare_profile_key')
    .eq('id', artistId)
    .single();

  if (error || !artist) throw new Error(`Artista no encontrado: ${artistId}`);

  let profileKey = artist.ayrshare_profile_key;

  if (!profileKey) {
    const profile = await ayrshareService.createProfile(artist.name);
    profileKey = profile.profileKey;
    await supabase.from('artists').update({ ayrshare_profile_key: profileKey }).eq('id', artistId);
  }

  const jwt = await ayrshareService.generateJWT(profileKey);
  return { url: jwt.url, profileKey };
};

// --- VERIFICAR PLATAFORMAS CONECTADAS (por ARTISTA) ---
// refresh=false → lee de DB (carga rápida)
// refresh=true  → consulta Ayrshare API y actualiza DB
exports.getSocialStatus = async (artistId, refresh = false) => {
  const { data: artist, error } = await supabase
    .from('artists')
    .select('id, ayrshare_profile_key, active_platforms')
    .eq('id', artistId)
    .single();

  if (error || !artist) throw new Error(`Artista no encontrado: ${artistId}`);

  // Sin refresh: devolver lo que ya está guardado en DB
  if (!refresh) {
    return { platforms: artist.active_platforms || [] };
  }

  // Con refresh: consultar Ayrshare y actualizar DB
  const profileKey = artist.ayrshare_profile_key;
  if (!profileKey) return { platforms: [] };

  const ayrshareService = require('./ayrshareService');
  const platforms = await ayrshareService.getActivePlatforms(profileKey);

  await supabase
    .from('artists')
    .update({ active_platforms: platforms })
    .eq('id', artistId);

  return { platforms };
};

// --- ACTUALIZACIÓN DIRECTA (para callbacks de n8n) ---
exports.updateVideoRaw = async (videoId, updates) => {
  const { error } = await supabase.from('videos').update(updates).eq('id', videoId);
  if (error) throw new Error(error.message);
};

// --- VIRAL SCORE (n8n) ---
exports.analyzeViralPotential = async (videoUrl) => {
  if (process.env.N8N_VIRAL_SCORE_URL) {
    try {
      const response = await axios.post(process.env.N8N_VIRAL_SCORE_URL, { videoUrl });
      return response.data;
    } catch (err) {
      console.error('⚠️ Error en Viral Score n8n:', err.message);
    }
  }
  return { score: 0, feedback: "n8n no configurado aún." };
};

// --- ACTUALIZAR CONFIGURACIÓN DE VIDEO ---
// Si viene scheduled_at, programa el post en Ayrshare y guarda el post_id
exports.updateVideoSettings = async (videoId, updateData) => {
  // 1. Obtener datos actuales del video y del artista
  console.log("updateData.data", updateData);
  const { data: video, error: videoErr } = await supabase
    .from('videos')
    .select('id, title, source_url, processed_url, artist_id')
    .eq('id', videoId)
    .single();

  if (videoErr || !video) throw new Error('Video no encontrado');

  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('ayrshare_profile_key')
    .eq('id', video.artist_id)
    .single();
  // Leer fecha programada — puede venir como scheduled_at (frontend) o scheduled_for (DB)
  const scheduledAt = updateData.scheduled_at || updateData.scheduled_for || null;
  console.log('📅 scheduledAt recibido:', scheduledAt, '| profileKey:', artist?.ayrshare_profile_key ? 'OK' : 'NO');

  // 2. Si hay fecha programada y el artista tiene Ayrshare conectado → programar
  let scheduleStatus = 'no_profile'; // 'success' | 'no_profile' | 'error'
  let scheduleErrorMsg = null;

  if (scheduledAt && artist?.ayrshare_profile_key) {
    try {
      const ayrshareService = require('./ayrshareService');
      const postText = updateData.hashtags || video.title || 'Nuevo contenido';
      const platforms = updateData.platforms || ['tiktok', 'instagram', 'youtube'];

      const cloudinaryUrl = buildCloudinaryUrl(video.source_url);
      const mediaUrl = await uploadToAyrshare(cloudinaryUrl, artist.ayrshare_profile_key);
      const options = buildPlatformOptions(video.source_url, platforms, postText);

      const result = await ayrshareService.schedulePost(
        postText,
        platforms,
        [mediaUrl],
        new Date(scheduledAt).toISOString(),
        artist.ayrshare_profile_key,
        options
      );

      if (result.id || result.postIds) {
        updateData.ayrshare_post_id = result.id || result.postIds?.[0] || null;
        scheduleStatus = 'success';
      }
      console.log(`✅ Post programado en Ayrshare para video: ${videoId}`);
    } catch (err) {
      scheduleStatus = 'error';
      const ayrData = err.response?.data;
      scheduleErrorMsg = ayrData?.message || ayrData?.error
        || (typeof ayrData === 'object' ? JSON.stringify(ayrData) : null)
        || err.message;
      console.error('❌ Error Ayrshare schedulePost:', ayrData || err.message);
    }
  } else if (scheduledAt) {
    console.warn(`⚠️ Video ${videoId} programado en DB pero artista sin Ayrshare conectado`);
  }

  // Mapear scheduled_at → scheduled_for (nombre real de la columna en Supabase)
  if ('scheduled_at' in updateData) {
    updateData.scheduled_for = updateData.scheduled_at || null;
    delete updateData.scheduled_at;
  }

  // 3. Guardar en DB
  const { data, error } = await supabase
    .from('videos')
    .update(updateData)
    .eq('id', videoId)
    .select();
  if (error) throw error;
  return { ...data[0], _scheduleStatus: scheduleStatus, _scheduleError: scheduleErrorMsg };
};

// --- HELPER: Construye URL de Cloudinary con transformaciones limpias ---
// Especificaciones (Ayrshare Media Guidelines):
//   VIDEOS → MP4, H.264 (vc_h264), fl_faststart (moov atom al inicio, req. Instagram), 9:16
//   IMÁGENES → JPEG (f_jpg, TikTok no acepta PNG), 9:16 portrait
function buildCloudinaryUrl(sourceUrl) {
  if (!sourceUrl || !sourceUrl.includes('cloudinary.com') || !sourceUrl.includes('/upload/')) {
    return sourceUrl;
  }

  const isVideo = sourceUrl.includes('/video/') || sourceUrl.match(/\.(mp4|mov|webm|ogv)(\?|$)/i);
  const uploadIdx = sourceUrl.indexOf('/upload/');
  const base = sourceUrl.slice(0, uploadIdx + 8); // "https://…/upload/"
  const rest = sourceUrl.slice(uploadIdx + 8);     // "v123/public_id" sin transforms

  if (isVideo) {
    // fl_faststart: mueve el moov atom al inicio del MP4 (requerido por Instagram explícitamente)
    // vc_h264: codec H.264 requerido por Instagram, Twitter/X y Facebook
    // ar_9:16: requerido por TikTok, Instagram Reels, YouTube Shorts, Facebook Reels
    const url = `${base}c_fill,g_auto,ar_9:16,vc_h264,fl_faststart/${rest}`;
    return url.match(/\.(mp4|mov)(\?|$)/i) ? url : url + '.mp4';
  } else {
    // f_jpg: TikTok rechaza PNG; JPEG universal para Instagram/Facebook/Twitter
    // ar_9:16: formato portrait para TikTok (1080×1920) e Instagram portrait/Stories
    const url = `${base}c_fill,g_auto,ar_9:16,f_jpg,q_auto/${rest}`;
    return url.match(/\.(jpg|jpeg)(\?|$)/i) ? url : url + '.jpg';
  }
}

// --- HELPER: Sube el media a Ayrshare CDN antes de publicar ---
// Esto elimina el problema de URLs de Cloudinary (lazy transforms, timeouts de Instagram).
// Ayrshare re-hospeda el media en su CDN, garantizando compatibilidad con cada red social.
// Si falla (plan no soporta, error de red), se devuelve la URL original como fallback.
async function uploadToAyrshare(cloudinaryUrl, profileKey) {
  const ayrshareService = require('./ayrshareService');
  try {
    console.log('⬆️ Subiendo media a Ayrshare CDN:', cloudinaryUrl.slice(-60));
    const result = await ayrshareService.uploadMedia(cloudinaryUrl, profileKey);
    // Ayrshare puede devolver { url, mediaUrl, location, ... } según el plan
    const hostedUrl = result.url || result.mediaUrl || result.location || null;
    if (hostedUrl) {
      console.log('✅ Media en Ayrshare CDN:', hostedUrl.slice(-60));
      return hostedUrl;
    }
    console.warn('⚠️ Ayrshare no devolvió URL, usando Cloudinary directamente');
    return cloudinaryUrl;
  } catch (err) {
    console.warn('⚠️ Upload a Ayrshare falló, usando Cloudinary directamente:', err.response?.data?.message || err.message);
    return cloudinaryUrl; // fallback: intentar con URL de Cloudinary igual
  }
}

// --- HELPER: Opciones por plataforma según tipo de contenido ---
function buildPlatformOptions(sourceUrl, platforms, postText = '') {
  const isVideo = sourceUrl && (sourceUrl.includes('/video/') || sourceUrl.match(/\.(mp4|mov|webm|ogv)(\?|$)/i));
  const options = {};

  if (isVideo) {
    if (platforms.includes('instagram')) {
      // Obligatorio para video en Instagram — sin esto da error 170
      options.instagramOptions = { reels: true };
    }
    if (platforms.includes('youtube')) {
      options.youtubeOptions = { youtubeShortsPost: true, visibility: 'public' };
    }
    if (platforms.includes('tiktok') && postText) {
      options.tiktokOptions = { videoTitle: postText.slice(0, 100) };
    }
  }

  return options;
}

// --- PUBLICAR VIDEO AHORA ---
exports.publishVideoNow = async (videoId) => {
  const ayrshareService = require('./ayrshareService');

  const { data: video, error: videoErr } = await supabase
    .from('videos')
    .select('id, title, source_url, processed_url, hashtags, platforms, artist_id')
    .eq('id', videoId)
    .single();

  if (videoErr || !video) throw new Error('Video no encontrado');

  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('ayrshare_profile_key, active_platforms')
    .eq('id', video.artist_id)
    .single();

  if (artistErr || !artist) throw new Error('Artista no encontrado');
  if (!artist.ayrshare_profile_key) throw new Error('El artista no tiene redes sociales conectadas. Conéctalas primero.');

  const postText = video.hashtags || video.title || 'Nuevo contenido';
  const platforms = video.platforms?.length ? video.platforms
    : artist.active_platforms?.length ? artist.active_platforms
      : ['tiktok', 'instagram'];

  const cloudinaryUrl = buildCloudinaryUrl(video.source_url);
  const mediaUrl = await uploadToAyrshare(cloudinaryUrl, artist.ayrshare_profile_key);
  const options = buildPlatformOptions(video.source_url, platforms, postText);

  const result = await ayrshareService.publishPost(
    postText, platforms, [mediaUrl], artist.ayrshare_profile_key, options
  );

  const postId = result.id || result.postIds?.[0] || null;
  const { data: updated, error: updateErr } = await supabase
    .from('videos')
    .update({ status: 'published', ayrshare_post_id: postId, published_at: new Date().toISOString() })
    .eq('id', videoId)
    .select();

  if (updateErr) throw updateErr;
  console.log(`✅ Video ${videoId} publicado ahora. Post ID: ${postId}`);
  return updated[0];
};

// --- OBTENER CLIPS DE UN VIDEO PADRE ---
exports.getClipsByParent = async (parentId) => {
  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .eq('parent_video_id', parentId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};
