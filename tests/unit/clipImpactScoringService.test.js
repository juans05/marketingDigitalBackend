// tests/unit/clipImpactScoringService.test.js
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

jest.mock('../../src/lib/anthropic', () => ({ getAnthropic: jest.fn() }));
const { getAnthropic } = require('../../src/lib/anthropic');

const { scoreClipForPlatform } = require('../../src/services/clipImpactScoringService');

afterEach(() => jest.clearAllMocks());

describe('scoreClipForPlatform', () => {
  it('should call Claude with the rubric prompt and parse the score + copy', async () => {
    const mockResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          parent_video_id: 'video-1',
          platform: 'tiktok',
          score: 8.5,
          score_breakdown: { hook: 2, retention: 1.5, emotional_impact: 2, clarity: 1, value: 1, cta: 0.5, editing: 0.5 },
          main_strength: 'Gancho fuerte',
          main_weakness: 'CTA débil',
          improvement_suggestion: 'Agregar pregunta al final',
          viral_likelihood: 'Alta',
          recommended_platform: 'tiktok',
          hashtags_suggested: ['#viral', '#fyp'],
          copy_short: 'No vas a creer esto 😳',
          copy_long: 'Historia completa: ...',
        }),
      }],
    };
    const createMock = jest.fn().mockResolvedValue(mockResponse);
    getAnthropic.mockReturnValue({ messages: { create: createMock } });

    const result = await scoreClipForPlatform(
      { duration: 45 },
      { platform: 'tiktok', niche: 'true crime', parentVideoId: 'video-1' }
    );

    expect(result.score).toBe(8.5);
    expect(result.score_breakdown).toEqual({ hook: 2, retention: 1.5, emotional_impact: 2, clarity: 1, value: 1, cta: 0.5, editing: 0.5 });
    expect(result.copy_short).toBe('No vas a creer esto 😳');
    expect(result.copy_long).toBe('Historia completa: ...');
    expect(result.hashtags_suggested).toEqual(['#viral', '#fyp']);

    const sentPrompt = createMock.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('EVALUADOR DE IMPACTO DE CLIPS');
    expect(sentPrompt).toContain('Video Padre ID: video-1');
    expect(sentPrompt).toContain('Duración del clip: 45');
    expect(sentPrompt).toContain('Plataforma objetivo: tiktok');
    expect(sentPrompt).toContain('Niche: true crime');
  });

  it('should clamp an out-of-range score to 1-10', async () => {
    getAnthropic.mockReturnValue({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ score: 15, score_breakdown: {}, hashtags_suggested: [] }) }],
        }),
      },
    });

    const result = await scoreClipForPlatform({ duration: 30 }, { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' });
    expect(result.score).toBe(10);
  });

  it('should default to score 5 when Claude returns a non-numeric score', async () => {
    getAnthropic.mockReturnValue({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ score: 'muy alto', score_breakdown: {}, hashtags_suggested: [] }) }],
        }),
      },
    });

    const result = await scoreClipForPlatform({ duration: 30 }, { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' });
    expect(result.score).toBe(5);
  });

  it('should throw a readable error when Claude response has no JSON', async () => {
    getAnthropic.mockReturnValue({
      messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'not json at all' }] }) },
    });

    await expect(
      scoreClipForPlatform({ duration: 30 }, { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' })
    ).rejects.toThrow('No JSON found in Claude response');
  });
});
