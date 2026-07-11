process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

jest.mock('../../src/lib/r2', () => ({
  uploadFileToR2: jest.fn(),
}));

const { uploadFileToR2 } = require('../../src/lib/r2');
const { persistClipsToDatabase } = require('../../src/services/clipPersistenceService');

describe('clipPersistenceService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    uploadFileToR2.mockResolvedValue('https://pub-test.r2.dev/repurposer/clips/video-1/1_123.mp4');
  });

  describe('persistClipsToDatabase', () => {
    it('should throw if scoredClips is empty', async () => {
      await expect(
        persistClipsToDatabase([], 'video-1', 'artist-1')
      ).rejects.toThrow('scoredClips array is required');
    });

    it('should delete any previously persisted clips first (idempotency on job re-delivery)', async () => {
      const deleteSpy = jest.spyOn(mock.client, 'delete');
      mock.queueResult({ data: null, error: null }); // delete
      mock.queueResult({ data: [{ id: 'clip-row-1' }], error: null }); // insert

      const clips = [{ index: 1, path: '/tmp/clip1.mp4', startTime: 0, endTime: 30, duration: 30, reason: 'x', tags: [], validation: {}, score: { viralScore: 8 } }];

      await persistClipsToDatabase(clips, 'video-1', 'artist-1');

      expect(deleteSpy).toHaveBeenCalled();
    });

    it('should upload each clip to R2 and insert a child video row with the expected shape', async () => {
      mock.queueResult({ data: null, error: null }); // delete
      mock.queueResult({ data: [{ id: 'clip-row-1' }], error: null }); // insert

      const clips = [
        {
          index: 1,
          path: '/tmp/clip1.mp4',
          startTime: 10,
          endTime: 60,
          duration: 50,
          reason: 'Momento con gancho fuerte',
          tags: ['hook', 'storytelling'],
          validation: { hasVisualHook: true, confidence: 0.9 },
          score: {
            viralScore: 8.4,
            scoreBreakdown: { hook_score: 9 },
            adCopy: { short: 'corto', long: 'largo', hashtags: '#viral' },
          },
        },
      ];

      const insertSpy = jest.spyOn(mock.client, 'insert');

      const ids = await persistClipsToDatabase(clips, 'video-1', 'artist-1', 'Podcast ep 4');

      expect(uploadFileToR2).toHaveBeenCalledWith('/tmp/clip1.mp4', expect.stringContaining('repurposer/clips/video-1/1_'), 'video/mp4');
      expect(insertSpy).toHaveBeenCalledWith([
        expect.objectContaining({
          parent_video_id: 'video-1',
          artist_id: 'artist-1',
          // The punchy ad-copy caption is preferred as title over the raw
          // "reason" (an analytical explanation, not meant to read as a title).
          title: 'corto',
          source_url: 'https://pub-test.r2.dev/repurposer/clips/video-1/1_123.mp4',
          status: 'ready',
          // Top-level columns — the main gallery (fetchArtistGallery) reads
          // these, not the nested ai_clips_data copy.
          viral_score: 8.4,
          viral_score_real: 8.4,
          ai_copy_short: 'corto',
          ai_copy_long: 'largo',
          hashtags: '#viral',
          marketing_breakdown: { hook_score: 9 },
          ai_clips_data: expect.objectContaining({
            start: 10,
            end: 60,
            reason: 'Momento con gancho fuerte',
            tags: ['hook', 'storytelling'],
            ai_copy_short: 'corto',
            ai_copy_long: 'largo',
            hashtags: '#viral',
          }),
        }),
      ]);
      expect(ids).toEqual(['clip-row-1']);
    });

    it('should fall back to the reason, truncated at a word boundary, when there is no ad copy', async () => {
      mock.queueResult({ data: null, error: null }); // delete
      mock.queueResult({ data: [{ id: 'clip-row-1' }], error: null }); // insert

      const longReason = 'Momento desgarrador de una madre protegiendo a su hijo infectado mientras el barco desciende al caos total';
      const clips = [{
        index: 1, path: '/tmp/clip1.mp4', startTime: 0, endTime: 30, duration: 30,
        reason: longReason, tags: [], validation: {}, score: { viralScore: 6 },
      }];
      const insertSpy = jest.spyOn(mock.client, 'insert');

      await persistClipsToDatabase(clips, 'video-1', 'artist-1');

      const insertedTitle = insertSpy.mock.calls[0][0][0].title;
      expect(insertedTitle.length).toBeLessThanOrEqual(81); // 80 chars + ellipsis
      expect(insertedTitle.endsWith('…')).toBe(true);
      expect(insertedTitle.endsWith(' …')).toBe(false); // no trailing space before the ellipsis
      expect(longReason.startsWith(insertedTitle.slice(0, -1))).toBe(true); // cut at a real word boundary
    });

    it('should fall back to a generic title when the clip has no reason', async () => {
      mock.queueResult({ data: null, error: null }); // delete
      mock.queueResult({ data: [{ id: 'clip-row-1' }], error: null }); // insert

      const clips = [{ index: 3, path: '/tmp/clip3.mp4', startTime: 0, endTime: 30, duration: 30, tags: [], validation: {}, score: { viralScore: 5 } }];
      const insertSpy = jest.spyOn(mock.client, 'insert');

      await persistClipsToDatabase(clips, 'video-1', 'artist-1', 'Podcast ep 4');

      expect(insertSpy).toHaveBeenCalledWith([
        expect.objectContaining({ title: 'Podcast ep 4 — clip 3' }),
      ]);
    });

    it('should continue persisting remaining clips if one upload fails', async () => {
      mock.queueResult({ data: null, error: null }); // delete
      mock.queueResult({ data: [{ id: 'clip-row-2' }], error: null }); // insert for clip 2 (clip 1 fails before reaching insert)

      uploadFileToR2
        .mockRejectedValueOnce(new Error('R2 upload failed'))
        .mockResolvedValueOnce('https://pub-test.r2.dev/repurposer/clips/video-1/2_123.mp4');

      const clips = [
        { index: 1, path: '/tmp/clip1.mp4', startTime: 0, endTime: 30, duration: 30, reason: 'a', validation: {}, score: { viralScore: 5 } },
        { index: 2, path: '/tmp/clip2.mp4', startTime: 40, endTime: 70, duration: 30, reason: 'b', validation: {}, score: { viralScore: 6 } },
      ];

      const ids = await persistClipsToDatabase(clips, 'video-1', 'artist-1');

      expect(ids).toEqual(['clip-row-2']);
    });

    it('should skip a clip whose DB insert fails but keep going', async () => {
      mock.queueResult({ data: null, error: null }); // delete
      mock.queueResult({ data: null, error: { message: 'insert failed' } }); // insert fails for clip 1
      mock.queueResult({ data: [{ id: 'clip-row-2' }], error: null }); // insert succeeds for clip 2

      const clips = [
        { index: 1, path: '/tmp/clip1.mp4', startTime: 0, endTime: 30, duration: 30, reason: 'a', validation: {}, score: { viralScore: 5 } },
        { index: 2, path: '/tmp/clip2.mp4', startTime: 40, endTime: 70, duration: 30, reason: 'b', validation: {}, score: { viralScore: 6 } },
      ];

      const ids = await persistClipsToDatabase(clips, 'video-1', 'artist-1');

      expect(ids).toEqual(['clip-row-2']);
    });
  });
});
