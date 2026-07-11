const fs = require('fs');
const path = require('path');

// Mock child_process exec and execFile functions
const mockExecAsync = jest.fn();
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

// Mock axios for Grok API calls
jest.mock('axios');
const axios = require('axios');

const { transcribeVideo, extractAudioFromVideo, transcribeWithWhisper, transcribeWithGrok } = require('../../src/services/transcriptionService');

describe('transcriptionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // By default, Grok is not configured
    delete process.env.GROK_API_KEY;
  });

  describe('transcribeWithGrok', () => {
    const mockAudioPath = path.join(__dirname, 'mock_audio.wav');

    beforeAll(() => {
      fs.writeFileSync(mockAudioPath, Buffer.from([0, 0, 0, 20]));
    });

    afterAll(() => {
      try { fs.unlinkSync(mockAudioPath); } catch {}
    });

    it('should call the real xAI STT endpoint with multipart/form-data, not a JSON body', async () => {
      process.env.GROK_API_KEY = 'test-key';
      axios.post.mockResolvedValueOnce({
        data: { text: 'hola mundo', language: 'es', duration: 12.3, words: [] },
      });

      await transcribeWithGrok(mockAudioPath, { language: 'es' });

      expect(axios.post).toHaveBeenCalledTimes(1);
      const [url, body, config] = axios.post.mock.calls[0];

      // Root cause of the original bug: wrong domain/path (api.grok.com/v1/speech/transcribe
      // doesn't exist). The real xAI STT endpoint is api.x.ai/v1/stt.
      expect(url).toBe('https://api.x.ai/v1/stt');

      // Real endpoint expects multipart/form-data (a file field), not a base64 JSON payload.
      expect(body).toBeInstanceOf(require('form-data'));
      expect(config.headers).toHaveProperty('Authorization', 'Bearer test-key');
    });

    it('should map the xAI STT response ({text, words}) into {text, segments}', async () => {
      process.env.GROK_API_KEY = 'test-key';
      axios.post.mockResolvedValueOnce({
        data: {
          text: 'hola mundo',
          language: 'es',
          duration: 1.5,
          words: [{ text: 'hola', start: 0, end: 0.5 }, { text: 'mundo', start: 0.6, end: 1.2 }],
        },
      });

      const result = await transcribeWithGrok(mockAudioPath, { language: 'es' });

      expect(result.text).toBe('hola mundo');
      expect(result.segments).toEqual([
        { text: 'hola', start: 0, end: 0.5 },
        { text: 'mundo', start: 0.6, end: 1.2 },
      ]);
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
