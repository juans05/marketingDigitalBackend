const axios = require('axios');

// Mock axios
jest.mock('axios');

const { scoreClipsWithVidalis } = require('../../src/services/clipScoringService');

describe('clipScoringService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up environment variables for tests
    process.env.VIDALIS_API_URL = 'http://localhost:3001';
    process.env.VIDALIS_API_KEY = 'test-api-key-123';
  });

  afterEach(() => {
    delete process.env.VIDALIS_API_KEY;
  });

  describe('scoreClipsWithVidalis', () => {
    it('should throw error if clips array is empty', async () => {
      await expect(
        scoreClipsWithVidalis([], 'test-video-id')
      ).rejects.toThrow('Clips array is required');
    });

    it('should throw error if clips is not an array', async () => {
      await expect(
        scoreClipsWithVidalis(null, 'test-video-id')
      ).rejects.toThrow('Clips array is required');
    });

    it('should score clips successfully with Vidalis API response', async () => {
      const mockVidalisResponse = {
        viralScore: 0.85,
        breakdown: {
          visualHook: 0.9,
          pacing: 0.8,
          emotionalImpact: 0.85
        },
        platforms: ['tiktok', 'instagram']
      };

      axios.post.mockResolvedValueOnce({ data: mockVidalisResponse });

      const clips = [
        {
          momentId: 'moment-1',
          path: '/path/to/clip1.mp4',
          duration: 30,
          tags: ['funny', 'trending'],
          validation: {
            confidence: 0.9,
            hasVisualHook: true
          }
        }
      ];

      const result = await scoreClipsWithVidalis(clips, 'video-123');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0]).toHaveProperty('momentId', 'moment-1');
      expect(result[0]).toHaveProperty('score');
      expect(result[0].score).toHaveProperty('viralScore', 0.85);
      expect(result[0].score).toHaveProperty('scoreBreakdown');
      expect(result[0].score.scoreBreakdown).toEqual(mockVidalisResponse.breakdown);
      expect(result[0].score).toHaveProperty('recommendedPlatforms');
      expect(result[0].score.recommendedPlatforms).toEqual(['tiktok', 'instagram']);
      expect(result[0].score).toHaveProperty('scoredAt');
      expect(typeof result[0].score.scoredAt).toBe('string');
    });

    it('should handle API failure gracefully with default score', async () => {
      axios.post.mockRejectedValueOnce(new Error('Vidalis API error'));

      const clips = [
        {
          momentId: 'moment-1',
          path: '/path/to/clip1.mp4',
          duration: 30,
          tags: ['funny'],
          validation: {
            confidence: 0.8
          }
        }
      ];

      const result = await scoreClipsWithVidalis(clips, 'video-123');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0]).toHaveProperty('score');
      expect(result[0].score).toHaveProperty('viralScore', 0);
      expect(result[0].score).toHaveProperty('scoreBreakdown', {});
      expect(result[0].score).toHaveProperty('recommendedPlatforms', ['tiktok']);
      expect(result[0].score).toHaveProperty('scoredAt');
      expect(result[0].score).toHaveProperty('error');
      expect(result[0].score.error).toBe('Vidalis API error');
    });

    it('should score multiple clips', async () => {
      const mockResponse1 = {
        viralScore: 0.85,
        breakdown: { hook: 0.9 },
        platforms: ['tiktok']
      };
      const mockResponse2 = {
        viralScore: 0.65,
        breakdown: { hook: 0.6 },
        platforms: ['instagram']
      };

      axios.post
        .mockResolvedValueOnce({ data: mockResponse1 })
        .mockResolvedValueOnce({ data: mockResponse2 });

      const clips = [
        {
          momentId: 'moment-1',
          path: '/path/to/clip1.mp4',
          duration: 30,
          tags: ['funny'],
          validation: { confidence: 0.9 }
        },
        {
          momentId: 'moment-2',
          path: '/path/to/clip2.mp4',
          duration: 25,
          tags: ['trending'],
          validation: { confidence: 0.7 }
        }
      ];

      const result = await scoreClipsWithVidalis(clips, 'video-123');

      expect(result.length).toBe(2);
      expect(result[0].score.viralScore).toBe(0.85);
      expect(result[1].score.viralScore).toBe(0.65);

      // Verify API was called twice
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    it('should continue processing clips even if one fails', async () => {
      const mockResponse = {
        viralScore: 0.75,
        breakdown: {},
        platforms: ['tiktok']
      };

      axios.post
        .mockResolvedValueOnce({ data: mockResponse })
        .mockRejectedValueOnce(new Error('API timeout'))
        .mockResolvedValueOnce({ data: mockResponse });

      const clips = [
        {
          momentId: 'moment-1',
          path: '/path/to/clip1.mp4',
          duration: 30,
          validation: { confidence: 0.9 }
        },
        {
          momentId: 'moment-2',
          path: '/path/to/clip2.mp4',
          duration: 25,
          validation: { confidence: 0.8 }
        },
        {
          momentId: 'moment-3',
          path: '/path/to/clip3.mp4',
          duration: 20,
          validation: { confidence: 0.7 }
        }
      ];

      const result = await scoreClipsWithVidalis(clips, 'video-123');

      expect(result.length).toBe(3);
      expect(result[0].score.viralScore).toBe(0.75); // Success
      expect(result[1].score.viralScore).toBe(0); // Failed
      expect(result[1].score.error).toBe('API timeout');
      expect(result[2].score.viralScore).toBe(0.75); // Success
    });

    it('should send correct payload to Vidalis API', async () => {
      axios.post.mockResolvedValueOnce({ data: { viralScore: 0.8 } });

      const clips = [
        {
          momentId: 'moment-1',
          path: '/path/to/clip1.mp4',
          duration: 30,
          tags: ['funny', 'viral'],
          validation: {
            confidence: 0.85
          }
        }
      ];

      await scoreClipsWithVidalis(clips, 'video-123');

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/vidalis/viral-score',
        {
          videoId: 'moment-1',
          clipPath: '/path/to/clip1.mp4',
          metadata: {
            duration: 30,
            validationScore: 0.85,
            tags: ['funny', 'viral']
          }
        },
        {
          timeout: 60000,
          headers: {
            'Authorization': 'Bearer test-api-key-123'
          }
        }
      );
    });

    it('should use fallback validation score when not present', async () => {
      axios.post.mockResolvedValueOnce({ data: { viralScore: 0.7 } });

      const clips = [
        {
          momentId: 'moment-1',
          path: '/path/to/clip1.mp4',
          duration: 30,
          tags: []
          // No validation property
        }
      ];

      await scoreClipsWithVidalis(clips, 'video-123');

      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          metadata: expect.objectContaining({
            validationScore: 0.5, // Fallback value
            tags: []
          })
        }),
        expect.any(Object)
      );
    });

    it('should use custom VIDALIS_API_URL from environment', async () => {
      process.env.VIDALIS_API_URL = 'https://api.example.com:5000';
      axios.post.mockResolvedValueOnce({ data: { viralScore: 0.6 } });

      const clips = [
        {
          momentId: 'moment-1',
          path: '/path/to/clip1.mp4',
          duration: 30,
          validation: { confidence: 0.8 }
        }
      ];

      await scoreClipsWithVidalis(clips, 'video-123');

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.example.com:5000/vidalis/viral-score',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should include timestamp in scoredAt field', async () => {
      const beforeCall = new Date();

      axios.post.mockResolvedValueOnce({
        data: {
          viralScore: 0.8,
          breakdown: {},
          platforms: ['tiktok']
        }
      });

      const clips = [
        {
          momentId: 'moment-1',
          path: '/path/to/clip1.mp4',
          duration: 30,
          validation: { confidence: 0.8 }
        }
      ];

      const result = await scoreClipsWithVidalis(clips, 'video-123');
      const afterCall = new Date();

      const scoredAtTime = new Date(result[0].score.scoredAt);
      expect(scoredAtTime.getTime()).toBeLessThanOrEqual(afterCall.getTime());
      expect(scoredAtTime.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
    });
  });
});
