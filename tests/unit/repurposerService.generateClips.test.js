process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

jest.mock('../../src/services/aiService', () => ({
  detectSegments: jest.fn(),
  generateCopyWithClaude: jest.fn(),
  fetchArtistLearningContext: jest.fn().mockResolvedValue(null),
}));

const aiService = require('../../src/services/aiService');
const { generateClips } = require('../../src/services/repurposerService');

afterEach(() => jest.clearAllMocks());

describe('generateClips', () => {
  test('crea un clip por cada segmento detectado, con score y metadata', async () => {
    mock.queueResult({
      data: { id: 'parent-1', artist_id: 'artist-1', title: 'Podcast largo', source_url: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', platforms: null },
      error: null,
    }); // select parent
    mock.queueResult({
      data: { id: 'artist-1', name: 'Juan', ai_genre: 'tech', ai_audience: null, ai_tone: null, active_platforms: ['tiktok'] },
      error: null,
    }); // select artist

    aiService.detectSegments.mockResolvedValueOnce([
      { start: 10, end: 40, title: 'Momento 1', reason: 'Hook fuerte' },
      { start: 100, end: 150, title: 'Momento 2', reason: 'Anécdota completa' },
    ]);
    aiService.generateCopyWithClaude
      .mockResolvedValueOnce({ viral_score: 8.5, ai_copy_short: 'a', ai_copy_long: 'aa', hashtags: '#a' })
      .mockResolvedValueOnce({ viral_score: 6.1, ai_copy_short: 'b', ai_copy_long: 'bb', hashtags: '#b' });

    mock.queueResult({ error: null }); // insert clip 1
    mock.queueResult({ error: null }); // insert clip 2
    mock.queueResult({ error: null }); // update parent status ready

    await generateClips('parent-1');

    expect(aiService.generateCopyWithClaude).toHaveBeenCalledTimes(2);
    expect(aiService.generateCopyWithClaude.mock.calls[0]).toEqual([
      'Hook fuerte', null, 'Momento 1', ['tiktok'],
      { nombre: 'Juan', genero: 'tech', audiencia: null, tono: null },
      null,
    ]);
  });

  test('si un segmento falla al puntuar, se omite y se sigue con los demás', async () => {
    mock.queueResult({
      data: { id: 'parent-1', artist_id: 'artist-1', title: 'Podcast', source_url: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', platforms: null },
      error: null,
    });
    mock.queueResult({
      data: { id: 'artist-1', name: 'Juan', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: [] },
      error: null,
    });

    aiService.detectSegments.mockResolvedValueOnce([
      { start: 10, end: 40, title: 'Falla', reason: 'x' },
      { start: 100, end: 150, title: 'OK', reason: 'y' },
    ]);
    aiService.generateCopyWithClaude
      .mockRejectedValueOnce(new Error('Claude timeout'))
      .mockResolvedValueOnce({ viral_score: 7, ai_copy_short: 'b', ai_copy_long: 'bb', hashtags: '#b' });

    mock.queueResult({ error: null }); // insert del único clip que sí funcionó
    mock.queueResult({ error: null }); // update parent status ready

    await expect(generateClips('parent-1')).resolves.toBeUndefined();
  });

  test('si detectSegments no encuentra ningún capítulo, marca el video como failed', async () => {
    mock.queueResult({
      data: { id: 'parent-1', artist_id: 'artist-1', title: 'Podcast', source_url: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', platforms: null },
      error: null,
    });
    mock.queueResult({
      data: { id: 'artist-1', name: 'Juan', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: [] },
      error: null,
    });
    aiService.detectSegments.mockResolvedValueOnce([]);
    mock.queueResult({ error: null }); // update status failed

    await expect(generateClips('parent-1')).resolves.toBeUndefined();
    expect(aiService.generateCopyWithClaude).not.toHaveBeenCalled();
  });
});
