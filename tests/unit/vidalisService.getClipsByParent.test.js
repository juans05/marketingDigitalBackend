process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const vidalisService = require('../../src/services/vidalisService');

afterEach(() => jest.clearAllMocks());

describe('getClipsByParent', () => {
  test('ordena los clips por viral_score_real descendente y marca el primero con isBest', async () => {
    mock.queueResult({
      data: [
        { id: 'a', viral_score_real: 6.2, created_at: '2026-01-01' },
        { id: 'b', viral_score_real: 9.1, created_at: '2026-01-02' },
        { id: 'c', viral_score_real: 7.8, created_at: '2026-01-03' },
      ],
      error: null,
    });

    const clips = await vidalisService.getClipsByParent('parent-1');

    expect(clips.map(c => c.id)).toEqual(['b', 'c', 'a']);
    expect(clips[0].isBest).toBe(true);
    expect(clips[1].isBest).toBe(false);
    expect(clips[2].isBest).toBe(false);
  });

  test('trata viral_score_real null como 0 al ordenar', async () => {
    mock.queueResult({
      data: [
        { id: 'a', viral_score_real: null, created_at: '2026-01-01' },
        { id: 'b', viral_score_real: 3.5, created_at: '2026-01-02' },
      ],
      error: null,
    });

    const clips = await vidalisService.getClipsByParent('parent-1');

    expect(clips.map(c => c.id)).toEqual(['b', 'a']);
    expect(clips[0].isBest).toBe(true);
  });
});
