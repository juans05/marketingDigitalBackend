process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = 'test-key';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockCreate },
})));

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  })),
}));
jest.mock('@google/generative-ai/server', () => ({
  GoogleAIFileManager: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({
    data: Buffer.from('fake-image-bytes'),
    headers: { 'content-type': 'image/jpeg' },
  }),
}));

const aiService = require('../../src/services/aiService');

afterEach(() => jest.clearAllMocks());

describe('analyzeContentStrategy — el prompt razona antes de pedir el score', () => {
  test('en el schema JSON, "score" aparece después de los campos de diagnóstico', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({
        tags: ['a', 'b', 'c'],
        diagnostico_algoritmico: 'x',
        match_historico: 'x',
        mejora_del_gancho: 'x',
        ajuste_estrategico: 'x',
        score: 70,
        hooks: ['a', 'b', 'c'],
        descriptions: ['a', 'b', 'c'],
        visualBreakdown: [],
        audience: { demographic: 'x', peakTime: 'x' },
        improvements: ['a', 'b', 'c'],
      }) }],
    });

    await aiService.analyzeContentStrategy('un script cualquiera', 'natural', 'tiktok', null, {});

    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    const idxAjuste = userContent.indexOf('"ajuste_estrategico"');
    const idxScore = userContent.indexOf('"score"');
    expect(idxAjuste).toBeGreaterThan(-1);
    expect(idxScore).toBeGreaterThan(idxAjuste);
  });

  test('el system prompt no le pide anclarse al promedio histórico como objetivo', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ score: 50, tags: [], hooks: [], descriptions: [], visualBreakdown: [], audience: {}, improvements: [] }) }],
    });

    await aiService.analyzeContentStrategy('script', 'natural', 'tiktok', null, {});

    const systemPrompt = mockCreate.mock.calls[0][0].system;
    expect(systemPrompt).toMatch(/rango completo/i);
    expect(systemPrompt).not.toMatch(/no infl[eé]s ni desinfl[eé]s/i);
  });
});

describe('scoreVisualVirality — el prompt calcula "overall" después de las dimensiones', () => {
  test('en el schema JSON, "overall" aparece después de "quickFixes"', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({
        dimensions: {
          hook: { score: 80, label: 'x', detail: 'x' },
          quality: { score: 80, label: 'x', detail: 'x' },
          emotion: { score: 80, label: 'x', detail: 'x' },
          trend: { score: 80, label: 'x', detail: 'x' },
          thumb: { score: 80, label: 'x', detail: 'x' },
          scroll: { score: 80, label: 'x', detail: 'x' },
        },
        content_type_3h: 'hero',
        psychological_triggers: [],
        verdict: 'x',
        quickFixes: ['a', 'b', 'c'],
        overall: 80,
      }) },
    });

    await aiService.scoreVisualVirality('https://example.com/img.jpg', 'image', 'tiktok', null);

    const promptArg = mockGenerateContent.mock.calls[0][0][1];
    // Ancla la búsqueda al inicio del bloque JSON real (evita falsos positivos
    // con la instrucción en prosa que también menciona "overall" antes del schema).
    const schemaStart = promptArg.indexOf('"dimensions"');
    const idxQuickFixes = promptArg.indexOf('"quickFixes"', schemaStart);
    const idxOverall = promptArg.indexOf('"overall"', schemaStart);
    expect(schemaStart).toBeGreaterThan(-1);
    expect(idxQuickFixes).toBeGreaterThan(schemaStart);
    expect(idxOverall).toBeGreaterThan(idxQuickFixes);
  });
});
