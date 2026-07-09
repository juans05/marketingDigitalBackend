process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.CLIPPER_SERVICE_URL = 'http://python:8080';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));
jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ data: { clips: [] } }) }));
jest.mock('../../src/services/aiService', () => ({
  detectSegments: jest.fn().mockResolvedValue([{ start: 1, end: 5, title: 'A', reason: 'r' }]),
  generateCopyWithClaude: jest.fn(), fetchArtistLearningContext: jest.fn().mockResolvedValue(null),
}));

const axios = require('axios');
const { generateClips } = require('../../src/services/repurposerService');
afterEach(() => jest.clearAllMocks());

test('llama a /cut con source_url (la URL de R2), no con video_id', async () => {
  mock.queueResult({ data: { id: 'p1', artist_id: 'a1', title: 'T', source_url: 'https://cdn/repurposer/sources/a1/x.mp4', platforms: ['tiktok'] }, error: null }); // parent
  mock.queueResult({ data: { id: 'a1', name: 'J', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: ['tiktok'] }, error: null }); // artist
  mock.queueResult({ error: null }); // delete hijos
  mock.queueResult({ error: null }); // update final

  await generateClips('p1');

  expect(axios.post).toHaveBeenCalledWith('http://python:8080/cut', {
    source_url: 'https://cdn/repurposer/sources/a1/x.mp4',
    segments: [{ start: 1, end: 5, title: 'A' }],
    artist_id: 'a1',
  });
});
