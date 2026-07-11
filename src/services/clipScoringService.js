/**
 * clipScoringService.js — Claude-based viral scoring for repurposer clips
 *
 * Reuses aiService.generateCopyWithClaude — the same marketing-framework
 * scoring Claude call that scores regular uploaded videos — instead of
 * calling a "Vidalis API" over HTTP. There is no such external API: the
 * old clipScoringService POSTed to /vidalis/viral-score, a route that
 * requires user JWT auth and, even correctly reached, just proxies to an
 * unconfigured n8n webhook stub ({score: 0, "n8n no configurado aún."}).
 * The real scoring has always been a direct in-process Claude call.
 */

const { createClient } = require('@supabase/supabase-js');
const aiService = require('./aiService');
const { resolveSupabaseServiceKey } = require('../lib/resolveSupabaseServiceKey');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  resolveSupabaseServiceKey('clipScoringService')
);

function logDebug(message) {
  console.log(`⭐ [ClipScoring] ${message}`);
}

function logError(message) {
  console.error(`❌ [ClipScoring] ${message}`);
}

/**
 * Builds the artist context + platform list + learning context the same
 * way the pre-multiIA generateClips() flow does, so scoring behaves
 * identically to how regular videos get scored for this artist.
 */
async function loadScoringContext(parentVideoId) {
  const { data: parent, error: parentErr } = await supabase
    .from('videos')
    .select('id, artist_id, title, platforms')
    .eq('id', parentVideoId)
    .single();

  if (parentErr || !parent) {
    throw new Error(`Video padre no encontrado: ${parentVideoId}`);
  }

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

  return { parentTitle: parent.title, artistContext, targetPlatforms, learningContext };
}

/**
 * generateCopyWithClaude expects a "geminiAnalysis" text describing what's
 * visible in the content. Calling Gemini a second time per clip here would
 * double the Gemini quota usage on top of clipValidationService's per-clip
 * call, so we build that description from what validation already found
 * instead of making another Gemini request.
 */
function buildAnalysisText(clip) {
  const parts = [];
  if (clip.reason) {
    parts.push(`Por qué este momento fue seleccionado del video original: ${clip.reason}`);
  }
  if (clip.validation) {
    const { hasVisualHook, confidence, suggestions } = clip.validation;
    parts.push(`Análisis visual (Gemini): gancho visual ${hasVisualHook ? 'presente' : 'débil o ausente'} (confianza ${confidence}).`);
    if (suggestions?.length) {
      parts.push(`Sugerencias de mejora visual: ${suggestions.join('; ')}`);
    }
  }
  if (clip.tags?.length) {
    parts.push(`Tags detectados: ${clip.tags.join(', ')}`);
  }
  return parts.join('\n') || 'Clip extraído de un video más largo, sin análisis visual adicional disponible.';
}

/**
 * Scores repurposer clips using the same Claude marketing-framework
 * analysis that scores regular uploaded videos.
 *
 * @param {Array<Object>} clips - Validated clips (from clipValidationService)
 * @param {string} parentVideoId - Parent video ID, used to load artist/learning context
 * @returns {Promise<Array<Object>>} Clips with score metadata attached
 * @throws {Error} If clips array is empty or invalid
 */
async function scoreClipsWithClaude(clips, parentVideoId) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('Clips array is required');
  }

  const { parentTitle, artistContext, targetPlatforms, learningContext } = await loadScoringContext(parentVideoId);
  const scoredClips = [];

  logDebug(`Starting to score ${clips.length} clips for video ${parentVideoId}`);

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const clipIndex = i + 1;
    const clipTitle = clip.reason ? clip.reason.slice(0, 60) : `${parentTitle || 'Video'} — clip ${clip.index}`;

    try {
      logDebug(`Scoring clip ${clipIndex}/${clips.length}`);

      const analysisText = buildAnalysisText(clip);
      const copy = await aiService.generateCopyWithClaude(
        analysisText,
        null,
        clipTitle,
        targetPlatforms,
        artistContext,
        learningContext
      );

      scoredClips.push({
        ...clip,
        score: {
          viralScore: copy.viral_score,
          scoreBreakdown: copy.marketing_breakdown || {},
          recommendedPlatforms: targetPlatforms,
          adCopy: {
            short: copy.ai_copy_short || '',
            long: copy.ai_copy_long || '',
            hashtags: copy.hashtags || '',
          },
          scoredAt: new Date().toISOString(),
        },
      });

      logDebug(`Clip ${clipIndex} scored: ${copy.viral_score}`);
    } catch (error) {
      logError(`Scoring failed for clip ${clipIndex}: ${error.message}`);

      scoredClips.push({
        ...clip,
        score: {
          viralScore: 0,
          scoreBreakdown: {},
          recommendedPlatforms: targetPlatforms,
          adCopy: { short: '', long: '', hashtags: '' },
          scoredAt: new Date().toISOString(),
          error: error.message,
        },
      });
    }
  }

  logDebug(`Scored ${scoredClips.length} clips`);

  return scoredClips;
}

module.exports = { scoreClipsWithClaude };
