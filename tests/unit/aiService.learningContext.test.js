process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.ANTHROPIC_API_KEY = 'test-key';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();

let fromCallCount = 0;
const realFrom = mock.client.from;
mock.client.from = function (...args) {
  fromCallCount++;
  return realFrom.apply(this, args);
};

jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockCreate },
})));

const aiService = require('../../src/services/aiService');

function queueLearningContextRound() {
  // 4 queries en orden: artists, videos, post_metrics_snapshots, analytics_insights_log
  mock.queueResult({ data: { name: 'Mari', ai_genre: 'urbano', ai_audience: null, ai_tone: 'directo', creative_dna: null, branding_data: null }, error: null });
  mock.queueResult({ data: [{ title: 'v1', hashtags: '#a', platforms: ['tiktok'], viral_score: 70, viral_score_real: 65, ai_copy_short: 'x', analytics_4h: {} }], error: null });
  mock.queueResult({ data: [{ platform: 'tiktok', likes: 10, comments: 1, views: 100, shares: 1, engagement_rate: 5, viral_score_real: 65 }], error: null });
  mock.queueResult({ data: [], error: null });
}

afterEach(() => {
  jest.clearAllMocks();
  fromCallCount = 0;
});

describe('fetchArtistLearningContext — paralelización (paso 3)', () => {
  test('arma correctamente el contexto agregando las 4 fuentes', async () => {
    queueLearningContextRound();
    const ctx = await aiService.fetchArtistLearningContext('artist-parallel-1');
    expect(ctx).not.toBeNull();
    expect(ctx.bestPlatform).toBe('tiktok');
    expect(ctx.totalPostsAnalyzed).toBe(1); // el fixture trae 1 post con viral_score y viral_score_real
    expect(fromCallCount).toBe(4); // las 4 tablas se consultaron
  });
});

describe('fetchArtistLearningContext — caché de 5 minutos (paso 4)', () => {
  test('una segunda llamada inmediata para el mismo artista no vuelve a consultar Supabase', async () => {
    queueLearningContextRound();
    const first = await aiService.fetchArtistLearningContext('artist-cache-1');
    expect(fromCallCount).toBe(4);

    const callsBeforeSecond = fromCallCount;
    const second = await aiService.fetchArtistLearningContext('artist-cache-1');
    expect(fromCallCount).toBe(callsBeforeSecond); // no se hicieron queries nuevas
    expect(second).toEqual(first);
  });

  test('un artista distinto sí dispara sus propias queries (la caché es por artista)', async () => {
    queueLearningContextRound();
    await aiService.fetchArtistLearningContext('artist-cache-2');
    expect(fromCallCount).toBe(4);

    queueLearningContextRound();
    await aiService.fetchArtistLearningContext('artist-cache-3');
    expect(fromCallCount).toBe(8);
  });
});

describe('analyzeContentStrategy — jsonrepair fallback (paso 5)', () => {
  test('repara una respuesta con una coma colgante en vez de fallar', async () => {
    mock.queueResult({ data: [], error: null }); // fetchGlobalCalibration (sin datos de artista)
    mockCreate.mockResolvedValueOnce({
      content: [{ text: '{"tags": ["a","b","c"], "diagnostico_algoritmico": "x", "match_historico": "x", "mejora_del_gancho": "x", "ajuste_estrategico": "x", "score": 70, "hooks": ["a","b","c"], "descriptions": ["a","b","c"], "visualBreakdown": [], "audience": {"demographic":"x","peakTime":"x"}, "improvements": ["a","b","c"],}' }],
      // ↑ nótese la coma colgante antes del "}" final — JSON.parse normal fallaría acá
    });

    const result = await aiService.analyzeContentStrategy('script', 'natural', 'tiktok', null, {});
    expect(result.tags).toEqual(['a', 'b', 'c']);
    expect(typeof result.score).toBe('number');
  });

  test('con JSON válido, el comportamiento no cambia (jsonrepair no se necesita)', async () => {
    mock.queueResult({ data: [], error: null });
    mockCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({
        tags: ['a', 'b', 'c'], diagnostico_algoritmico: 'x', match_historico: 'x',
        mejora_del_gancho: 'x', ajuste_estrategico: 'x', score: 55,
        hooks: ['a', 'b', 'c'], descriptions: ['a', 'b', 'c'], visualBreakdown: [],
        audience: { demographic: 'x', peakTime: 'x' }, improvements: ['a', 'b', 'c'],
      }) }],
    });

    const result = await aiService.analyzeContentStrategy('script', 'natural', 'tiktok', null, {});
    expect(result.tags).toEqual(['a', 'b', 'c']);
    expect(result.score).toBe(55);
  });
});
