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

      const title = clip.reason
        ? clip.reason.slice(0, 80)
        : `${parentTitle || 'Video'} — clip ${clip.index}`;

      const { data, error } = await supabase.from('videos').insert([{
        parent_video_id: parentVideoId,
        artist_id: artistId,
        title,
        source_url: sourceUrl,
        status: 'ready',
        viral_score_real: clip.score?.viralScore ?? null,
        ai_clips_data: {
          start: clip.startTime,
          end: clip.endTime,
          duration: clip.duration,
          reason: clip.reason || '',
          tags: clip.tags || [],
          validation: clip.validation || null,
          score_breakdown: clip.score?.scoreBreakdown || null,
          ai_copy_short: clip.score?.adCopy?.short || '',
          ai_copy_long: clip.score?.adCopy?.long || '',
          hashtags: clip.score?.adCopy?.hashtags || '',
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
