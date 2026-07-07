const { createClient } = require('@supabase/supabase-js');
const aiService = require('./aiService');

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

  await supabase.from('videos').update({
    status: clipsCreated > 0 ? 'ready' : 'failed',
    error_log: clipsCreated > 0 ? null : JSON.stringify({ step: 'generateClips', message: 'Ningún clip se generó correctamente' }),
  }).eq('id', parentVideoId);
}

module.exports = { buildClipUrl, generateClips };
