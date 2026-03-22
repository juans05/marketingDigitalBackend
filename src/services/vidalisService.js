const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ ERROR: Faltan SUPABASE_URL o SUPABASE_ANON_KEY en las variables de entorno.");
  throw new Error("supabaseUrl is required. Por favor, configura las variables de entorno en tu panel de hosting.");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
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

// --- REGISTRO DE VIDEOS + DISPARO A n8n ---
exports.registerVideo = async (videoData) => {
  // 1. Guardar en Supabase
  const { data, error } = await supabase
    .from('videos')
    .insert([videoData])
    .select();

  if (error) throw error;
  const video = data[0];

  // 2. Obtener datos de la agencia para el profileKey y plataformas
  const { data: artist } = await supabase
    .from('artists')
    .select('agency_id')
    .eq('id', videoData.artist_id)
    .single();

  if (artist) {
    const { data: agency } = await supabase
      .from('agencies')
      .select('ayrshare_profile_key, active_platforms')
      .eq('id', artist.agency_id)
      .single();

    // 3. Disparar flujo de n8n (Procesamiento IA + Distribución)
    if (process.env.N8N_WEBHOOK_URL) {
      try {
        await axios.post(process.env.N8N_WEBHOOK_URL, {
          videoUrl: videoData.source_url,
          videoId: video.id,
          title: videoData.title,
          profileKey: agency?.ayrshare_profile_key,
          platforms: agency?.active_platforms || ['tiktok', 'instagram', 'youtube']
        });
        console.log(`🚀 n8n disparado para video: ${video.id} con perfil: ${agency?.ayrshare_profile_key}`);
      } catch (err) {
        console.error('⚠️ Error al disparar n8n:', err.message);
      }
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
