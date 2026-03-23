const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ ERROR: Faltan SUPABASE_URL o SUPABASE_ANON_KEY en las variables de entorno.");
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);

// --- AUTENTICACIÓN (MVP) ---
exports.loginUser = async (email, password) => {
  const { data, error } = await supabase
    .from('agencies')
    .select('*')
    .ilike('name', `%${email.split('@')[0]}%`)
    .limit(1);

  if (!data || data.length === 0) {
    const { data: newAgency, error: createErr } = await supabase
      .from('agencies')
      .insert([{ name: email, plan_type: 'Pro' }])
      .select();

    if (createErr) throw new Error('Error al crear cuenta');

    return {
      id: newAgency[0].id,
      email: email,
      agency: newAgency[0].name,
      plan: newAgency[0].plan_type
    };
  }

  return {
    id: data[0].id,
    email: email,
    agency: data[0].name,
    plan: data[0].plan_type
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

exports.registerVideo = async (videoData) => {
  // 0. Recorte Inteligente 9:16 con IA (Solo para videos de Cloudinary)
  if (videoData.source_url.includes('cloudinary.com') && videoData.source_url.match(/\.(mp4|mov|webm|ogv)$/i)) {
    // Inyectamos la transformación de Cloudinary: c_fill (llenar), g_auto (IA para centrar), ar_9:16 (aspect ratio)
    videoData.processed_url = videoData.source_url.replace('/upload/', '/upload/c_fill,g_auto,ar_9:16/');
  } else if (videoData.source_url.includes('cloudinary.com')) {
    // Para imágenes, también podemos asegurar un buen reencuadre si fuera necesario
    // videoData.processed_url = videoData.source_url.replace('/upload/', '/upload/c_fill,g_auto/');
    videoData.processed_url = videoData.source_url;
  }

  // 1. Guardar en Supabase
  const { data, error } = await supabase
    .from('videos')
    .insert([videoData])
    .select();

  if (error) throw error;
  const video = data[0];
  console.log(`✅ Video registrado en DB: ${video.id}`);

  // 2. Obtener datos de la agencia para el profileKey y plataformas
  console.log(`🔍 Buscando datos vinculados al ID: ${videoData.artist_id}`);
  
  let agency = null;

  // Primero intentamos buscar como artista
  const { data: artist } = await supabase
    .from('artists')
    .select('agency_id')
    .eq('id', videoData.artist_id)
    .single();

  if (artist) {
    console.log(`🔍 Artista encontrado. Buscando su agencia: ${artist.agency_id}`);
    const { data: agencyData } = await supabase
      .from('agencies')
      .select('ayrshare_profile_key, active_platforms')
      .eq('id', artist.agency_id)
      .single();
    agency = agencyData;
  } else {
    // Si no es artista, quizás sea el ID de la agencia directamente (MVP Login)
    console.log(`🔍 No es artista. Buscando como agencia directa: ${videoData.artist_id}`);
    const { data: agencyData } = await supabase
      .from('agencies')
      .select('ayrshare_profile_key, active_platforms')
      .eq('id', videoData.artist_id)
      .single();
    agency = agencyData;
  }

  if (!agency) {
    console.log(`⚠️ No se pudo vincular con ninguna agencia. Se usarán datos por defecto.`);
  }

  // 3. Disparar flujo de n8n (Procesamiento IA + Distribución)
  if (process.env.N8N_WEBHOOK_URL) {
    try {
      console.log(`🚀 Intentando disparar n8n: ${process.env.N8N_WEBHOOK_URL}`);
      const payload = {
        videoUrl: video.processed_url || video.source_url,
        videoId: video.id,
        title: video.title,
        profileKey: agency?.ayrshare_profile_key || null,
        platforms: video.platforms || agency?.active_platforms || ['tiktok', 'instagram', 'youtube']
      };
      
      await axios.post(process.env.N8N_WEBHOOK_URL, payload);
      console.log(`✅ n8n disparado con éxito para video: ${video.id}`);
    } catch (err) {
      console.error('❌ Error al disparar n8n:', err.response?.data || err.message);
    }
  } else {
    console.warn('⚠️ N8N_WEBHOOK_URL no está configurado en el .env');
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

// --- ESTADÍSTICAS GLOBALES DEL DASHBOARD ---
exports.getDashboardStats = async (agencyId) => {
  const { data: videos, error } = await supabase
    .from('videos')
    .select('viral_score, status, created_at')
    .eq('agency_id', agencyId);

  if (error) throw error;

  const total = videos.length;
  const published = videos.filter(v => v.status === 'published' || v.status === 'scheduled').length;
  const scores = videos.filter(v => v.viral_score).map(v => v.viral_score);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
    : 0;

  return { total, published, avgScore };
};

// --- CONECTAR REDES SOCIALES (Ayrshare) ---
exports.connectSocialAccounts = async (agencyId) => {
  const ayrshareService = require('./ayrshareService');

  const { data: agencies, error } = await supabase
    .from('agencies')
    .select('id, name, ayrshare_profile_key')
    .eq('id', agencyId)
    .limit(1);

  if (error) throw new Error(`Error Supabase: ${error.message}`);
  if (!agencies || agencies.length === 0) throw new Error(`Agencia no encontrada para id: ${agencyId}`);
  const agency = agencies[0];

  let profileKey = agency.ayrshare_profile_key;

  if (!profileKey) {
    const profile = await ayrshareService.createProfile(agency.name);
    profileKey = profile.profileKey;
    await supabase.from('agencies').update({ ayrshare_profile_key: profileKey }).eq('id', agencyId);
  }

  const jwt = await ayrshareService.generateJWT(profileKey);
  return { url: jwt.url, profileKey };
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
  // Fallback si n8n no está configurado
  return { score: 0, feedback: "n8n no configurado aún." };
};

// --- ACTUALIZAR CONFIGURACIÓN DE VIDEO (Programación, Hashtags, etc.) ---
exports.updateVideoSettings = async (videoId, updateData) => {
  const { data, error } = await supabase
    .from('videos')
    .update(updateData)
    .eq('id', videoId)
    .select();

  if (error) throw error;
  return data[0];
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
