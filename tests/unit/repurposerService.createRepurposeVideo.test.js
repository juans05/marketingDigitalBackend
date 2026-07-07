process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));
jest.mock('../../src/services/aiService', () => ({
  detectSegments: jest.fn(), generateCopyWithClaude: jest.fn(), fetchArtistLearningContext: jest.fn(),
}));

const repurposerService = require('../../src/services/repurposerService');

afterEach(() => jest.clearAllMocks());

describe('createRepurposeVideo', () => {
  test('crea la fila padre con status processing y dispara generateClips', async () => {
    jest.spyOn(repurposerService, 'generateClips').mockResolvedValue();

    mock.queueResult({ data: { id: 'artist-1' }, error: null }); // select artist
    mock.queueResult({ data: [{ id: 'video-1', artist_id: 'artist-1', status: 'processing' }], error: null }); // insert video

    const video = await repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4',
      title: 'Mi podcast',
      durationSeconds: 3600,
    });

    expect(video.status).toBe('processing');
    expect(repurposerService.generateClips).toHaveBeenCalledWith('video-1');
  });

  test('rechaza videos de más de 2 horas antes de tocar la base de datos', async () => {
    await expect(repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4',
      durationSeconds: 8000,
    })).rejects.toThrow('más de 2 horas');
  });

  test('rechaza si falta artistId o sourceUrl', async () => {
    await expect(repurposerService.createRepurposeVideo({ sourceUrl: 'x' })).rejects.toThrow('requeridos');
  });
});
