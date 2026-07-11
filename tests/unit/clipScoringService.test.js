process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

jest.mock('../../src/services/aiService', () => ({
  generateCopyWithClaude: jest.fn(),
  fetchArtistLearningContext: jest.fn(),
}));

const aiService = require('../../src/services/aiService');
const { scoreClipsWithClaude } = require('../../src/services/clipScoringService');

const PARENT_VIDEO = { id: 'video-123', artist_id: 'artist-1', title: 'Podcast episodio 4', platforms: null };
const ARTIST = { id: 'artist-1', name: 'DJ Test', ai_genre: 'reggaeton', ai_audience: 'jóvenes 18-25', ai_tone: 'divertido', active_platforms: ['tiktok', 'instagram'] };

function queueScoringContext({ parent = PARENT_VIDEO, artist = ARTIST } = {}) {
  mock.queueResult({ data: parent, error: null }); // videos select
  mock.queueResult({ data: artist, error: null }); // artists select
}

describe('clipScoringService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    aiService.fetchArtistLearningContext.mockResolvedValue(null);
  });

  describe('scoreClipsWithClaude', () => {
    it('should throw error if clips array is empty', async () => {
      await expect(
        scoreClipsWithClaude([], 'video-123')
      ).rejects.toThrow('Clips array is required');
    });

    it('should throw error if clips is not an array', async () => {
      await expect(
        scoreClipsWithClaude(null, 'video-123')
      ).rejects.toThrow('Clips array is required');
    });

    it('should score clips using aiService.generateCopyWithClaude, not an HTTP call', async () => {
      queueScoringContext();
      aiService.generateCopyWithClaude.mockResolvedValueOnce({
        viral_score: 8.5,
        marketing_breakdown: { hook_score: 9, retention_score: 8 },
        ai_copy_short: 'Mirá esto',
        ai_copy_long: 'Mirá esto largo',
        hashtags: '#viral #fyp',
      });

      const clips = [
        {
          index: 1,
          momentId: 1,
          path: '/tmp/clip1.mp4',
          duration: 30,
          reason: 'Momento con gancho fuerte',
          tags: ['funny', 'trending'],
          validation: { hasVisualHook: true, confidence: 0.9, suggestions: [] },
        },
      ];

      const result = await scoreClipsWithClaude(clips, 'video-123');

      expect(result).toHaveLength(1);
      expect(result[0].score.viralScore).toBe(8.5);
      expect(result[0].score.scoreBreakdown).toEqual({ hook_score: 9, retention_score: 8 });
      expect(result[0].score.recommendedPlatforms).toEqual(['tiktok', 'instagram']);
      expect(result[0].score.adCopy).toEqual({ short: 'Mirá esto', long: 'Mirá esto largo', hashtags: '#viral #fyp' });
      expect(result[0].score.scoredAt).toEqual(expect.any(String));

      // Confirms this no longer hits an HTTP "Vidalis API" — it's a direct call
      expect(aiService.generateCopyWithClaude).toHaveBeenCalledWith(
        expect.stringContaining('Momento con gancho fuerte'),
        null,
        expect.any(String),
        ['tiktok', 'instagram'],
        expect.objectContaining({ nombre: 'DJ Test' }),
        null
      );
    });

    it('should handle Claude failure gracefully with a default score', async () => {
      queueScoringContext();
      aiService.generateCopyWithClaude.mockRejectedValueOnce(new Error('Claude API error'));

      const clips = [
        { index: 1, momentId: 1, path: '/tmp/clip1.mp4', duration: 30, reason: 'x', tags: [], validation: { confidence: 0.8 } },
      ];

      const result = await scoreClipsWithClaude(clips, 'video-123');

      expect(result[0].score.viralScore).toBe(0);
      expect(result[0].score.scoreBreakdown).toEqual({});
      expect(result[0].score.error).toBe('Claude API error');
    });

    it('should score multiple clips in order', async () => {
      queueScoringContext();
      aiService.generateCopyWithClaude
        .mockResolvedValueOnce({ viral_score: 8.5, marketing_breakdown: {}, ai_copy_short: '', ai_copy_long: '', hashtags: '' })
        .mockResolvedValueOnce({ viral_score: 6.5, marketing_breakdown: {}, ai_copy_short: '', ai_copy_long: '', hashtags: '' });

      const clips = [
        { index: 1, momentId: 1, path: '/tmp/clip1.mp4', duration: 30, reason: 'a', tags: [], validation: { confidence: 0.9 } },
        { index: 2, momentId: 2, path: '/tmp/clip2.mp4', duration: 25, reason: 'b', tags: [], validation: { confidence: 0.7 } },
      ];

      const result = await scoreClipsWithClaude(clips, 'video-123');

      expect(result[0].score.viralScore).toBe(8.5);
      expect(result[1].score.viralScore).toBe(6.5);
      expect(aiService.generateCopyWithClaude).toHaveBeenCalledTimes(2);
    });

    it('should continue processing clips even if one fails', async () => {
      queueScoringContext();
      aiService.generateCopyWithClaude
        .mockResolvedValueOnce({ viral_score: 7.5, marketing_breakdown: {}, ai_copy_short: '', ai_copy_long: '', hashtags: '' })
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ viral_score: 7.5, marketing_breakdown: {}, ai_copy_short: '', ai_copy_long: '', hashtags: '' });

      const clips = [
        { index: 1, momentId: 1, path: '/tmp/clip1.mp4', duration: 30, reason: 'a', validation: { confidence: 0.9 } },
        { index: 2, momentId: 2, path: '/tmp/clip2.mp4', duration: 25, reason: 'b', validation: { confidence: 0.8 } },
        { index: 3, momentId: 3, path: '/tmp/clip3.mp4', duration: 20, reason: 'c', validation: { confidence: 0.7 } },
      ];

      const result = await scoreClipsWithClaude(clips, 'video-123');

      expect(result).toHaveLength(3);
      expect(result[0].score.viralScore).toBe(7.5);
      expect(result[1].score.viralScore).toBe(0);
      expect(result[1].score.error).toBe('timeout');
      expect(result[2].score.viralScore).toBe(7.5);
    });

    it('should fall back to default platforms when neither video nor artist has any set', async () => {
      queueScoringContext({
        parent: { ...PARENT_VIDEO, platforms: null },
        artist: { ...ARTIST, active_platforms: null },
      });
      aiService.generateCopyWithClaude.mockResolvedValueOnce({
        viral_score: 5, marketing_breakdown: {}, ai_copy_short: '', ai_copy_long: '', hashtags: '',
      });

      const clips = [{ index: 1, momentId: 1, path: '/tmp/clip1.mp4', duration: 30, reason: 'a', validation: { confidence: 0.5 } }];

      const result = await scoreClipsWithClaude(clips, 'video-123');

      expect(result[0].score.recommendedPlatforms).toEqual(['tiktok', 'instagram', 'youtube']);
    });

    it('should pass null artistContext when the artist has no genre/audience/tone set', async () => {
      queueScoringContext({ artist: { ...ARTIST, ai_genre: null, ai_audience: null, ai_tone: null } });
      aiService.generateCopyWithClaude.mockResolvedValueOnce({
        viral_score: 5, marketing_breakdown: {}, ai_copy_short: '', ai_copy_long: '', hashtags: '',
      });

      const clips = [{ index: 1, momentId: 1, path: '/tmp/clip1.mp4', duration: 30, reason: 'a', validation: { confidence: 0.5 } }];

      await scoreClipsWithClaude(clips, 'video-123');

      expect(aiService.generateCopyWithClaude).toHaveBeenCalledWith(
        expect.any(String), null, expect.any(String), expect.any(Array), null, null
      );
    });

    it('should include timestamp in scoredAt field', async () => {
      queueScoringContext();
      const beforeCall = new Date();
      aiService.generateCopyWithClaude.mockResolvedValueOnce({
        viral_score: 8, marketing_breakdown: {}, ai_copy_short: '', ai_copy_long: '', hashtags: '',
      });

      const clips = [{ index: 1, momentId: 1, path: '/tmp/clip1.mp4', duration: 30, reason: 'a', validation: { confidence: 0.8 } }];

      const result = await scoreClipsWithClaude(clips, 'video-123');
      const afterCall = new Date();

      const scoredAtTime = new Date(result[0].score.scoredAt);
      expect(scoredAtTime.getTime()).toBeLessThanOrEqual(afterCall.getTime());
      expect(scoredAtTime.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
    });
  });
});
