const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const PQueue = require('p-queue').default;
const bcrypt = require('bcryptjs');

// Cola para llamadas a n8n — evita saturar el workflow con uploads simultáneos
const n8nQueue = new PQueue({ concurrency: 2 }); // máx 2 análisis en paralelo

// Cola interna para procesamiento con Gemini+Claude
const internalQueue = new PQueue({ concurrency: 2 }); // máx 2 análisis simultáneos internos

/**
 * Routing de IA:
 * - AI_MODE=internal  → siempre usa Gemini+Claude directamente
 * - AI_MODE=n8n       → siempre usa n8n (comportamiento anterior)
 * - AI_MODE=hybrid    → usa interno si la cola está libre; si está llena → n8n como overflow
 */
const AI_MODE = process.env.AI_MODE || 'n8n';
const N8N_QUEUE_THRESHOLD = parseInt(process.env.N8N_QUEUE_THRESHOLD || '3', 10);

function shouldUseInternal() {
  if (AI_MODE === 'internal') return true;
  if (AI_MODE === 'n8n') return false;
  // hybrid: usar interno si la cola interna tiene menos trabajos que el umbral
  return internalQueue.size < N8N_QUEUE_THRESHOLD;
}

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
  if (!email || !password) throw new Error('Se requiere email y contraseña');

  // Buscar cuenta existente por email
  const { data: users, error: searchError } = await supabase
    .from('agencies')
    .select('*')
    .eq('email', email)
    .limit(1);

  if (searchError) throw new Error('Error al buscar usuario');

  const user = users?.[0];

  if (user) {
    // 1. Validar contraseña si existe password_hash
    if (user.password_hash) {
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) throw new Error('Email o contraseña incorrectos');
    } else {
      // ⚠️ Caso borde: El usuario existe pero no tiene hash (ej: migración antigua)
      // Por seguridad en este punto, vamos a crear el hash con la password que envió
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(password, salt);
      await supabase.from('agencies').update({ password_hash: hash }).eq('id', user.id);
      console.warn(`🔐 Contraseña hasheada automáticamente para el usuario: ${email}`);
    }

    const resolvedType = user.account_type || 'agency';

    let artist_id = null;
    if (resolvedType === 'artist') {
      const { data: artists } = await supabase
        .from('artists')
        .select('id')
        .eq('agency_id', user.id)
        .limit(1);
      if (artists?.[0]) artist_id = artists[0].id;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan_type,
      account_type: resolvedType,
      artist_id,
    };
  }

  // --- REGISTRO DE NUEVO USUARIO ---
  const name = displayName || email.split('@')[0];
  const salt = await bcrypt.genSalt(10);
  const password_hash = await bcrypt.hash(password, salt);

  const { data: newAgencies, error: agencyErr } = await supabase
    .from('agencies')
    .insert([{ 
      name, 
      email, 
      password_hash,
      plan_type: 'Pro', 
      account_type: accountType || 'agency' 
    }])
    .select();

  if (agencyErr) {
    console.error('Error insertando agencia:', agencyErr);
    throw new Error('No se pudo crear la cuenta');
  }
  
  const newAgency = newAgencies[0];

  if (accountType === 'artist') {
    const { data: newArtists, error: artistErr } = await supabase
      .from('artists')
      .insert([{ agency_id: newAgency.id, name }])
      .select();
    if (artistErr) throw new Error('Error al crear perfil de artista');

    return {
      id: newAgency.id,
      email,
      name,
      plan: newAgency.plan_type,
      account_type: 'artist',
      artist_id: newArtists[0].id,
    };
  }

  return {
    id: newAgency.id,
    email,
    name,
    plan: newAgency.plan_type,
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
  // Sanitizar URL — eliminar espacios que rompen Cloudinary
  if (videoData.source_url) {
    videoData.source_url = videoData.source_url.replace(/\s+/g, '');
  }

  const isCloudinary = videoData.source_url?.includes('cloudinary.com');
  const looksLikeVideo = videoData.source_url?.includes('/video/') || videoData.source_url?.match(/\.(mp4|mov|webm|ogv)$/i);

  if (isCloudinary) {
    // Generar URLs optimizadas para cada plataforma
    videoData.platform_urls = getPlatformUrls(videoData.source_url);
    // processed_url sirve como el valor "por defecto" (9:16 vertical)
    videoData.processed_url = buildCloudinaryUrl(videoData.source_url);
    // Inicializar post_type por defecto
    videoData.post_type = looksLikeVideo ? 'reel' : 'feed';
  }

  // Verificar que el artist_id es válido
  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('id, ayrshare_profile_key, active_platforms, name, ai_genre, ai_audience, ai_tone')
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

  // Disparar procesamiento IA (interno o n8n según AI_MODE)
  try {
    const hasActivePlatforms = artist.active_platforms?.length > 0;
    let targetPlatforms = (video.platforms?.length ? video.platforms : null) ||
      (hasActivePlatforms ? artist.active_platforms : null) ||
      ['tiktok', 'instagram', 'facebook', 'youtube'];

    let platformWarning = null;

    if (!looksLikeVideo) {
      const imageCompatible = targetPlatforms.filter(p => !['tiktok', 'youtube'].includes(p.toLowerCase()));
      if (imageCompatible.length === 0 && hasActivePlatforms) {
        platformWarning = 'Tu cuenta solo tiene conectadas TikTok y/o YouTube, que no aceptan imágenes. Conecta Instagram o Facebook para publicar imágenes.';
        targetPlatforms = [];
      } else {
        targetPlatforms = imageCompatible.length > 0 ? imageCompatible : ['instagram', 'facebook'];
      }
    }

    if (targetPlatforms.length > 0) {
      const useInternal = shouldUseInternal();
      const mediaType = looksLikeVideo ? 'video' : 'image';

      if (useInternal) {
        // --- Procesamiento interno: Gemini + Claude ---
        const aiService = require('./aiService');
        const artistContext = (artist.ai_genre || artist.ai_audience || artist.ai_tone) ? {
          nombre: artist.name,
          genero: artist.ai_genre || null,
          audiencia: artist.ai_audience || null,
          tono: artist.ai_tone || null,
        } : null;

        internalQueue.add(() => aiService.processVideoAI(
          video.id,
          video.processed_url || video.source_url,
          video.source_url,
          mediaType,
          targetPlatforms,
          video.title || '',
          artistContext
        )).catch(err => console.error(`❌ [AI interno] Cola error video ${video.id}:`, err.message));
        console.log(`🤖 [AI interno] Encolado video ${video.id} (cola: ${internalQueue.size + 1})`);
      } else if (process.env.N8N_WEBHOOK_URL) {
        // --- Fallback: n8n ---
        n8nQueue.add(() => axios.post(process.env.N8N_WEBHOOK_URL, {
          videoUrl: video.processed_url || video.source_url,
          sourceUrl: video.source_url,
          videoId: video.id,
          title: video.title,
          mediaType,
          profileKey: artist.ayrshare_profile_key || null,
          platforms: targetPlatforms,
        })).catch(err => console.error(`❌ [n8n] Error video ${video.id}:`, err.response?.data || err.message));
        console.log(`📤 [n8n] Encolado video ${video.id} (cola interna llena: ${internalQueue.size})`);
      } else {
        console.warn(`⚠️ Video ${video.id}: sin AI_MODE interno ni N8N_WEBHOOK_URL configurado`);
      }
    } else {
      console.warn(`⚠️ Video ${video.id} no procesado: ${platformWarning}`);
    }

    if (platformWarning) video._platformWarning = platformWarning;
  } catch (err) {
    console.error('❌ Error al disparar procesamiento IA:', err.message);
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
    .select('id, title, status, viral_score, ai_copy_short, ai_copy_long, hashtags, platforms, post_type, ayrshare_post_id, scheduled_for, published_at, analytics_4h, source_url, processed_url, error_log, created_at, updated_at')
    .eq('id', videoId)
    .single();
  if (error) throw error;
  return data;
};

// --- ESTADÍSTICAS DEL DASHBOARD ---
// Funciona tanto para agencias (todos sus artistas) como para un artista específico
exports.getDashboardStats = async (agencyId, artistId = null) => {
  let targetArtistIds = [];

  if (artistId) {
    // Si se especifica un artista, solo miramos ese
    targetArtistIds = [artistId];
  } else {
    // Obtener todos los artistas de la agencia para el resumen global
    const { data: artists } = await supabase
      .from('artists')
      .select('id')
      .eq('agency_id', agencyId);

    if (!artists || artists.length === 0) {
      return { total: 0, published: 0, avgScore: 0 };
    }
    targetArtistIds = artists.map(a => a.id);
  }

  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, viral_score, status, hashtags, published_at, created_at, platforms, title')
    .in('artist_id', targetArtistIds);

  if (error) throw error;

  const total = videos.length;
  const published = videos.filter(v => v.status === 'published' || v.status === 'scheduled').length;
  const scores = videos.filter(v => v.viral_score).map(v => v.viral_score);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
    : 0;

  // Cálculo de Alcance Estimado (Simulado basado en score viral)
  const totalReach = Math.round(scores.reduce((acc, s) => acc + (s * (15000 + Math.random() * 10000)), 0));

  // Seguidores (Simulado/Inyectado para el Dashboard)
  const followersTotal = 1240500 + Math.floor(Math.random() * 5000);
  const followersDaily = 840 + Math.floor(Math.random() * 200);
  const followersPerPost = total > 0 ? Math.round(followersTotal / total) : 0;
  const postsDaily = (published / 7).toFixed(2);

  // Generar Historial de 7 días (para la gráfica)
  const history = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const baseValue = (7 - i) * (totalReach / 20) + (Math.random() * (totalReach / 40));
    history.push({
      date: d.toISOString().split('T')[0],
      value: Math.round(baseValue)
    });
  }

  // Lista de Posts (Últimos 10)
  const postList = videos.slice(0, 10).map(v => ({
    id: v.id,
    title: v.title,
    date: v.published_at || v.created_at,
    platforms: v.platforms || [],
    viral_score: v.viral_score || 0,
    hashtags: v.hashtags || [],
    status: v.status
  }));

  return { 
    total, 
    published, 
    avgScore, 
    totalReach, 
    history,
    postList,
    followersTotal,
    followersDaily,
    followersPerPost,
    postsDaily,
    trend: '+15.4%'
  };
};

