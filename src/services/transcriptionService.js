const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');

const execAsync = promisify(exec);

function logDebug(msg) {
  console.log(`🎙️ [Transcription] ${msg}`);
}

function logError(msg) {
  console.error(`❌ [Transcription] ${msg}`);
}

async function extractAudioFromVideo(videoPath) {
  // Extract audio using ffmpeg
  const audioPath = path.join(path.dirname(videoPath), `audio_${Date.now()}.wav`);
  const cmd = `ffmpeg -i "${videoPath}" -q:a 9 -n "${audioPath}" 2>/dev/null`;

  try {
    await execAsync(cmd);
    logDebug(`Audio extracted: ${audioPath}`);
    return audioPath;
  } catch (error) {
    logError(`Failed to extract audio: ${error.message}`);
    throw new Error(`Audio extraction failed: ${error.message}`);
  }
}

async function transcribeWithGrok(audioPath, options = {}) {
  const grokApiKey = process.env.GROK_API_KEY;
  if (!grokApiKey) {
    logDebug('GROK_API_KEY not configured, fallback to Whisper');
    return transcribeWithWhisper(audioPath, options);
  }

  try {
    // Read audio file as base64
    const audioBuffer = fs.readFileSync(audioPath);
    const base64Audio = audioBuffer.toString('base64');

    // Call Grok API
    const response = await axios.post(
      'https://api.grok.com/v1/speech/transcribe',
      {
        audio: base64Audio,
        language: options.language || 'es',
        include_timestamps: options.timestamps !== false,
      },
      {
        headers: {
          'Authorization': `Bearer ${grokApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 300000, // 5 min timeout for large files
      }
    );

    logDebug(`Grok transcription succeeded`);
    return {
      text: response.data.text,
      segments: response.data.segments || [],
    };
  } catch (error) {
    logDebug(`Grok failed (${error.message}), falling back to Whisper`);
    return transcribeWithWhisper(audioPath, options);
  }
}

async function transcribeWithWhisper(audioPath, options = {}) {
  // Fallback: use local Whisper model (assumed installed via `pip install openai-whisper`)
  const whisperModel = process.env.WHISPER_MODEL_PATH || 'base';
  const cmd = `whisper "${audioPath}" --model ${whisperModel} --language es --output_format json`;

  try {
    const { stdout } = await execAsync(cmd);
    const result = JSON.parse(stdout);
    logDebug(`Whisper transcription succeeded`);
    return {
      text: result.text,
      segments: result.segments || [],
    };
  } catch (error) {
    logError(`Whisper transcription failed: ${error.message}`);
    throw new Error(`Transcription unavailable: both Grok and Whisper failed`);
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
    const transcript = await transcribeWithGrok(audioPath, {
      language: 'es',
      timestamps: true,
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
  transcribeWithGrok,
  transcribeWithWhisper,
};
