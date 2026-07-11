const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const FormData = require('form-data');
const { uploadFileToR2, deleteFromR2 } = require('../lib/r2');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Validate file paths to prevent command injection
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

function logDebug(msg) {
  console.log(`🎙️ [Transcription] ${msg}`);
}

function logError(msg) {
  console.error(`❌ [Transcription] ${msg}`);
}

async function extractAudioFromVideo(videoPath) {
  // Validate videoPath to prevent command injection
  validateFilePath(videoPath, 'videoPath');

  // Extract audio as compressed mono mp3 — keeps upload to R2/Groq fast even
  // for a 2h source video, and speech transcription doesn't need stereo/hi-fi.
  const audioPath = path.join(path.dirname(videoPath), `audio_${Date.now()}.mp3`);

  try {
    // Use execFile with argv array to prevent shell injection
    await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '64k',
      '-n', audioPath,
    ]);
    logDebug(`Audio extracted: ${audioPath}`);
    return audioPath;
  } catch (error) {
    logError(`Failed to extract audio: ${error.message}`);
    throw new Error(`Audio extraction failed: ${error.message}`);
  }
}

/**
 * Transcribes audio using Groq's hosted Whisper API (whisper-large-v3).
 *
 * Groq's file-upload path caps at 25MB (free tier), which a 2h source video's
 * audio track blows past even compressed. Uploading to R2 first and passing
 * the `url` field instead of `file` has no such size limit.
 */
async function transcribeWithGroq(audioPath, videoId, options = {}) {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    logError('GROQ_API_KEY not configured, fallback to Whisper');
    return transcribeWithWhisper(audioPath, options);
  }

  const r2Key = `repurposer/transcription-audio/${videoId}/${Date.now()}.mp3`;
  let audioUrl = null;

  try {
    audioUrl = await uploadFileToR2(audioPath, r2Key, 'audio/mpeg');
    logDebug(`Audio uploaded to R2: ${r2Key}`);

    const form = new FormData();
    form.append('url', audioUrl);
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (options.language) {
      form.append('language', options.language);
    }

    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${groqApiKey}`,
        },
        timeout: 300000, // 5 min timeout for large files
      }
    );

    logDebug(`Groq transcription succeeded`);
    const segments = (response.data.segments || []).map(s => ({
      text: s.text,
      start: s.start,
      end: s.end,
    }));
    return { text: response.data.text, segments };
  } catch (error) {
    logError(`Groq failed (${error.message}), falling back to Whisper`);
    return transcribeWithWhisper(audioPath, options);
  } finally {
    if (audioUrl) {
      try { await deleteFromR2(r2Key); } catch (err) {
        logError(`Failed to clean up R2 audio object ${r2Key}: ${err.message}`);
      }
    }
  }
}

async function transcribeWithWhisper(audioPath, options = {}) {
  // Validate audioPath to prevent command injection
  validateFilePath(audioPath, 'audioPath');

  // Fallback: use local Whisper model (assumed installed via `pip install openai-whisper`)
  const whisperModel = process.env.WHISPER_MODEL_PATH || 'base';

  try {
    // Use execFile with argv array to prevent shell injection
    const { stdout } = await execFileAsync('whisper', [
      audioPath,
      '--model',
      whisperModel,
      '--language',
      'es',
      '--output_format',
      'json',
    ]);
    const result = JSON.parse(stdout);
    logDebug(`Whisper transcription succeeded`);
    return {
      text: result.text,
      segments: result.segments || [],
    };
  } catch (error) {
    logError(`Whisper transcription failed: ${error.message}`);
    throw new Error(`Transcription unavailable: both Groq and Whisper failed`);
  }
}

async function transcribeVideo(videoPath, videoId) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  logDebug(`Starting transcription for ${videoId}`);

  try {
    // Extract audio
    const audioPath = await extractAudioFromVideo(videoPath);

    // Transcribe
    const transcript = await transcribeWithGroq(audioPath, videoId, {
      language: 'es',
    });

    // Clean up audio file
    try {
      fs.unlinkSync(audioPath);
    } catch {}

    logDebug(`Transcription complete: ${transcript.text.length} chars`);
    return transcript;
  } catch (error) {
    logError(`Transcription pipeline failed: ${error.message}`);
    throw error;
  }
}

module.exports = {
  transcribeVideo,
  extractAudioFromVideo,
  transcribeWithGroq,
  transcribeWithWhisper,
};
