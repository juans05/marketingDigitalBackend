const { createClient } = require('@supabase/supabase-js');
const aiService = require('./aiService');
const axios = require('axios');
const { setStage, STAGES } = require('./repurposeProgress');
const { resolveSupabaseServiceKey } = require('../lib/resolveSupabaseServiceKey');

// Import the 5 services from Tasks 1-5
const { transcribeVideo } = require('./transcriptionService');
const { detectMomentsWithClaude } = require('./momentDetectionService');
const { generateClips: generateClipsFromMoments, cleanupClips } = require('./clipGenerationService');
const { validateClipsWithGemini } = require('./clipValidationService');
const { scoreClipsWithClaude } = require('./clipScoringService');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  resolveSupabaseServiceKey('repurposerService')
);

function logDebug(msg) {
  console.log(msg);
}

function logError(msg) {
  console.error(msg);
}

/**
 * Helper to update database with orchestrator progress
 * @param {string} videoId - Video ID
 * @param {Object} data - Data to merge into ai_clips_data
 */
async function updateVideoClipsData(videoId, data) {
  try {
    const { data: existingVideo } = await supabase
      .from('videos')
      .select('ai_clips_data')
      .eq('id', videoId)
      .single();

    const currentData = existingVideo?.ai_clips_data || {};
    const newData = { ...currentData, ...data, updated_at: new Date().toISOString() };

    await supabase.from('videos').update({ ai_clips_data: newData }).eq('id', videoId);
  } catch (error) {
    logError(`⚠️ [Repurposer] Failed to update ai_clips_data for ${videoId}: ${error.message}`);
    // Don't re-throw - DB update failure shouldn't halt orchestration
  }
}

/**
 * Orchestrates the 5-service multi-IA pipeline
 * @param {string} videoPath - Path to the video file
 * @param {string} parentVideoId - Parent video ID in database
 * @returns {Promise<Array>} Array of scored clips
 */
async function generateClipsMultiIA(videoPath, parentVideoId) {
  let clipsDir = null;

  try {
    logDebug(`🎯 [Repurposer] ${parentVideoId} → Starting multi-IA pipeline`);

    // Stage 1: Transcribe
    await updateVideoClipsData(parentVideoId, { stage: 'transcribing' });
    logDebug(`🎯 [Repurposer] ${parentVideoId} → stage: transcribing`);
    const transcript = await transcribeVideo(videoPath, parentVideoId);

    // Stage 2: Detect moments
    await updateVideoClipsData(parentVideoId, { stage: 'analyzing' });
    logDebug(`🎯 [Repurposer] ${parentVideoId} → stage: analyzing`);
    const moments = await detectMomentsWithClaude(transcript.segments, '', parentVideoId);

    // Stage 3: Generate clips
    await updateVideoClipsData(parentVideoId, { stage: 'generating', totalClips: moments.length });
    logDebug(`🎯 [Repurposer] ${parentVideoId} → stage: generating`);
    const clips = await generateClipsFromMoments(videoPath, moments, parentVideoId);
    clipsDir = clips.length > 0 ? require('path').dirname(clips[0].path) : null;

    // Stage 4: Validate clips
    await updateVideoClipsData(parentVideoId, { stage: 'validating', totalClips: clips.length });
    logDebug(`🎯 [Repurposer] ${parentVideoId} → stage: validating`);
    const validatedClips = await validateClipsWithGemini(clips, parentVideoId);

    // Stage 5: Score clips
    await updateVideoClipsData(parentVideoId, { stage: 'scoring', totalClips: validatedClips.length });
    logDebug(`🎯 [Repurposer] ${parentVideoId} → stage: scoring`);
    const scoredClips = await scoreClipsWithClaude(validatedClips, parentVideoId);

    // Completion
    await updateVideoClipsData(parentVideoId, {
      stage: 'completed',
      clipCount: scoredClips.length,
      clips: scoredClips.map(c => ({
        index: c.index,
        startTime: c.startTime,
        endTime: c.endTime,
        duration: c.duration,
        validation: c.validation,
        score: c.score
      })),
      completedAt: new Date().toISOString(),
    });

    logDebug(`✅ [Repurposer] ${parentVideoId} completed`);
    return scoredClips;
  } catch (error) {
    logError(`❌ [Repurposer] ${parentVideoId} failed: ${error.message}`);
    await updateVideoClipsData(parentVideoId, {
      stage: 'error',
      errorMessage: error.message,
      errorTime: new Date().toISOString(),
    });
    throw error;
  } finally {
    if (clipsDir) {
      await cleanupClips(clipsDir);
    }
  }
}

