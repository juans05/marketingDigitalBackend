/**
 * clipScoringService.js — Vidalis API integration for clip viral scoring
 * Sends validated clips to Vidalis API to calculate viral scores
 */

const axios = require('axios');

function logDebug(message) {
  console.log(`⭐ [ClipScoring] ${message}`);
}

function logError(message) {
  console.error(`❌ [ClipScoring] ${message}`);
}

/**
 * Scores clips using Vidalis API for viral potential
 * Sends each validated clip to Vidalis for analysis and returns results with scores attached
 *
 * @param {Array<Object>} clips - Array of validated clips (from Task 4)
 *   Each clip: {momentId, path, duration, tags, validation: {confidence, ...}}
 * @param {string} videoId - Video ID for tracking/logging
 * @returns {Promise<Array<Object>>} Array of clips with score metadata attached
 *   Each result: {...clip, score: {viralScore, scoreBreakdown, recommendedPlatforms, scoredAt, error?}}
 * @throws {Error} If clips array is empty or invalid
 */
async function scoreClipsWithVidalis(clips, videoId) {
  // Validate input
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('Clips array is required');
  }

  const vidalisBaseUrl = process.env.VIDALIS_API_URL || 'http://localhost:3001';
  const vidalisApiKey = process.env.VIDALIS_API_KEY;
  const scoredClips = [];

  logDebug(`Starting to score ${clips.length} clips for video ${videoId}`);

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const clipIndex = i + 1;

    try {
      logDebug(`Scoring clip ${clipIndex}/${clips.length}`);

      // Prepare payload for Vidalis API
      const payload = {
        videoId: clip.momentId,
        clipPath: clip.path,
        metadata: {
          duration: clip.duration,
          validationScore: clip.validation?.confidence || 0.5,
          tags: clip.tags || [],
        },
      };

      // Make API call to Vidalis
      const response = await axios.post(
        `${vidalisBaseUrl}/vidalis/viral-score`,
        payload,
        {
          timeout: 60000,
          headers: {
            'Authorization': `Bearer ${vidalisApiKey}`,
          },
        }
      );

      const scoreData = response.data;

      // Add score metadata to clip
      scoredClips.push({
        ...clip,
        score: {
          viralScore: scoreData.viralScore || 0,
          scoreBreakdown: scoreData.breakdown || {},
          recommendedPlatforms: scoreData.platforms || ['tiktok'],
          scoredAt: new Date().toISOString(),
        },
      });

      logDebug(`Clip ${clipIndex} scored: ${scoreData.viralScore}`);
    } catch (error) {
      logError(`Scoring failed for clip ${clipIndex}: ${error.message}`);

      // Add clip with default score and error info on failure
      scoredClips.push({
        ...clip,
        score: {
          viralScore: 0,
          scoreBreakdown: {},
          recommendedPlatforms: ['tiktok'],
          scoredAt: new Date().toISOString(),
          error: error.message,
        },
      });
    }
  }

  logDebug(`Scored ${scoredClips.length} clips`);

  return scoredClips;
}

module.exports = { scoreClipsWithVidalis };
