process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.CLIPPER_SERVICE_URL = 'http://python:8080';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
const updateSpy = jest.spyOn(mock.client, 'update');
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));
jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ data: { clips: [] } }) }));
jest.mock('../../src/services/aiService', () => ({
  detectSegments: jest.fn().mockResolvedValue([{ start: 1, end: 5, title: 'A', reason: 'r' }]),
  generateCopyWithClaude: jest.fn(), fetchArtistLearningContext: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/repurposeProgress', () => ({
  setStage: jest.fn(),
  STAGES: { PROBING: 'probing', DETECTING: 'detecting', CUTTING: 'cutting', SCORING: 'scoring' },
}));

const axios = require('axios');
const { generateClips } = require('../../src/services/repurposerService');
afterEach(() => jest.clearAllMocks());

test('llama a /cut con source_url (la URL de R2), no con video_id', async () => {
  mock.queueResult({ data: { id: 'p1', artist_id: 'a1', title: 'T', source_url: 'https://cdn/repurposer/sources/a1/x.mp4', platforms: ['tiktok'] }, error: null }); // parent
  mock.queueResult({ data: { id: 'a1', name: 'J', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: ['tiktok'] }, error: null }); // artist
  mock.queueResult({ error: null }); // delete hijos
  mock.queueResult({ error: null }); // update final
  axios.post
    .mockResolvedValueOnce({ data: { duration_seconds: 120 } }) // /probe
    .mockResolvedValueOnce({ data: { clips: [] } });            // /cut

  await generateClips('p1');

  expect(axios.post).toHaveBeenCalledWith('http://python:8080/cut', {
    source_url: 'https://cdn/repurposer/sources/a1/x.mp4',
    segments: [{ start: 1, end: 5, title: 'A' }],
    artist_id: 'a1',
  });
});

test('rechaza el video (failed) si /probe reporta más de 2 horas, sin llamar a Gemini', async () => {
  const aiService = require('../../src/services/aiService');
  mock.queueResult({ data: { id: 'p1', artist_id: 'a1', title: 'T', source_url: 'https://cdn/x.mp4', platforms: ['tiktok'] }, error: null }); // parent
  mock.queueResult({ data: { id: 'a1', name: 'J', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: ['tiktok'] }, error: null }); // artist
  mock.queueResult({ error: null }); // delete hijos
  axios.post.mockResolvedValueOnce({ data: { duration_seconds: 8000 } }); // /probe
  mock.queueResult({ error: null }); // update failed

  await generateClips('p1');

  expect(axios.post).toHaveBeenCalledWith('http://python:8080/probe', { source_url: 'https://cdn/x.mp4' });
  expect(aiService.detectSegments).not.toHaveBeenCalled();
});

test('si el insert de un clip falla, se loguea el error real (no ReferenceError) y no se cuenta como creado', async () => {
  const aiService = require('../../src/services/aiService');
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mock.queueResult({ data: { id: 'p1', artist_id: 'a1', title: 'T', source_url: 'https://cdn/x.mp4', platforms: ['tiktok'] }, error: null }); // parent
  mock.queueResult({ data: { id: 'a1', name: 'J', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: ['tiktok'] }, error: null }); // artist
  mock.queueResult({ error: null }); // delete hijos
  axios.post
    .mockResolvedValueOnce({ data: { duration_seconds: 120 } }) // /probe
    .mockResolvedValueOnce({ data: { clips: [{ title: 'A', start: 1, end: 5, secure_url: 'https://cloudinary/clip.mp4' }] } }); // /cut
  aiService.generateCopyWithClaude.mockResolvedValueOnce({ viral_score: 7, ai_copy_short: 'a', ai_copy_long: 'aa', hashtags: '#a' });
  mock.queueResult({ data: null, error: { message: 'RLS: nueva fila viola la política' } }); // insert del clip falla
  mock.queueResult({ error: null }); // update final (failed, porque clipsCreated quedó en 0)

  await generateClips('p1');

  // El mensaje real de Supabase debe quedar visible en el log, nunca un
  // ReferenceError por referenciar una variable que no existe en ese scope.
  const loggedMessages = errorSpy.mock.calls.map(call => call.join(' '));
  expect(loggedMessages.some(m => m.includes('RLS: nueva fila viola la política'))).toBe(true);
  expect(loggedMessages.some(m => m.includes('err is not defined'))).toBe(false);

  // El clip fallido no debe contarse como creado.
  expect(updateSpy.mock.calls.at(-1)[0].status).toBe('failed');
  errorSpy.mockRestore();
});