function buildClipUrl(sourceUrl, startSeconds, endSeconds) {
  if (!sourceUrl || !sourceUrl.includes('cloudinary.com') || !sourceUrl.includes('/upload/')) {
    throw new Error(`buildClipUrl: la URL no es de Cloudinary: ${sourceUrl}`);
  }

  const cleanUrl = sourceUrl.replace(/\s+/g, '').split('?')[0];
  const regex = /^(https:\/\/res\.cloudinary\.com\/[^\/]+\/(?:video|image)\/upload\/)(?:[^\/]+\/)*(v\d+\/.*)$/;
  const match = cleanUrl.match(regex);

  if (!match) {
    throw new Error(`buildClipUrl: la URL de Cloudinary no estándar: ${cleanUrl}`);
  }

  const baseUrl = match[1];
  const publicId = match[2];
  const trans = `so_${startSeconds},eo_${endSeconds}`;
  return `${baseUrl}${trans}/${publicId}`;
}

async function generateClips(parentVideoId) {
  const { data: parent, error: parentErr } = await supabase
    .from('videos')
    .select('id, artist_id, title, source_url, platforms')
    .eq('id', parentVideoId)
    .single();
  if (parentErr || !parent) throw new Error(`Video padre no encontrado: ${parentVideoId}`);
  console.log(`🚀 [Repurposer] Iniciando generateClips para ${parentVideoId} ("${parent.title}")`);

  const { data: artist } = await supabase
    .from('artists')
    .select('id, name, ai_genre, ai_audience, ai_tone, active_platforms')
    .eq('id', parent.artist_id)
    .single();

  const artistContext = artist && (artist.ai_genre || artist.ai_audience || artist.ai_tone) ? {
    nombre: artist.name,
    genero: artist.ai_genre || null,
    audiencia: artist.ai_audience || null,
    tono: artist.ai_tone || null,
  } : null;

  const targetPlatforms = parent.platforms?.length ? parent.platforms
    : (artist?.active_platforms?.length ? artist.active_platforms : ['tiktok', 'instagram', 'youtube']);

  const learningContext = await aiService.fetchArtistLearningContext(parent.artist_id);

  // Idempotencia: si el job se re-entrega, borra los clips hijos previos para
  // no duplicar en la galería.
  await supabase.from('videos').delete().eq('parent_video_id', parentVideoId);

  // Guard de duración: probar ≤2h antes de gastar Gemini (solo en modo Python).
  const probeUrl = process.env.CLIPPER_SERVICE_URL;
  if (probeUrl) {
    await setStage(parentVideoId, STAGES.PROBING);
    try {
      const probe = await axios.post(`${probeUrl.replace(/\/+$/, '')}/probe`, { source_url: parent.source_url });
      console.log(`⏱️ [Repurposer] ${parentVideoId}: duración ${probe.data?.duration_seconds}s`);
      const dur = probe.data?.duration_seconds;
      if (dur && dur > 7200) {
        await supabase.from('videos').update({
          status: 'failed',
          error_log: JSON.stringify({ step: 'probe', message: `El video dura más de 2 horas (${Math.round(dur / 60)} min)` }),
        }).eq('id', parentVideoId);
        return;
      }
    } catch (err) {
      console.error(`⚠️ [Repurposer] /probe falló para ${parentVideoId}, se continúa:`, err.message);
    }
  }

  await setStage(parentVideoId, STAGES.DETECTING);
  console.log(`🧠 [Repurposer] ${parentVideoId}: detectando capítulos con Gemini...`);
  let segments;
  try {
    segments = await aiService.detectSegments(parent.source_url, parent.title);
  } catch (err) {
    await supabase.from('videos').update({
      status: 'failed',
      error_log: JSON.stringify({ step: 'detectSegments', message: err.message }),
    }).eq('id', parentVideoId);
    return;
  }

  if (!segments.length) {
    await supabase.from('videos').update({
      status: 'failed',
      error_log: JSON.stringify({ step: 'detectSegments', message: 'No se detectaron capítulos en el video' }),
    }).eq('id', parentVideoId);
    return;
  }

  console.log(`🎬 [Repurposer] ${parentVideoId}: ${segments.length} capítulos detectados`);
  let clipsCreated = 0;
  const clipperUrl = process.env.CLIPPER_SERVICE_URL;

  if (clipperUrl) {
    // Modo Python: Llamar al clipper-service
    try {
      await setStage(parentVideoId, STAGES.CUTTING);
      console.log(`✂️ [Repurposer] ${parentVideoId}: cortando ${segments.length} clips con ffmpeg...`);
      const response = await axios.post(`${clipperUrl.replace(/\/+$/, '')}/cut`, {
        source_url: parent.source_url,
        segments: segments.map(s => ({ start: s.start, end: s.end, title: s.title })),
        artist_id: parent.artist_id,
      });

      const pythonClips = response.data.clips || [];
      await setStage(parentVideoId, STAGES.SCORING);
      console.log(`⭐ [Repurposer] ${parentVideoId}: ${pythonClips.length} clips cortados, puntuando con Claude...`);

      for (const pyClip of pythonClips) {
        if (pyClip.status === 'failed') {
          console.error(`⚠️ [Repurposer] Segmento omitido por fallo en python: ${pyClip.error}`);
          continue;
        }

        try {
          const correspondingSegment = segments.find(s => s.title === pyClip.title);
          const reason = correspondingSegment ? correspondingSegment.reason : '';

          const copy = await aiService.generateCopyWithClaude(
            reason, null, pyClip.title, targetPlatforms, artistContext, learningContext
          );

          const { error: insertErr } = await supabase.from('videos').insert([{
            parent_video_id: parentVideoId,
            artist_id: parent.artist_id,
            title: pyClip.title,
            source_url: pyClip.secure_url,
            status: 'ready',
            viral_score_real: copy.viral_score,
            ai_clips_data: {
              start: pyClip.start,
              end: pyClip.end,
              reason: reason,
              ai_copy_short: copy.ai_copy_short,
              ai_copy_long: copy.ai_copy_long,
              hashtags: copy.hashtags,
            },
          }]);

          if (insertErr) {
            console.error(`⚠️ [Repurposer] Error guardando segmento (${pyClip.title}):`, insertErr.message);
            continue;
          }
          clipsCreated++;
        } catch (err) {
          console.error(`⚠️ [Repurposer] Error guardando segmento (${pyClip.title}):`, err.message);
        }
      }
    } catch (err) {
      console.error(`❌ [Repurposer] Error llamando al clipper-service:`, err.message);
      await supabase.from('videos').update({
        status: 'failed',
        error_log: JSON.stringify({ step: 'clipperService', message: err.message }),
      }).eq('id', parentVideoId);
      return;
    }
  } else {
    // Fallback: Modo original de Cloudinary dinámico por URL (útil para tests locales)
    for (const segment of segments) {
      try {
        const clipUrl = buildClipUrl(parent.source_url, segment.start, segment.end);
        const copy = await aiService.generateCopyWithClaude(
          segment.reason, null, segment.title, targetPlatforms, artistContext, learningContext
        );

        const { error: insertErr } = await supabase.from('videos').insert([{
          parent_video_id: parentVideoId,
          artist_id: parent.artist_id,
          title: segment.title,
          source_url: clipUrl,
          status: 'ready',
          viral_score_real: copy.viral_score,
          ai_clips_data: {
            start: segment.start,
            end: segment.end,
            reason: segment.reason,
            ai_copy_short: copy.ai_copy_short,
            ai_copy_long: copy.ai_copy_long,
            hashtags: copy.hashtags,
          },
        }]);
        if (insertErr) throw insertErr;
        clipsCreated++;
      } catch (err) {
        console.error(`⚠️ [Repurposer] Segmento omitido (${segment.title}):`, err.message);
      }
    }
  }

  const finalStatus = clipsCreated > 0 ? 'ready' : 'failed';
  console.log(`✅ [Repurposer] ${parentVideoId}: terminado con ${clipsCreated} clips (status: ${finalStatus})`);
  await supabase.from('videos').update({
    status: finalStatus,
    error_log: clipsCreated > 0 ? null : JSON.stringify({ step: 'generateClips', message: 'Ningún clip se generó correctamente' }),
  }).eq('id', parentVideoId);
}

