const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock child_process execFile function
jest.mock('child_process', () => ({
  execFile: jest.fn(),
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

// Mock getGemini
jest.mock('../../src/lib/gemini', () => ({
  getGemini: jest.fn(),
}));

const { validateClipsWithGemini } = require('../../src/services/clipValidationService');
const { execFile } = require('child_process');
const { getGemini } = require('../../src/lib/gemini');

function setupMockExecFile(options = {}) {
  const { shouldFailProbe = false, shouldFailFrameExtraction = false } = options;

  execFile.mockImplementation((cmd, args, options, callback) => {
    // Handle both (cmd, args, callback) and (cmd, args, options, callback) signatures
    const actualCallback = typeof options === 'function' ? options : callback;

    if (cmd === 'ffprobe') {
      // Mock ffprobe response - return duration
      if (shouldFailProbe) {
        actualCallback(new Error('ffprobe error'));
      } else {
        actualCallback(null, '60.5');
      }
    } else if (cmd === 'ffmpeg') {
      // Mock ffmpeg frame extraction
      if (shouldFailFrameExtraction) {
        actualCallback(new Error('ffmpeg error'));
      } else {
        // Simulate file creation with a small image file (JPEG magic bytes)
        const framePath = args[args.length - 1];
        if (framePath && !framePath.startsWith('-')) {
          try {
            fs.writeFileSync(framePath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])); // JPEG magic bytes
            actualCallback(null, '');
          } catch (e) {
            actualCallback(e);
          }
        } else {
          actualCallback(null, '');
        }
      }
    } else {
      actualCallback(null, '');
    }
  });
}

function setupMockGemini(response) {
  const mockGenerativeModel = {
    generateContent: jest.fn().mockResolvedValue({
      response: {
        text: () => JSON.stringify(response)
      }
    })
  };

  getGemini.mockReturnValue({
    getGenerativeModel: jest.fn().mockReturnValue(mockGenerativeModel)
  });

  return mockGenerativeModel;
}

describe('clipValidationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateClipsWithGemini', () => {
    it('should throw error if clips array is empty', async () => {
      await expect(
        validateClipsWithGemini([], 'test-video-id')
      ).rejects.toThrow('Clips array cannot be empty');
    });

    it('should validate clips with Gemini and attach validation metadata', async () => {
      setupMockExecFile();

      const mockGeminiResponse = {
        hasHook: true,
        confidence: 0.85,
        improvements: ['Add more dynamic camera movement', 'Better audio']
      };
      setupMockGemini(mockGeminiResponse);

      // Create a mock clip file
      const mockClipPath = path.join(__dirname, 'mock_validation_clip.mp4');
      fs.writeFileSync(mockClipPath, Buffer.from([0, 0, 0, 20]));

      const clips = [
        {
          index: 1,
          path: mockClipPath,
          momentId: 1,
          startTime: 0,
          endTime: 30,
          duration: 30,
          sizeBytes: 1024
        }
      ];

      try {
        const validatedClips = await validateClipsWithGemini(clips, 'test-video-id');

        expect(Array.isArray(validatedClips)).toBe(true);
        expect(validatedClips.length).toBe(1);

        // Check that original clip properties are preserved
        expect(validatedClips[0]).toHaveProperty('index', 1);
        expect(validatedClips[0]).toHaveProperty('path', mockClipPath);
        expect(validatedClips[0]).toHaveProperty('momentId', 1);
        expect(validatedClips[0]).toHaveProperty('startTime', 0);
        expect(validatedClips[0]).toHaveProperty('endTime', 30);

        // Check validation metadata
        expect(validatedClips[0]).toHaveProperty('validation');
        expect(validatedClips[0].validation).toHaveProperty('hasVisualHook', true);
        expect(validatedClips[0].validation).toHaveProperty('confidence', 0.85);
        expect(validatedClips[0].validation).toHaveProperty('suggestions');
        expect(Array.isArray(validatedClips[0].validation.suggestions)).toBe(true);
        expect(validatedClips[0].validation.suggestions).toEqual(mockGeminiResponse.improvements);
        expect(validatedClips[0].validation).toHaveProperty('analyzedAt');
        expect(typeof validatedClips[0].validation.analyzedAt).toBe('string');
      } finally {
        try {
          fs.unlinkSync(mockClipPath);
        } catch {}
      }
    });

    it('should handle Gemini API failure gracefully with fallback validation', async () => {
      setupMockExecFile();

      // Mock Gemini to fail
      getGemini.mockReturnValue({
        getGenerativeModel: jest.fn().mockReturnValue({
          generateContent: jest.fn().mockRejectedValue(new Error('Gemini API error'))
        })
      });

      // Create a mock clip file
      const mockClipPath = path.join(__dirname, 'mock_validation_clip2.mp4');
      fs.writeFileSync(mockClipPath, Buffer.from([0, 0, 0, 20]));

      const clips = [
        {
          index: 1,
          path: mockClipPath,
          momentId: 1,
          startTime: 0,
          endTime: 30,
          duration: 30,
          sizeBytes: 1024
        }
      ];

      try {
        const validatedClips = await validateClipsWithGemini(clips, 'test-video-id');

        expect(Array.isArray(validatedClips)).toBe(true);
        expect(validatedClips.length).toBe(1);

        // Check that clip has validation with lower confidence and error message
        expect(validatedClips[0]).toHaveProperty('validation');
        expect(validatedClips[0].validation).toHaveProperty('hasVisualHook', false);
        expect(validatedClips[0].validation).toHaveProperty('confidence', 0.5);
        expect(validatedClips[0].validation).toHaveProperty('suggestions');
        expect(Array.isArray(validatedClips[0].validation.suggestions)).toBe(true);
        expect(validatedClips[0].validation.suggestions.length).toBe(0);
        expect(validatedClips[0].validation).toHaveProperty('error');
        expect(typeof validatedClips[0].validation.error).toBe('string');
      } finally {
        try {
          fs.unlinkSync(mockClipPath);
        } catch {}
      }
    });

    it('should handle frame extraction failure with fallback', async () => {
      setupMockExecFile({ shouldFailFrameExtraction: true });

      const mockGeminiResponse = {
        hasHook: false,
        confidence: 0.4,
        improvements: []
      };
      setupMockGemini(mockGeminiResponse);

      // Create a mock clip file
      const mockClipPath = path.join(__dirname, 'mock_validation_clip3.mp4');
      fs.writeFileSync(mockClipPath, Buffer.from([0, 0, 0, 20]));

      const clips = [
        {
          index: 1,
          path: mockClipPath,
          momentId: 1,
          startTime: 0,
          endTime: 30,
          duration: 30,
          sizeBytes: 1024
        }
      ];

      try {
        const validatedClips = await validateClipsWithGemini(clips, 'test-video-id');

        expect(Array.isArray(validatedClips)).toBe(true);
        expect(validatedClips.length).toBe(1);

        // Check that clip has validation despite frame extraction failure
        expect(validatedClips[0]).toHaveProperty('validation');
        expect(validatedClips[0].validation).toHaveProperty('hasVisualHook');
        expect(validatedClips[0].validation).toHaveProperty('confidence');
      } finally {
        try {
          fs.unlinkSync(mockClipPath);
        } catch {}
      }
    });

    it('should validate multiple clips', async () => {
      setupMockExecFile();

      const mockGeminiResponse = {
        hasHook: true,
        confidence: 0.9,
        improvements: ['Great hook']
      };
      setupMockGemini(mockGeminiResponse);

      // Create mock clip files
      const mockClipPath1 = path.join(__dirname, 'mock_validation_clip_multi1.mp4');
      const mockClipPath2 = path.join(__dirname, 'mock_validation_clip_multi2.mp4');
      fs.writeFileSync(mockClipPath1, Buffer.from([0, 0, 0, 20]));
      fs.writeFileSync(mockClipPath2, Buffer.from([0, 0, 0, 20]));

      const clips = [
        {
          index: 1,
          path: mockClipPath1,
          momentId: 1,
          startTime: 0,
          endTime: 30,
          duration: 30,
          sizeBytes: 1024
        },
        {
          index: 2,
          path: mockClipPath2,
          momentId: 2,
          startTime: 40,
          endTime: 70,
          duration: 30,
          sizeBytes: 1024
        }
      ];

      try {
        const validatedClips = await validateClipsWithGemini(clips, 'test-video-id');

        expect(Array.isArray(validatedClips)).toBe(true);
        expect(validatedClips.length).toBe(2);

        // Check both clips have validation
        validatedClips.forEach(clip => {
          expect(clip).toHaveProperty('validation');
          expect(clip.validation).toHaveProperty('hasVisualHook');
          expect(clip.validation).toHaveProperty('confidence');
          expect(clip.validation).toHaveProperty('suggestions');
          expect(clip.validation).toHaveProperty('analyzedAt');
        });
      } finally {
        try {
          fs.unlinkSync(mockClipPath1);
          fs.unlinkSync(mockClipPath2);
        } catch {}
      }
    });

    it('should clamp confidence to 0.0-1.0', async () => {
      setupMockExecFile();

      // Mock Gemini to return invalid confidence values
      const mockGeminiResponse = {
        hasHook: true,
        confidence: 1.5, // Invalid - should be clamped to 1.0
        improvements: []
      };
      setupMockGemini(mockGeminiResponse);

      // Create a mock clip file
      const mockClipPath = path.join(__dirname, 'mock_validation_clip_clamp.mp4');
      fs.writeFileSync(mockClipPath, Buffer.from([0, 0, 0, 20]));

      const clips = [
        {
          index: 1,
          path: mockClipPath,
          momentId: 1,
          startTime: 0,
          endTime: 30,
          duration: 30,
          sizeBytes: 1024
        }
      ];

      try {
        const validatedClips = await validateClipsWithGemini(clips, 'test-video-id');

        expect(validatedClips[0].validation.confidence).toBeLessThanOrEqual(1.0);
        expect(validatedClips[0].validation.confidence).toBeGreaterThanOrEqual(0.0);
      } finally {
        try {
          fs.unlinkSync(mockClipPath);
        } catch {}
      }
    });
  });
});
