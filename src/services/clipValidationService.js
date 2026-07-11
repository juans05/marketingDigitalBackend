/**
 * clipValidationService.js — Gemini Vision-based clip validation
 * Analyzes key frames from video clips to validate visual hooks and engagement potential
 */

const { getGemini } = require('../lib/gemini');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function logDebug(message) {
  console.log(`✅ [ClipValidation] ${message}`);
}

function logError(message) {
  console.error(`❌ [ClipValidation] ${message}`);
}

/**
 * Extracts the duration of a video clip using ffprobe
 * @param {string} clipPath - Path to the video clip
 * @returns {Promise<number>} Duration in seconds
 * @throws {Error} If ffprobe fails
 */
async function getClipDuration(clipPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1:nokey=1',
      clipPath
    ]);
    return parseFloat(stdout.trim());
  } catch (error) {
    logError(`Failed to get duration for ${clipPath}: ${error.message}`);
    throw error;
  }
}

/**
 * Extracts a single frame from a video at a specific timestamp
 * @param {string} clipPath - Path to the video clip
 * @param {number} timestamp - Timestamp in seconds
 * @param {string} outputPath - Path where the frame will be saved
 * @returns {Promise<void>}
 */
async function extractFrame(clipPath, timestamp, outputPath) {
  try {
    await execFileAsync('ffmpeg', [
      '-ss', String(timestamp),
      '-i', clipPath,
      '-vframes', '1',
      '-q:v', '2',
      '-n',
      outputPath
    ], { timeout: 30000 });
  } catch (error) {
    logError(`Failed to extract frame at ${timestamp}s: ${error.message}`);
    throw error;
  }
}

/**
 * Extracts 3 key frames from a clip (start, middle, end)
 * Falls back to single frame if extraction fails
 * @param {string} clipPath - Path to the video clip
 * @returns {Promise<Array<string>>} Array of frame file paths
 */
async function extractKeyFrames(clipPath) {
  const framesDir = path.join(os.tmpdir(), `frames_${Date.now()}_${Math.random().toString(36).substring(7)}`);

  try {
    fs.mkdirSync(framesDir, { recursive: true });

    // Get video duration
    let duration;
    try {
      duration = await getClipDuration(clipPath);
    } catch (error) {
      logError(`Failed to get clip duration, using fallback: ${error.message}`);
      duration = 30; // Fallback duration
    }

    // Extract frames at start, middle, end
    const timestamps = [0, duration / 2, Math.max(0, duration - 1)];
    const framePaths = [];
    let successCount = 0;

    for (let i = 0; i < timestamps.length; i++) {
      const framePath = path.join(framesDir, `frame_${i}.jpg`);
      try {
        await extractFrame(clipPath, timestamps[i], framePath);
        if (fs.existsSync(framePath)) {
          framePaths.push(framePath);
          successCount++;
        }
      } catch (error) {
        logError(`Failed to extract frame ${i} at ${timestamps[i]}s: ${error.message}`);
        continue; // Try next frame
      }
    }

    // If we couldn't extract any frames, try single frame at start
    if (successCount === 0) {
      logError('Failed to extract key frames, attempting fallback single frame');
      const fallbackFramePath = path.join(framesDir, 'frame_fallback.jpg');
      try {
        await extractFrame(clipPath, 0, fallbackFramePath);
        if (fs.existsSync(fallbackFramePath)) {
          framePaths.push(fallbackFramePath);
        }
      } catch (error) {
        logError(`Fallback frame extraction failed: ${error.message}`);
      }
    }

    return framePaths;
  } catch (error) {
    // Cleanup on error
    try {
      if (fs.existsSync(framesDir)) {
        fs.rmSync(framesDir, { recursive: true, force: true });
      }
    } catch {}
    throw error;
  }
}

/**
 * Analyzes frames using Gemini Vision API
 * @param {Array<string>} framePaths - Array of frame file paths
 * @returns {Promise<Object>} Analysis result: {hasHook, confidence, improvements}
 */
