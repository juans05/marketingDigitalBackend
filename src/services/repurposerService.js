const { createClient } = require('@supabase/supabase-js');
const aiService = require('./aiService');
const axios = require('axios');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

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

  let clipsCreated = 0;
  const clipperUrl = process.env.CLIPPER_SERVICE_URL;

  if (clipperUrl) {
    // Modo Python: Llamar al clipper-service
    try {
      const tempVideoId = parent.source_url.split('/').pop();
      const response = await axios.post(`${clipperUrl.replace(/\/+$/, '')}/cut`, {
        video_id: tempVideoId,
        segments: segments.map(s => ({
          start: s.start,
          end: s.end,
          title: s.title
        })),
        artist_id: parent.artist_id
      });

      const pythonClips = response.data.clips || [];

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

          if (insertErr) throw insertErr;
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

  await supabase.from('videos').update({
    status: clipsCreated > 0 ? 'ready' : 'failed',
    error_log: clipsCreated > 0 ? null : JSON.stringify({ step: 'generateClips', message: 'Ningún clip se generó correctamente' }),
  }).eq('id', parentVideoId);
}

const MAX_DURATION_SECONDS = 7200; // 2 horas

async function createRepurposeVideo({ artistId, sourceUrl, title, durationSeconds }) {
  if (!artistId || !sourceUrl) {
    throw new Error('artistId y sourceUrl son requeridos');
  }
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
  if (error) throw error;

  const video = data[0];

  const { publishRepurposeJob } = require('../lib/queue');
  await publishRepurposeJob(video.id);

  return video;
}

module.exports = { buildClipUrl, generateClips, createRepurposeVideo, MAX_DURATION_SECONDS };
