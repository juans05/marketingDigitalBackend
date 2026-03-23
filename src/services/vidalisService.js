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
      // Filtrar plataformas si es imagen (TikTok y YouTube requieren video)
      let targetPlatforms = (video.platforms?.length ? video.platforms : null) || 
                          (artist.active_platforms?.length ? artist.active_platforms : null) || 
                          ['tiktok', 'instagram', 'facebook', 'youtube'];

      if (!looksLikeVideo) {
        targetPlatforms = targetPlatforms.filter(p => !['tiktok', 'youtube'].includes(p.toLowerCase()));
      }

      await axios.post(process.env.N8N_WEBHOOK_URL, {
        videoUrl: video.processed_url || video.source_url,
        videoId: video.id,
        title: video.title,
        mediaType: looksLikeVideo ? 'video' : 'image',
        profileKey: artist.ayrshare_profile_key || null,
        platforms: targetPlatforms,
      });
      console.log(`✅ n8n disparado para video: ${video.id}`);
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

  // 2. Si hay fecha programada y el artista tiene Ayrshare conectado → programar
  if (updateData.scheduled_at && artist?.ayrshare_profile_key) {
    try {
      const ayrshareService = require('./ayrshareService');
      const mediaUrl = video.processed_url || video.source_url;
      const postText = updateData.hashtags || video.title || 'Nuevo contenido';
      const platforms = updateData.platforms || ['tiktok', 'instagram', 'youtube'];

      const result = await ayrshareService.schedulePost(
        postText,
        platforms,
        [mediaUrl],
        new Date(updateData.scheduled_at).toISOString(),
        artist.ayrshare_profile_key
      );

      // Guardar el post_id de Ayrshare para poder rastrearlo
      if (result.id || result.postIds) {
        updateData.ayrshare_post_id = result.id || result.postIds?.[0] || null;
      }
      console.log(`✅ Post programado en Ayrshare para video: ${videoId}`);
    } catch (err) {
      console.error('❌ Error al programar en Ayrshare:', err.response?.data || err.message);
      // No lanzamos el error — guardamos en DB igual para no perder la configuración
    }
  } else if (updateData.scheduled_at && !artist?.ayrshare_profile_key) {
    console.warn(`⚠️ Video ${videoId} programado en DB pero artista sin Ayrshare conectado`);
  }

  // 3. Guardar en DB
  const { data, error } = await supabase
    .from('videos')
    .update(updateData)
    .eq('id', videoId)
    .select();
  if (error) throw error;
  return data[0];
};

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

  const mediaUrl = video.processed_url || video.source_url;
  const postText = video.hashtags || video.title || 'Nuevo contenido';
  const platforms = video.platforms?.length ? video.platforms
    : artist.active_platforms?.length ? artist.active_platforms
    : ['tiktok', 'instagram'];

  const result = await ayrshareService.publishPost(
    postText, platforms, [mediaUrl], artist.ayrshare_profile_key
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
