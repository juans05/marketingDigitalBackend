process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));
jest.mock('../../src/services/aiService', () => ({
  detectSegments: jest.fn(), generateCopyWithClaude: jest.fn(), fetchArtistLearningContext: jest.fn(),
}));
jest.mock('../../src/lib/queue', () => ({ publishRepurposeJob: jest.fn().mockResolvedValue() }));
const queue = require('../../src/lib/queue');

const repurposerService = require('../../src/services/repurposerService');

afterEach(() => jest.clearAllMocks());

describe('createRepurposeVideo', () => {
  test('crea la fila padre con status queued y publica el job en la cola', async () => {
    mock.queueResult({ data: { id: 'artist-1' }, error: null }); // select artist
    mock.queueResult({ data: [{ id: 'video-1', artist_id: 'artist-1', status: 'queued' }], error: null }); // insert video

    const video = await repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'https://cdn.example.com/repurposer/sources/artist-1/x.mp4',
      title: 'Mi podcast',
      durationSeconds: 3600,
    });

    expect(video.status).toBe('queued');
    expect(queue.publishRepurposeJob).toHaveBeenCalledWith('video-1');
  });

  test('rechaza videos de más de 2 horas antes de tocar la base de datos', async () => {
    await expect(repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'https://cdn.example.com/repurposer/sources/artist-1/podcast.mp4',
      durationSeconds: 8000,
    })).rejects.toThrow('más de 2 horas');
  });

  test('rechaza si falta artistId o sourceUrl', async () => {
    await expect(repurposerService.createRepurposeVideo({ sourceUrl: 'x' })).rejects.toThrow('requeridos');
  });

  test('rechaza (SSRF) un sourceUrl que no apunta al host de R2', async () => {
    await expect(repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'http://169.254.169.254/latest/meta-data/',
    })).rejects.toThrow('origen permitido');
  });

  test('rechaza esquemas no http(s) en sourceUrl', async () => {
    await expect(repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'file:///etc/passwd',
    })).rejects.toThrow();
  });

  test('si el insert de Supabase falla con mensaje vacío, no propaga un error vacío al cliente', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mock.queueResult({ data: { id: 'artist-1' }, error: null }); // select artist
    mock.queueResult({ data: null, error: { message: '', details: '', hint: '', code: '42501' } }); // insert falla (ej. RLS)

    const err = await repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'https://cdn.example.com/repurposer/sources/artist-1/x.mp4',
    }).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toBe('');
    expect(errorSpy).toHaveBeenCalled(); // el detalle completo debe quedar logueado server-side
    errorSpy.mockRestore();
  });

  test('si el insert funciona pero encolar en RabbitMQ falla, marca la fila failed (no la deja huérfana en queued)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const updateSpy = jest.spyOn(mock.client, 'update');
    mock.queueResult({ data: { id: 'artist-1' }, error: null }); // select artist
    mock.queueResult({ data: [{ id: 'video-1', artist_id: 'artist-1', status: 'queued' }], error: null }); // insert video OK
    mock.queueResult({ error: null }); // update a failed
    queue.publishRepurposeJob.mockRejectedValueOnce(new Error('RabbitMQ no disponible'));

    const err = await repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'https://cdn.example.com/repurposer/sources/artist-1/x.mp4',
    }).catch(e => e);

    expect(err.message).toContain('RabbitMQ no disponible');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    errorSpy.mockRestore();
  });
});