/**
 * Downloads a video from a URL to a temporary file
 * @param {string} sourceUrl - URL of the video
 * @returns {Promise<string>} Path to the downloaded video file
 */
async function downloadVideoToTemp(sourceUrl) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  const tempDir = os.tmpdir();
  const fileName = `video_${Date.now()}.mp4`;
  const tempPath = path.join(tempDir, fileName);

  try {
    // Use ffmpeg to download and save the video
    // This is more reliable than axios for large files
    await execFileAsync('ffmpeg', [
      '-i', sourceUrl,
      '-c', 'copy',
      '-n',
      tempPath
    ], { timeout: 600000 }); // 10 minutes timeout for large videos

    logDebug(`Video downloaded to ${tempPath}`);
    return tempPath;
  } catch (error) {
    // Cleanup temp file if download failed
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {}
    logError(`Failed to download video from ${sourceUrl}: ${error.message}`);
    throw new Error(`Failed to download video: ${error.message}`);
  }
}

/**
 * Wrapper for orchestrator - fetches video from Supabase and calls generateClipsMultiIA
 * @param {string} parentVideoId - Video ID in database
 * @returns {Promise<Array>} Scored clips
 */
async function generateClipsMultiIAFromDatabase(parentVideoId) {
  const { data: parent, error: parentErr } = await supabase
    .from('videos')
    .select('id, source_url')
    .eq('id', parentVideoId)
    .single();

  if (parentErr || !parent) {
    throw new Error(`Video not found: ${parentVideoId}`);
  }

  if (!parent.source_url) {
    throw new Error(`Video has no source URL: ${parentVideoId}`);
  }

  let tempVideoPath = null;

  try {
    // Download video to temp location
    tempVideoPath = await downloadVideoToTemp(parent.source_url);

    // Call the orchestrator
    const scoredClips = await generateClipsMultiIA(tempVideoPath, parentVideoId);

    return scoredClips;
  } finally {
    // Clean up temp video file
    if (tempVideoPath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
        }
      } catch (err) {
        logError(`Failed to cleanup temp video ${tempVideoPath}: ${err.message}`);
      }
    }
  }
}