// --- CONECTAR REDES SOCIALES (por ARTISTA) ---
exports.connectSocialAccounts = async (artistId) => {
  const socialPublisher = require('./socialPublisher');

  const { data: artist, error } = await supabase
    .from('artists')
    .select('*') // Usar * para ser más resiliente a cambios de esquema
    .eq('id', artistId)
    .single();

  if (error) {
    console.error('🎯 Supabase Error (connectSocialAccounts):', error);
    throw new Error('Error al buscar artista en BD: ' + error.message);
  }

  if (!artist) {
    throw new Error(`Artista no existe en la base de datos: ${artistId}`);
  }

  return socialPublisher.getConnectUrl(artist, supabase);
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

  // Con refresh: consultar según publish_mode y actualizar DB
  const socialPublisher = require('./socialPublisher');
  const { data: artistFull } = await supabase
    .from('artists')
    .select('id, publish_mode, ayrshare_profile_key, instagram_user_id, instagram_access_token, facebook_page_id, facebook_access_token')
    .eq('id', artistId)
    .single();
  const platforms = await socialPublisher.getActivePlatforms(artistFull || artist);

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
    .select('id, publish_mode, ayrshare_profile_key, instagram_user_id, instagram_access_token, facebook_page_id, facebook_access_token, active_platforms')
    .eq('id', video.artist_id)
    .single();

  // Leer fecha programada — puede venir como scheduled_at (frontend) o scheduled_for (DB)
  const scheduledAt = updateData.scheduled_at || updateData.scheduled_for || null;
  const hasConnection = artist?.ayrshare_profile_key || artist?.instagram_user_id;
  console.log('📅 scheduledAt recibido:', scheduledAt, '| modo:', artist?.publish_mode, '| conectado:', !!hasConnection);

  // 2. Si hay fecha programada y el artista tiene redes conectadas → programar
  let scheduleStatus = 'no_profile';
  let scheduleErrorMsg = null;

  if (scheduledAt && hasConnection) {
    try {
      const socialPublisher = require('./socialPublisher');
      const postText = updateData.hashtags || video.title || 'Nuevo contenido';
      const platforms = updateData.platforms || video.platforms || ['tiktok', 'instagram', 'youtube'];

      const targetPlatform = platforms[0];
      const cloudinaryUrl = video.platform_urls?.[targetPlatform]
        || buildCloudinaryUrl(video.source_url, targetPlatform);

      const postType = updateData.post_type || video.post_type || (video.source_url.includes('/video/') ? 'reel' : 'feed');
      const options = buildPlatformOptions(video.source_url, platforms, postText, postType);

      const result = await socialPublisher.schedulePost(
        artist,
        postText,
        platforms,
        [cloudinaryUrl],
        new Date(scheduledAt).toISOString(),
        options
      );

      if (result.id || result.postIds) {
        updateData.ayrshare_post_id = result.id || result.postIds?.[0] || null;
        scheduleStatus = 'success';
      }
      console.log(`✅ Post programado (modo: ${artist.publish_mode}) para video: ${videoId}`);
    } catch (err) {
      scheduleStatus = 'error';
      const errData = err.response?.data;
      scheduleErrorMsg = errData?.message || errData?.error
        || (typeof errData === 'object' ? JSON.stringify(errData) : null)
        || err.message;
      console.error('❌ Error schedulePost:', errData || err.message);
    }
  } else if (scheduledAt) {
    console.warn(`⚠️ Video ${videoId} programado pero artista sin redes conectadas`);
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

/**
 * HELPER: Construye URL de Cloudinary con transformaciones limpias.
 * @param {string} sourceUrl - URL original de Cloudinary.
 * @param {string} targetPlatform - 'instagram', 'tiktok', 'youtube', 'facebook', o null (general).
 */
function buildCloudinaryUrl(sourceUrl, targetPlatform = null) {
  if (!sourceUrl || !sourceUrl.includes('cloudinary.com') || !sourceUrl.includes('/upload/')) {
    return sourceUrl;
  }

  // Sanitización profunda: eliminar espacios y parámetros de cache/query innecesarios
  const cleanUrl = sourceUrl.replace(/\s+/g, '').split('?')[0];

  // Regex robusto para separar: Base + Subida + [Transformaciones Existentes] + Versión/PublicID
  // Captura: 1: (https://.../upload/)  2: (v12345/path/to/video.mp4)
  const regex = /^(https:\/\/res\.cloudinary\.com\/[^\/]+\/(?:video|image)\/upload\/)(?:[^\/]+\/)*(v\d+\/.*)$/;
  const match = cleanUrl.match(regex);

  if (!match) {
    console.warn("⚠️ URL de Cloudinary no estándar, devolviendo original:", cleanUrl);
    return cleanUrl;
  }

  const baseUrl = match[1];
  const publicId = match[2];
  const isVideo = cleanUrl.includes('/video/') || cleanUrl.match(/\.(mp4|mov|webm|ogv)$/i);

  if (isVideo) {
    // REELS / TIKTOK / SHORTS: 1080x1920 (9:16), H.264, AAC Audio
    // Forzamos mp4 al final para asegurar compatibilidad con Instagram API
    const trans = 'w_1080,h_1920,c_fill,vc_h264,ac_aac,f_mp4';
    return `${baseUrl}${trans}/${publicId}`.replace(/\.[a-z0-7]+$/i, '.mp4');
  } else {
    // IMÁGENES:
    if (targetPlatform === 'instagram' || targetPlatform === 'facebook') {
      // Instagram Feed: 1080x1080 (1:1) con fondo negro si no es cuadrado
      const trans = 'w_1080,h_1080,c_pad,ar_1:1,b_black,f_jpg';
      return `${baseUrl}${trans}/${publicId}`.replace(/\.[a-z0-7]+$/i, '.jpg');
    } else {
      // General Portrait: 1080x1920 (9:16)
      const trans = 'w_1080,h_1920,c_pad,ar_9:16,b_black,f_jpg';
      return `${baseUrl}${trans}/${publicId}`.replace(/\.[a-z0-7]+$/i, '.jpg');
    }
  }
}

/**
 * HELPER: Genera un objeto con las URLs optimizadas para cada plataforma.
 */
function getPlatformUrls(sourceUrl) {
  return {
    instagram: buildCloudinaryUrl(sourceUrl, 'instagram'),
    facebook: buildCloudinaryUrl(sourceUrl, 'facebook'),
    tiktok: buildCloudinaryUrl(sourceUrl, 'tiktok'),
    youtube: buildCloudinaryUrl(sourceUrl, 'youtube')
  };
}

// --- HELPER: Opciones por plataforma según tipo de contenido ---
exports.buildPlatformOptions = (sourceUrl, platforms, postText = '', postType = null) => {
  const isVideo = sourceUrl && (sourceUrl.includes('/video/') || sourceUrl.match(/\.(mp4|mov|webm|ogv)(\?|$)/i));
  const options = {};

  // 1. INSTAGRAM (Reels, Story, Feed)
  if (platforms.includes('instagram')) {
    options.instagramOptions = {};

    // Si no se especifica postType, inferimos según el medio
    const finalType = postType || (isVideo ? 'reel' : 'feed');

    if (finalType === 'story') {
      options.instagramOptions.stories = true;
    } else if (finalType === 'reel') {
      options.instagramOptions.reels = true;
      options.instagramOptions.shareReelsFeed = true;
    }
    // Si es 'feed', no se añaden flags especiales (estándar).
  }

  // 2. YOUTUBE (Shorts vs Normal)
  if (platforms.includes('youtube')) {
    options.youtubeOptions = { visibility: 'public' };
    if (isVideo) {
      options.youtubeOptions.youtubeShortsPost = true;
    }
  }

  // 3. TIKTOK (Video title)
  if (platforms.includes('tiktok') && postText) {
    options.tiktokOptions = { videoTitle: postText.slice(0, 100) };
  }

  return options;
}

// --- PUBLICAR VIDEO AHORA ---
exports.publishVideoNow = async (videoId, frontendOptions = {}) => {
  const socialPublisher = require('./socialPublisher');

  const { data: video, error: videoErr } = await supabase
    .from('videos')
    .select('id, title, source_url, processed_url, hashtags, platforms, artist_id')
    .eq('id', videoId)
    .single();

  if (videoErr || !video) throw new Error('Video no encontrado');
  console.log('video', video.artist_id);
  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('*')
    .eq('id', video.artist_id)
    .single();
  console.log('artist found:', artist?.id, artist?.name);

  if (artistErr || !artist) throw new Error('Artista no encontrado');
  const hasConnection = artist.ayrshare_profile_key || artist.instagram_user_id;
  if (!hasConnection) throw new Error('El artista no tiene redes sociales conectadas. Conéctalas primero.');

  const postText = video.hashtags || video.title || 'Nuevo contenido';

  // Usar plataformas del frontend si las mandó, sino las del video/artista
  const platforms = frontendOptions.platforms?.length ? frontendOptions.platforms
    : video.platforms?.length ? video.platforms
    : artist.active_platforms?.length ? artist.active_platforms
      : ['instagram'];

  const targetPlatform = platforms[0];
  const cloudinaryUrl = video.platform_urls?.[targetPlatform]
    || video.processed_url
    || buildCloudinaryUrl(video.source_url, targetPlatform);
  console.log('🔗 Usando Cloudinary URL:', cloudinaryUrl, '| modo:', artist.publish_mode);

  // Usar postType del frontend (reel/story), sino inferir
  const postType = frontendOptions.postType || video.post_type || (video.source_url.includes('/video/') ? 'reel' : 'feed');
  const options = buildPlatformOptions(video.source_url, platforms, postText, postType);

  // Agregar postType a las opciones para que uploadPostService lo use
  options.postType = postType === 'story' ? 'STORIES' : 'REELS';

  const result = await socialPublisher.publishPost(
    artist, postText, platforms, [cloudinaryUrl], options
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
// --- ELIMINAR ARTISTA Y SUS VIDEOS ---
exports.deleteArtist = async (artistId) => {
  // 1. Eliminar todos los videos del artista (por seguridad, aunque haya cascade)
  const { error: videosError } = await supabase
    .from('videos')
    .delete()
    .eq('artist_id', artistId);

  if (videosError) throw videosError;

  // 2. Eliminar el artista
  const { error: artistError } = await supabase
    .from('artists')
    .delete()
    .eq('id', artistId);

  if (artistError) throw artistError;

  return { ok: true, message: 'Artista y videos eliminados correctamente' };
};
