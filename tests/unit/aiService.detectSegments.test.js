process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = 'test-key';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  })),
}));
jest.mock('@google/generative-ai/server', () => ({
  GoogleAIFileManager: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() },
})));
jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({
    data: Buffer.from('fake-video-bytes'),
    headers: { 'content-type': 'video/mp4' },
  }),
}));

const aiService = require('../../src/services/aiService');

afterEach(() => jest.clearAllMocks());

describe('detectSegments', () => {
  test('devuelve los segmentos parseados desde la respuesta de Gemini', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({
        segments: [
          { start: 30, end: 75, title: 'El error del lanzamiento', reason: 'Hook fuerte y anécdota autocontenida' },
          { start: 200, end: 250, title: 'La negociación', reason: 'Tensión y resolución completas' },
        ],
      }) },
    });

    const segments = await aiService.detectSegments(
      'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', 'Mi Podcast'
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      start: 30, end: 75, title: 'El error del lanzamiento', reason: 'Hook fuerte y anécdota autocontenida',
    });
  });

  test('descarta segmentos inválidos (end <= start, o valores no numéricos)', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({
        segments: [
          { start: 50, end: 40, title: 'Inválido', reason: 'x' },
          { start: 'a', end: 90, title: 'No numérico', reason: 'x' },
          { start: 10, end: 55, title: 'Válido', reason: 'ok' },
        ],
      }) },
    });

    const segments = await aiService.detectSegments(
      'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', 'Mi Podcast'
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].title).toBe('Válido');
  });

  test('lanza error si Gemini no devuelve JSON válido', async () => {
    mockGenerateContent.mockResolvedValueOnce({ response: { text: () => 'no soy json' } });

    await expect(
      aiService.detectSegments('https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', 'Mi Podcast')
    ).rejects.toThrow('no devolvió JSON');
  });
});
