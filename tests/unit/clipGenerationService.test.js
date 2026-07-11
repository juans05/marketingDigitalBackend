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

const { generateClips, cleanupClips } = require('../../src/services/clipGenerationService');
const { execFile } = require('child_process');

function setupMockExecFile() {
  execFile.mockImplementation((cmd, args, options, callback) => {
    // Handle both (cmd, args, callback) and (cmd, args, options, callback) signatures
    const actualCallback = typeof options === 'function' ? options : callback;

    // Mock successful ffmpeg clip generation
    if (cmd === 'ffmpeg') {
      // Simulate file creation with a small clip file
      const clipPath = args[args.length - 1];
      if (clipPath && !clipPath.startsWith('-')) {
        try {
          fs.writeFileSync(clipPath, Buffer.from([0, 0, 0, 20])); // Minimal file
          actualCallback(null, '');
        } catch (e) {
          actualCallback(e);
        }
      } else {
        actualCallback(null, '');
      }
    } else {
      actualCallback(null, '');
    }
  });
}

describe('clipGenerationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMockExecFile();
  });

  describe('generateClips', () => {
    it('should throw error if video does not exist', async () => {
      const moments = [
        { index: 1, start: 10, end: 60, confidence: 0.9 }
      ];

      await expect(
        generateClips('/nonexistent/video.mp4', moments, 'test-video-id')
      ).rejects.toThrow('Video file not found');
    });

    it('should throw error if moments array is empty', async () => {
      // Create a mock video file
      const mockVideoPath = path.join(__dirname, 'mock_clip_video.mp4');
      fs.writeFileSync(mockVideoPath, Buffer.from([0, 0, 0, 20]));

      try {
        await expect(
          generateClips(mockVideoPath, [], 'test-video-id')
        ).rejects.toThrow('Moments array cannot be empty');
      } finally {
        try {
          fs.unlinkSync(mockVideoPath);
        } catch {}
      }
    });

    it('should generate clips from valid moments', async () => {
      // Create a mock video file
      const mockVideoPath = path.join(__dirname, 'mock_clip_video.mp4');
      fs.writeFileSync(mockVideoPath, Buffer.from([0, 0, 0, 20]));

      const moments = [
        { index: 1, start: 10, end: 60, confidence: 0.9 },
        { index: 2, start: 70, end: 120, confidence: 0.8 }
      ];

      try {
        const clips = await generateClips(mockVideoPath, moments, 'test-video-id');

        expect(Array.isArray(clips)).toBe(true);
        expect(clips.length).toBe(2);

        // Check first clip metadata
        expect(clips[0]).toHaveProperty('index', 1);
        expect(clips[0]).toHaveProperty('path');
        expect(clips[0]).toHaveProperty('momentId', 1);
        expect(clips[0]).toHaveProperty('startTime', 10);
        expect(clips[0]).toHaveProperty('endTime', 60);
        expect(clips[0]).toHaveProperty('duration', 50);
        expect(clips[0]).toHaveProperty('sizeBytes');

        // Check second clip metadata
        expect(clips[1]).toHaveProperty('index', 2);
        expect(clips[1]).toHaveProperty('momentId', 2);
        expect(clips[1]).toHaveProperty('startTime', 70);
        expect(clips[1]).toHaveProperty('endTime', 120);
        expect(clips[1]).toHaveProperty('duration', 50);

        // Cleanup generated clips
        clips.forEach(clip => {
          try {
            fs.unlinkSync(clip.path);
          } catch {}
        });
      } finally {
        try {
          fs.unlinkSync(mockVideoPath);
        } catch {}
      }
    });

    it('should handle individual clip failures gracefully', async () => {
      // Create a mock video file
      const mockVideoPath = path.join(__dirname, 'mock_clip_video.mp4');
      fs.writeFileSync(mockVideoPath, Buffer.from([0, 0, 0, 20]));

      // Mock execFile to fail on second clip
      let callCount = 0;
      execFile.mockImplementation((cmd, args, options, callback) => {
        // Handle both (cmd, args, callback) and (cmd, args, options, callback) signatures
        const actualCallback = typeof options === 'function' ? options : callback;
        callCount++;
        if (callCount === 2) {
          // Fail on second clip
          actualCallback(new Error('FFmpeg error'));
        } else {
          // Success on first clip
          const clipPath = args[args.length - 1];
          if (clipPath && !clipPath.startsWith('-')) {
            try {
              fs.writeFileSync(clipPath, Buffer.from([0, 0, 0, 20]));
              actualCallback(null, '');
            } catch (e) {
              actualCallback(e);
            }
          } else {
            actualCallback(null, '');
          }
        }
      });

      const moments = [
        { index: 1, start: 10, end: 60, confidence: 0.9 },
        { index: 2, start: 70, end: 120, confidence: 0.8 }
      ];

      try {
        const clips = await generateClips(mockVideoPath, moments, 'test-video-id');

        // Should have generated at least one clip despite the failure
        expect(clips.length).toBeGreaterThan(0);

        // Cleanup generated clips
        clips.forEach(clip => {
          try {
            fs.unlinkSync(clip.path);
          } catch {}
        });
      } finally {
        try {
          fs.unlinkSync(mockVideoPath);
        } catch {}
      }
    });
  });

  describe('cleanupClips', () => {
    it('should delete clip directory', async () => {
      // Create a temporary directory with some files
      const tmpDir = path.join(os.tmpdir(), `test_clips_${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'clip_1.mp4'), Buffer.from([0, 0, 0, 20]));
      fs.writeFileSync(path.join(tmpDir, 'clip_2.mp4'), Buffer.from([0, 0, 0, 20]));

      expect(fs.existsSync(tmpDir)).toBe(true);

      await cleanupClips(tmpDir);

      expect(fs.existsSync(tmpDir)).toBe(false);
    });

    it('should handle non-existent directory gracefully', async () => {
      const nonExistentDir = path.join(os.tmpdir(), `nonexistent_${Date.now()}`);

      // Should not throw error
      await expect(cleanupClips(nonExistentDir)).resolves.not.toThrow();
    });
  });
});
