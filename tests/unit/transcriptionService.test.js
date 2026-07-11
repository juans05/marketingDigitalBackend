const fs = require('fs');
const path = require('path');

// Mock child_process exec and execFile functions
jest.mock('child_process', () => ({
  exec: jest.fn((cmd, callback) => {
    // Mock successful audio extraction for ffmpeg
    if (cmd.includes('ffmpeg')) {
      // Execute the callback with (error, stdout, stderr)
      callback(null, '');
    }
    // Mock successful Whisper transcription
    else if (cmd.includes('whisper')) {
      const mockOutput = JSON.stringify({
        text: 'This is a test transcription',
        segments: [
          { text: 'This is a test', start: 0, end: 2 },
          { text: 'transcription', start: 2, end: 4 },
        ],
      });
      callback(null, mockOutput);
    }
  }),
  execFile: jest.fn((cmd, args, callback) => {
    // Mock successful audio extraction for ffmpeg
    if (cmd === 'ffmpeg') {
      callback(null, '');
    }
    // Mock successful Whisper transcription
    else if (cmd === 'whisper') {
      const mockOutput = JSON.stringify({
        text: 'This is a test transcription',
        segments: [
          { text: 'This is a test', start: 0, end: 2 },
          { text: 'transcription', start: 2, end: 4 },
        ],
      });
      callback(null, mockOutput);
    }
  }),
}));

// Mock promisify to return a function that returns proper promises
jest.mock('util', () => {
  const actualUtil = jest.requireActual('util');
  return {
    ...actualUtil,
    promisify: jest.fn((fn) => {
      return async (...args) => {
        return new Promise((resolve, reject) => {
          fn(...args, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
          });
        });
      };
    }),
  };
});

// Mock axios for Groq API calls
jest.mock('axios');
const axios = require('axios');

// Mock R2 upload/delete — transcribeWithGroq uploads the extracted audio to
// R2 so it can pass Groq a `url` instead of the file directly (Groq's direct
// file upload caps at 25MB, which a 2h video's audio track exceeds).
jest.mock('../../src/lib/r2', () => ({
  uploadFileToR2: jest.fn(),
  deleteFromR2: jest.fn(),
}));
const { uploadFileToR2, deleteFromR2 } = require('../../src/lib/r2');

const { transcribeVideo, extractAudioFromVideo, transcribeWithWhisper, transcribeWithGroq } = require('../../src/services/transcriptionService');

describe('transcriptionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // By default, Groq is not configured
    delete process.env.GROQ_API_KEY;
    uploadFileToR2.mockResolvedValue('https://pub-test.r2.dev/repurposer/transcription-audio/test-id/123.mp3');
    deleteFromR2.mockResolvedValue(undefined);
  });

  describe('transcribeWithGroq', () => {
    const mockAudioPath = path.join(__dirname, 'mock_audio.mp3');

    beforeAll(() => {
      fs.writeFileSync(mockAudioPath, Buffer.from([0, 0, 0, 20]));
    });

    afterAll(() => {
      try { fs.unlinkSync(mockAudioPath); } catch {}
    });

    it('should upload the audio to R2 and call Groq with a url field, not a file upload', async () => {
      process.env.GROQ_API_KEY = 'test-key';
      axios.post.mockResolvedValueOnce({
        data: { text: 'hola mundo', language: 'es', duration: 12.3, segments: [] },
      });

      await transcribeWithGroq(mockAudioPath, 'test-id', { language: 'es' });

      expect(uploadFileToR2).toHaveBeenCalledWith(mockAudioPath, expect.stringContaining('test-id'), 'audio/mpeg');

      expect(axios.post).toHaveBeenCalledTimes(1);
      const [url, body, config] = axios.post.mock.calls[0];

      // Root cause of the original bug: this used to hit api.grok.com (xAI),
      // a completely different provider than the GROQ_API_KEY that's actually
      // configured. The real endpoint is Groq's OpenAI-compatible route.
      expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      expect(body).toBeInstanceOf(require('form-data'));
      expect(config.headers).toHaveProperty('Authorization', 'Bearer test-key');
    });

    it('should clean up the R2 audio object after transcription', async () => {
      process.env.GROQ_API_KEY = 'test-key';
      axios.post.mockResolvedValueOnce({
        data: { text: 'hola mundo', segments: [] },
      });

      await transcribeWithGroq(mockAudioPath, 'test-id', { language: 'es' });

      expect(deleteFromR2).toHaveBeenCalledTimes(1);
      expect(deleteFromR2).toHaveBeenCalledWith(expect.stringContaining('test-id'));
    });

    it('should map the Groq verbose_json response into {text, segments}', async () => {
      process.env.GROQ_API_KEY = 'test-key';
      axios.post.mockResolvedValueOnce({
        data: {
          text: 'hola mundo',
          language: 'es',
          duration: 1.5,
          segments: [
            { id: 0, seek: 0, text: 'hola', start: 0, end: 0.5 },
            { id: 1, seek: 0, text: 'mundo', start: 0.6, end: 1.2 },
          ],
        },
      });

      const result = await transcribeWithGroq(mockAudioPath, 'test-id', { language: 'es' });

      expect(result.text).toBe('hola mundo');
      expect(result.segments).toEqual([
        { text: 'hola', start: 0, end: 0.5 },
        { text: 'mundo', start: 0.6, end: 1.2 },
      ]);
    });

    it('should fall back to Whisper if GROQ_API_KEY is not configured', async () => {
      delete process.env.GROQ_API_KEY;

      const result = await transcribeWithGroq(mockAudioPath, 'test-id', { language: 'es' });

      expect(axios.post).not.toHaveBeenCalled();
      expect(uploadFileToR2).not.toHaveBeenCalled();
      expect(result.text).toBe('This is a test transcription');
    });
  });

  describe('transcribeVideo', () => {
    it('should extract audio and transcribe successfully', async () => {
      // Create a mock video file (just a dummy file for testing)
      const mockVideoPath = path.join(__dirname, 'mock_video.mp4');
      fs.writeFileSync(mockVideoPath, Buffer.from([0, 0, 0, 20])); // Minimal file

      const result = await transcribeVideo(mockVideoPath, 'test-video-id');

      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('segments');
      expect(typeof result.text).toBe('string');
      expect(Array.isArray(result.segments)).toBe(true);

      // Cleanup
      try {
        fs.unlinkSync(mockVideoPath);
      } catch {}
    });

    it('should throw error if video file does not exist', async () => {
      await expect(
        transcribeVideo('/nonexistent/video.mp4', 'test-id')
      ).rejects.toThrow('Video file not found');
    });
  });

  describe('Path validation for security', () => {
    it('should reject videoPath starting with dash to prevent flag injection', async () => {
      await expect(
        extractAudioFromVideo('-i malicious.mp4')
      ).rejects.toThrow("paths cannot start with '-'");
    });

    it('should reject audioPath starting with dash to prevent flag injection', async () => {
      await expect(
        transcribeWithWhisper('-i malicious.wav')
      ).rejects.toThrow("paths cannot start with '-'");
    });

    it('should reject videoPath with shell metacharacters', async () => {
      await expect(
        extractAudioFromVideo('/path/to/video; rm -rf /')
      ).rejects.toThrow('contains suspicious characters');
    });

    it('should reject audioPath with shell metacharacters', async () => {
      await expect(
        transcribeWithWhisper('/path/to/audio`whoami`.wav')
      ).rejects.toThrow('contains suspicious characters');
    });
  });
});
