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

const { transcribeVideo, extractAudioFromVideo, transcribeWithWhisper } = require('../../src/services/transcriptionService');

describe('transcriptionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // By default, Grok is not configured
    delete process.env.GROK_API_KEY;
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