async function analyzeFramesWithGemini(framePaths) {
  if (!framePaths || framePaths.length === 0) {
    throw new Error('No frames to analyze');
  }

  try {
    const model = getGemini().getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Build request with frame images
    const parts = [];

    for (const framePath of framePaths) {
      try {
        const imageBuffer = fs.readFileSync(framePath);
        const base64 = imageBuffer.toString('base64');
        parts.push({
          inlineData: {
            data: base64,
            mimeType: 'image/jpeg'
          }
        });
      } catch (error) {
        logError(`Failed to read frame ${framePath}: ${error.message}`);
        // Continue with available frames
      }
    }

    if (parts.length === 0) {
      throw new Error('Could not load any frame images');
    }

    // Add analysis prompt in Spanish
    const analysisPrompt = `Analiza estos frames de un clip de video corto (15-90 segundos).

Evalúa:
1. ¿Tiene un gancho visual fuerte? (impacto visual, cambio de expresión, elemento sorpresivo)
2. ¿La composición mantiene la atención?
3. ¿Hay potencial de retención en las primeras 3 segundos?

Responde SOLO con JSON válido, sin markdown:
{
  "hasHook": true/false,
  "confidence": 0.0-1.0,
  "improvements": ["suggestion1", "suggestion2"]
}`;

    parts.push(analysisPrompt);

    // Call Gemini
    const result = await model.generateContent(parts);
    const responseText = result.response.text();

    // Parse JSON from response
    let parsedResponse;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in Gemini response');
      }
      parsedResponse = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      logError(`Failed to parse Gemini response: ${parseError.message}`);
      throw new Error('Invalid Gemini response format');
    }

    // Validate response structure
    if (!('hasHook' in parsedResponse) || !('confidence' in parsedResponse)) {
      throw new Error('Gemini response missing required fields');
    }

    return {
      hasHook: Boolean(parsedResponse.hasHook),
      confidence: parseFloat(parsedResponse.confidence) || 0.5,
      improvements: Array.isArray(parsedResponse.improvements) ? parsedResponse.improvements : []
    };
  } catch (error) {
    logError(`Gemini analysis failed: ${error.message}`);
    throw error;
  }
}

/**
 * Validates video clips by analyzing key frames using Gemini Vision API
 * Continues processing even if individual clips fail
 *
 * @param {Array<Object>} clips - Array of clip objects from Task 3
 *   Each clip: {index, path, momentId, startTime, endTime, duration, sizeBytes}
 * @param {string} videoId - Video ID for tracking/logging
 * @returns {Promise<Array<Object>>} Array of clips with validation metadata attached
 *   Each result: {...clip, validation: {hasVisualHook, confidence, suggestions, analyzedAt, error?}}
 * @throws {Error} If clips array is empty
 */
async function validateClipsWithGemini(clips, videoId) {
  // Validate input
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('Clips array cannot be empty');
  }

  logDebug(`Validating ${clips.length} clips for video ${videoId} using Gemini Vision`);

  const validatedClips = [];
  const framesDirectories = []; // Track temp directories for cleanup

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const clipIndex = clip.index || i + 1;

    try {
      logDebug(`Analyzing clip ${clipIndex} (${clip.path})`);

      // Validate clip file exists
      if (!fs.existsSync(clip.path)) {
        throw new Error(`Clip file not found: ${clip.path}`);
      }

      // Extract key frames
      let framePaths = [];
      try {
        framePaths = await extractKeyFrames(clip.path);

        // Track the parent directory for cleanup
        if (framePaths.length > 0) {
          const framesDir = path.dirname(framePaths[0]);
          framesDirectories.push(framesDir);
        }
      } catch (error) {
        logError(`Frame extraction for clip ${clipIndex} failed, attempting analysis without frames: ${error.message}`);
      }

      // Analyze frames with Gemini
      let analysisResult = null;
      let analysisError = null;

      if (framePaths.length > 0) {
        try {
          analysisResult = await analyzeFramesWithGemini(framePaths);
        } catch (error) {
          logError(`Gemini analysis for clip ${clipIndex} failed: ${error.message}`);
          analysisError = error.message;
        }
      } else {
        logError(`No frames available for clip ${clipIndex}`);
        analysisError = 'No frames could be extracted from clip';
      }

      // Build validation metadata
      const validationMetadata = {
        hasVisualHook: analysisResult?.hasHook ?? false,
        confidence: Math.max(0, Math.min(1, analysisResult?.confidence ?? 0.5)), // Clamp to 0-1
        suggestions: analysisResult?.improvements ?? [],
        analyzedAt: new Date().toISOString()
      };

      if (analysisError) {
        validationMetadata.error = analysisError;
      }

      // Add validation to clip
      const validatedClip = {
        ...clip,
        validation: validationMetadata
      };

      validatedClips.push(validatedClip);

      logDebug(`Clip ${clipIndex} validation complete: hasHook=${validationMetadata.hasVisualHook}, confidence=${validationMetadata.confidence.toFixed(2)}`);
    } catch (error) {
      logError(`Error validating clip ${clipIndex}: ${error.message}`);

      // Even on error, add clip with fallback validation
      const validatedClip = {
        ...clip,
        validation: {
          hasVisualHook: false,
          confidence: 0.5,
          suggestions: [],
          analyzedAt: new Date().toISOString(),
          error: error.message
        }
      };

      validatedClips.push(validatedClip);
    }
  }

  // Cleanup temporary frame directories
  for (const framesDir of framesDirectories) {
    try {
      if (fs.existsSync(framesDir)) {
        fs.rmSync(framesDir, { recursive: true, force: true });
      }
    } catch (error) {
      logError(`Failed to cleanup frames directory ${framesDir}: ${error.message}`);
    }
  }

  logDebug(`Validation complete: ${validatedClips.length}/${clips.length} clips validated`);

  return validatedClips;
}

module.exports = {
  validateClipsWithGemini
};
