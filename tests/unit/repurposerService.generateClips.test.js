process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

// Local spy (this file only) on the shared mock's `update` method so we can
// assert the actual { status, error_log } payload written to the parent
// video, since the shared FIFO queue itself only replays canned results and
// never records call arguments. Created once at module scope; afterEach's
// jest.clearAllMocks() resets its call history between tests while the
// pass-through spy (it still calls the real chainable implementation)
// remains installed.
const updateSpy = jest.spyOn(mock.client, 'update');
const deleteSpy = jest.spyOn(mock.client, 'delete');

jest.mock('../../src/services/aiService', () => ({
  detectSegments: jest.fn(),
  generateCopyWithClaude: jest.fn(),
  fetchArtistLearningContext: jest.fn().mockResolvedValue(null),
}));

// setStage escribe en Supabase (mismo mock) → mockeado para no desalinear el FIFO.
jest.mock('../../src/services/repurposeProgress', () => ({
  setStage: jest.fn(),
  STAGES: { PROBING: 'probing', DETECTING: 'detecting', CUTTING: 'cutting', SCORING: 'scoring' },
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
    mock.queueResult({ error: null }); // delete hijos previos (idempotencia)

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
    expect(aiService.generateCopyWithClaude.mock.calls[1]).toEqual([
      'Anécdota completa', null, 'Momento 2', ['tiktok'],
      { nombre: 'Juan', genero: 'tech', audiencia: null, tono: null },
      null,
    ]);

    // Final parent status must reflect that both clips were created.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toEqual({ status: 'ready', error_log: null });
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
    mock.queueResult({ error: null }); // delete hijos previos (idempotencia)

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

    // Crux of per-segment isolation: the loop must not stop after the first
    // segment's rejection — it should still attempt to score the second one.
    expect(aiService.generateCopyWithClaude).toHaveBeenCalledTimes(2);
    // artist.active_platforms is [] (empty, falsy for `.length` fallback),
    // so generateClips falls back to the default platform list.
    expect(aiService.generateCopyWithClaude.mock.calls[0]).toEqual([
      'x', null, 'Falla', ['tiktok', 'instagram', 'youtube'],
      null,
      null,
    ]);
    expect(aiService.generateCopyWithClaude.mock.calls[1]).toEqual([
      'y', null, 'OK', ['tiktok', 'instagram', 'youtube'],
      null,
      null,
    ]);

    // Because one of the two segments still succeeded, the parent must end
    // up 'ready' (not 'failed') despite the earlier rejection.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toEqual({ status: 'ready', error_log: null });
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
    mock.queueResult({ error: null }); // delete hijos previos (idempotencia)
    aiService.detectSegments.mockResolvedValueOnce([]);
    mock.queueResult({ error: null }); // update status failed

    await expect(generateClips('parent-1')).resolves.toBeUndefined();
    expect(aiService.generateCopyWithClaude).not.toHaveBeenCalled();

    // Empty segments must short-circuit straight to a 'failed' parent status.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toEqual({
      status: 'failed',
      error_log: JSON.stringify({ step: 'detectSegments', message: 'No se detectaron capítulos en el video' }),
    });
  });

  test('borra los clips hijos previos antes de regenerar (idempotencia)', async () => {
    mock.queueResult({ data: { id: 'parent-1', artist_id: 'artist-1', title: 'P', source_url: 'https://cdn/x.mp4', platforms: null }, error: null }); // select parent
    mock.queueResult({ data: { id: 'artist-1', name: 'J', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: [] }, error: null }); // select artist
    mock.queueResult({ error: null }); // delete hijos
    aiService.detectSegments.mockResolvedValueOnce([]); // sin segmentos -> corta rápido
    mock.queueResult({ error: null }); // update status failed

    await generateClips('parent-1');
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });
});
