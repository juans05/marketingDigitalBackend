const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

// Etapas del pipeline. Estos strings deben coincidir con el mapeo del frontend
// (RepurposerView.jsx → STAGE_TO_STEP).
const STAGES = {
  PROBING: 'probing',     // validando duración con ffprobe
  DETECTING: 'detecting', // Gemini detectando capítulos
  CUTTING: 'cutting',     // ffmpeg cortando + subiendo clips
  SCORING: 'scoring',     // Claude puntuando cada clip
};

// Persiste la etapa actual del video padre en ai_clips_data.stage y la loguea a
// stdout (visible en los logs de Railway). Nunca lanza: la observabilidad no
// debe tumbar el pipeline.
async function setStage(parentVideoId, stage) {
  console.log(`🔎 [Repurposer] ${parentVideoId} → etapa: ${stage}`);
  try {
    await supabase
      .from('videos')
      .update({ ai_clips_data: { stage, updated_at: new Date().toISOString() } })
      .eq('id', parentVideoId);
  } catch (err) {
    console.error(`⚠️ [Repurposer] No se pudo persistir la etapa "${stage}" de ${parentVideoId}:`, err.message);
  }
}

module.exports = { setStage, STAGES };
