/**
 * Environment variable validation and configuration
 * Ensures required environment variables are present and logs warnings for optional ones
 */

// Transcription service configuration
if (!process.env.GROQ_API_KEY && !process.env.WHISPER_MODEL_PATH) {
  console.warn('⚠️ Warning: Neither GROQ_API_KEY nor WHISPER_MODEL_PATH configured. Transcription will fail.');
}

// Vidalis scoring service configuration
if (!process.env.VIDALIS_API_KEY) {
  console.warn('⚠️ Warning: VIDALIS_API_KEY not configured. Clip scoring will fail.');
}

// Video processing configuration
if (!process.env.FFMPEG_PATH) {
  console.warn('⚠️ Warning: FFMPEG_PATH not configured. Defaulting to "ffmpeg" in PATH.');
}

module.exports = {
  // Transcription configuration
  groqApiKey: process.env.GROQ_API_KEY,
  whisperModelPath: process.env.WHISPER_MODEL_PATH || 'base',

  // Video processing
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  clipsTempDir: process.env.CLIPS_TEMP_DIR || '/tmp/repurposer-clips',

  // Vidalis scoring
  vidalisApiUrl: process.env.VIDALIS_API_URL || 'http://localhost:3001',
  vidalisApiKey: process.env.VIDALIS_API_KEY,

  // Logging
  repurposerLogLevel: process.env.REPURPOSER_LOG_LEVEL || 'info',
};
