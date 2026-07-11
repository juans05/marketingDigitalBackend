/**
 * Environment variable validation and configuration
 * Ensures required environment variables are present and logs warnings for optional ones
 */

// Transcription service configuration
if (!process.env.GROK_API_KEY && !process.env.WHISPER_MODEL_PATH) {
  console.warn('⚠️ Warning: Neither GROK_API_KEY nor WHISPER_MODEL_PATH configured. Transcription will fail.');
}

module.exports = {
  // Transcription configuration
  grokApiKey: process.env.GROK_API_KEY,
  whisperModelPath: process.env.WHISPER_MODEL_PATH,
};
