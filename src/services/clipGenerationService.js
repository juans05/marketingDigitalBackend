const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function logDebug(msg) {
  console.log(`✂️ [ClipGeneration] ${msg}`);
}

function logError(msg) {
  console.error(`❌ [ClipGeneration] ${msg}`);
}

/**
 * Validates file path to prevent command injection
 * @param {string} filePath - File path to validate
 * @param {string} paramName - Parameter name for error messages
 * @throws {Error} If path is invalid
 */
function validateFilePath(filePath, paramName) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`Invalid ${paramName}: must be a non-empty string`);
  }

  // Reject paths starting with '-' to prevent flag injection
  if (filePath.startsWith('-')) {
    throw new Error(`Invalid ${paramName}: paths cannot start with '-'`);
  }

  // Reject paths with suspicious shell metacharacters
  if (/[;&|`$()]/.test(filePath)) {
    throw new Error(`Invalid ${paramName}: contains suspicious characters`);
  }

  return filePath;
}

/**
 * Generates video clips from detected moments using ffmpeg (fast copy, no re-encoding)
 * @param {string} videoPath - Path to the source video file
 * @param {Array} moments - Array of moments with {start, end, index, ...}
 * @param {string} videoId - Video ID for naming temp directory
 * @returns {Promise<Array>} Array of clip metadata: {index, path, momentId, startTime, endTime, duration, sizeBytes, reason, tags}
 * @throws {Error} If video doesn't exist or no clips are generated
 */
async function generateClips(videoPath, moments, videoId) {
  // Validate input
  validateFilePath(videoPath, 'videoPath');

  if (!fs.existsSync(videoPath)) {
    throw new Error('Video file not found');
  }

  if (!Array.isArray(moments) || moments.length === 0) {
    throw new Error('Moments array cannot be empty');
  }

  logDebug(`Starting clip generation for ${videoId} with ${moments.length} moments`);

  // Create temp directory for clips
  const clipsDir = path.join(os.tmpdir(), `clips_${videoId}_${Date.now()}`);
  try {
    fs.mkdirSync(clipsDir, { recursive: true });
  } catch (error) {
    logError(`Failed to create clips directory: ${error.message}`);
    throw new Error(`Failed to create clips directory: ${error.message}`);
  }

  const clips = [];
  const failedClips = [];

  // Generate clip for each moment
  for (const moment of moments) {
    const clipIndex = moment.index || clips.length + failedClips.length + 1;
    const clipPath = path.join(clipsDir, `clip_${clipIndex}.mp4`);

    try {
      logDebug(`Generating clip ${clipIndex}: ${moment.start}s to ${moment.end}s`);

      // Use execFile with argv array to prevent shell injection
      // FFmpeg arguments:
      // -i : input file
      // -ss : start time in seconds
      // -to : end time in seconds
      // -c:v copy : copy video codec (no re-encoding)
      // -c:a copy : copy audio codec (no re-encoding)
      // -n : never overwrite output files
      await execFileAsync('ffmpeg', [
        '-i', videoPath,
        '-ss', String(moment.start),
        '-to', String(moment.end),
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-n',
        clipPath
      ], { timeout: 60000 });

      // Get file size
      const stats = fs.statSync(clipPath);

      clips.push({
        index: clipIndex,
        path: clipPath,
        momentId: moment.index || clipIndex,
        startTime: moment.start,
        endTime: moment.end,
        duration: moment.end - moment.start,
        sizeBytes: stats.size,
        reason: moment.reason || '',
        tags: moment.tags || []
      });

      logDebug(`Clip ${clipIndex} generated: ${stats.size} bytes`);
    } catch (error) {
      logError(`Failed to generate clip ${clipIndex}: ${error.message}`);
      failedClips.push(clipIndex);
      // Continue to next clip instead of throwing
      continue;
    }
  }

  // Validate that at least one clip was generated
  if (clips.length === 0) {
    // Cleanup directory
    try {
      fs.rmSync(clipsDir, { recursive: true, force: true });
    } catch {}

    logError(`Failed to generate any clips from ${moments.length} moments`);
    throw new Error('Failed to generate any clips from provided moments');
  }

  if (failedClips.length > 0) {
    logDebug(`Generated ${clips.length}/${moments.length} clips (${failedClips.length} failed)`);
  } else {
    logDebug(`Generated ${clips.length} clips successfully`);
  }

  return clips;
}

/**
 * Cleans up temporary clip directory
 * @param {string} clipDir - Path to the clips directory to delete
 * @returns {Promise<void>}
 */
async function cleanupClips(clipDir) {
  try {
    if (!clipDir || typeof clipDir !== 'string') {
      return;
    }

    if (fs.existsSync(clipDir)) {
      fs.rmSync(clipDir, { recursive: true, force: true });
      logDebug(`Cleaned up clips directory: ${clipDir}`);
    }
  } catch (error) {
    logError(`Failed to cleanup clips directory: ${error.message}`);
    // Don't throw - cleanup failure is not critical
  }
}

module.exports = {
  generateClips,
  cleanupClips
};
