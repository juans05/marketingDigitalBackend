/**
 * clipPersistenceService.js — Uploads scored repurposer clips to R2 and
 * creates one child row per clip in the `videos` table.
 *
 * Without this step, generateClipsMultiIA() computed everything (moments,
 * clips, validation, scores) but never persisted the clip files anywhere
 * permanent (they lived in /tmp and got deleted by cleanupClips()) or
 * created the child video rows the existing gallery/results UI reads via
 * getClipsByParent() (`videos` WHERE parent_video_id = parent). The result
 * completed successfully but had nothing to show.
 */

const { createClient } = require('@supabase/supabase-js');
const { uploadFileToR2 } = require('../lib/r2');
const { resolveSupabaseServiceKey } = require('../lib/resolveSupabaseServiceKey');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  resolveSupabaseServiceKey('clipPersistenceService')
);

function logDebug(message) {
  console.log(`💾 [ClipPersistence] ${message}`);
}

function logError(message) {
  console.error(`❌ [ClipPersistence] ${message}`);
}

/**
 * Truncates at a word boundary instead of mid-word, and only when actually
 * needed. `reason.slice(0, 80)` was producing titles like "...con frase" —
 * cut off wherever 80 characters happened to land, sometimes mid-word.
 */
function truncateAtWord(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLength * 0.5 ? truncated.slice(0, lastSpace) : truncated).trim() + '…';
}

/**
 * Prefers the short ad copy Claude wrote specifically as a punchy caption
 * over the moment's "reason" (an analytical explanation of why it's a good
 * clip, not meant to read as a title — e.g. "Momento desgarrador de una
 * madre protegiendo a su hijo infectado/herido mientras el barco...").
 */
function buildClipTitle(clip, parentTitle, index) {
  const candidate = clip.score?.copy_short?.trim() || clip.reason?.trim();
  if (!candidate) return `${parentTitle || 'Video'} — clip ${index}`;
  return truncateAtWord(candidate, 80);
}

function joinHashtags(hashtagsSuggested) {
  return Array.isArray(hashtagsSuggested) && hashtagsSuggested.length > 0
    ? hashtagsSuggested.join(' ')
    : null;
}

/**
 * Uploads each clip file to R2 and inserts a child `videos` row for it,
 * matching the shape the old Python-clipper flow already produces
 * (parent_video_id, artist_id, title, source_url, status, viral_score_real,
 * ai_clips_data) so the existing results gallery works unchanged.
 *
 * @param {Array<Object>} scoredClips - Clips with .path (local file), .score, .validation, .reason, .tags
 * @param {string} parentVideoId
 * @param {string} artistId
 * @param {string} parentTitle
 * @returns {Promise<Array<string>>} IDs of the created clip rows (failed clips are skipped, not thrown)
 */
async function persistClipsToDatabase(scoredClips, parentVideoId, artistId, parentTitle = '') {
  if (!Array.isArray(scoredClips) || scoredClips.length === 0) {
    throw new Error('scoredClips array is required');
  }

  // Idempotency: a re-delivered job would otherwise duplicate clips in the gallery.
  await supabase.from('videos').delete().eq('parent_video_id', parentVideoId);

  const createdIds = [];

  for (const clip of scoredClips) {
    try {
      const r2Key = `repurposer/clips/${parentVideoId}/${clip.index}_${Date.now()}.mp4`;
      const sourceUrl = await uploadFileToR2(clip.path, r2Key, 'video/mp4');
      logDebug(`Clip ${clip.index} uploaded to R2: ${r2Key}`);

      const title = buildClipTitle(clip, parentTitle, clip.index);

      // Top-level ai_copy_short/ai_copy_long/hashtags/marketing_breakdown mirror
      // exactly what processVideoAI() sets for normal videos — the main gallery
      // (fetchArtistGallery) reads those top-level columns, not ai_clips_data.
      // clip_impact_score is the new rubric's dedicated column (see
      // clipImpactScoringService); viral_score/viral_score_real are
      // intentionally NOT reused for clips — they stay null on clip rows.
      const hashtags = joinHashtags(clip.score?.hashtags_suggested);
      const { data, error } = await supabase.from('videos').insert([{
        parent_video_id: parentVideoId,
        artist_id: artistId,
        title,
        source_url: sourceUrl,
        status: 'ready',
        viral_score: null,
        viral_score_real: null,
        clip_impact_score: clip.score?.score ?? null,
        ai_copy_short: clip.score?.copy_short || null,
        ai_copy_long: clip.score?.copy_long || null,
        hashtags,
        marketing_breakdown: clip.score?.score_breakdown || null,
        ai_clips_data: {
          start: clip.startTime,
          end: clip.endTime,
          duration: clip.duration,
          reason: clip.reason || '',
          tags: clip.tags || [],
          validation: clip.validation || null,
          score_breakdown: clip.score?.score_breakdown || null,
          ai_copy_short: clip.score?.copy_short || '',
          ai_copy_long: clip.score?.copy_long || '',
          hashtags: hashtags || '',
        },
      }]).select();

      if (error) throw error;

      createdIds.push(data[0].id);
      logDebug(`Clip ${clip.index} persisted as video ${data[0].id}`);
    } catch (error) {
      logError(`Failed to persist clip ${clip.index}: ${error.message}`);
      // Continue with remaining clips — one bad upload/insert shouldn't lose the rest
    }
  }

  logDebug(`Persisted ${createdIds.length}/${scoredClips.length} clips`);
  return createdIds;
}

module.exports = { persistClipsToDatabase };