const MAX_DURATION_SECONDS = 7200; // 2 horas

// Anti-SSRF: sourceUrl lo manda el cliente y luego lo leen server-side tanto
// Gemini (buildVideoContentParts hace axios.get(mediaUrl)) como ffmpeg en el
// media service. Sin este check, un cliente podría apuntar a un host interno
// (ej. IP de metadata de la nube) y el backend lo iría a buscar por él.
function validateSourceUrl(sourceUrl) {
  let allowedHost;
  try {
    allowedHost = new URL(process.env.R2_PUBLIC_URL).hostname;
  } catch {
    throw new Error('R2_PUBLIC_URL no configurado');
  }
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error('sourceUrl inválida');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('sourceUrl debe ser http(s)');
  }
  if (parsed.hostname !== allowedHost) {
    throw new Error('sourceUrl no proviene de un origen permitido');
  }
  return sourceUrl;
}

async function createRepurposeVideo({ artistId, sourceUrl, title, durationSeconds }) {
  console.log(`📤 [Repurposer] createRepurposeVideo: artistId=${artistId}, sourceUrl=${sourceUrl}, title=${title}, durationSeconds=${durationSeconds}`);

  if (!artistId || !sourceUrl) {
    throw new Error('artistId y sourceUrl son requeridos');
  }
  validateSourceUrl(sourceUrl);
  if (durationSeconds && durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error(`El video dura más de 2 horas (${Math.round(durationSeconds / 60)} min) — no soportado todavía`);
  }

  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('id')
    .eq('id', artistId)
    .single();
  if (artistErr || !artist) throw new Error(`Artista no encontrado: ${artistId}`);

  const cleanSourceUrl = sourceUrl.replace(/\s+/g, '');
  const { data, error } = await supabase
    .from('videos')
    .insert([{
      artist_id: artistId,
      title: title || 'Video sin título',
      source_url: cleanSourceUrl,
      status: 'queued',
    }])
    .select();
  if (error) {
    console.error('❌ [Repurposer] Error insertando video en Supabase:', JSON.stringify(error));
    throw new Error(error.message || error.details || error.hint || 'Error guardando el video en la base de datos');
  }

  const video = data[0];
  console.log(`✅ [Repurposer] Video creado en Supabase: ${video.id}`);

  // Se separa del insert a propósito: si el insert ya funcionó pero encolar
  // falla (ej. RabbitMQ caído), la fila NO debe quedar huérfana en 'queued'
  // para siempre -- se marca 'failed' con el motivo real, en vez de que el
  // cliente reciba un error genérico sin saber que el video sí se guardó.
  try {
    const { publishRepurposeJob } = require('../lib/queue');
    await publishRepurposeJob(video.id);
    console.log(`📤 [Repurposer] Job encolado en RabbitMQ: ${video.id} (artista ${artistId})`);
  } catch (queueErr) {
    console.error(`❌ [Repurposer] No se pudo encolar el job para ${video.id}:`, queueErr.message);
    await supabase.from('videos').update({
      status: 'failed',
      error_log: JSON.stringify({ step: 'publishRepurposeJob', message: queueErr.message }),
    }).eq('id', video.id);
    throw new Error(`El video se guardó pero no se pudo encolar para procesar: ${queueErr.message}`);
  }

  return video;
}

module.exports = {
  buildClipUrl,
  generateClips,
  generateClipsMultiIA,
  generateClipsMultiIAFromDatabase,
  createRepurposeVideo,
  MAX_DURATION_SECONDS,
  validateSourceUrl,
  updateVideoClipsData,
};
