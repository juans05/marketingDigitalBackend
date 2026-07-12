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
      {
        duration: 45,
        reason: 'El presentador revela un giro inesperado sobre el caso',
        tags: ['plot-twist', 'suspenso'],
        validation: { hasVisualHook: true, confidence: 0.87, suggestions: ['Agregar texto overlay en el segundo 2'] },
      },
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
    // The rubric prompt must include real clip content, not just IDs/metadata —
    // otherwise Claude has no signal to differentiate clips and defaults to a
    // generic mid-range score for everything.
    expect(sentPrompt).toContain('El presentador revela un giro inesperado sobre el caso');
    expect(sentPrompt).toContain('gancho visual presente');
    expect(sentPrompt).toContain('0.87');
    expect(sentPrompt).toContain('Agregar texto overlay en el segundo 2');
    expect(sentPrompt).toContain('plot-twist, suspenso');
  });

  it('should fall back to a generic content note when the clip has no reason/validation/tags', async () => {
    const createMock = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ score: 6, score_breakdown: {}, hashtags_suggested: [] }) }],
    });
    getAnthropic.mockReturnValue({ messages: { create: createMock } });

    await scoreClipForPlatform({ duration: 20 }, { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' });

    const sentPrompt = createMock.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('Sin análisis de contenido adicional disponible');
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

const { scoreClipsWithImpactRubric, persistClipScore, rescoreClip } = require('../../src/services/clipImpactScoringService');

describe('scoreClipsWithImpactRubric', () => {
  it('should throw if clips array is empty', async () => {
    await expect(
      scoreClipsWithImpactRubric([], { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' })
    ).rejects.toThrow('Clips array is required');
  });

  it('should score each clip and attach the result under .score', async () => {
    getAnthropic.mockReturnValue({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ score: 7, score_breakdown: {}, hashtags_suggested: [] }) }],
        }),
      },
    });

    const clips = [{ index: 1, duration: 30 }, { index: 2, duration: 40 }];
    const result = await scoreClipsWithImpactRubric(clips, { platform: 'tiktok', niche: 'comedy', parentVideoId: 'v1' });

    expect(result).toHaveLength(2);
    expect(result[0].score.score).toBe(7);
    expect(result[1].score.score).toBe(7);
  });

  it('should continue scoring remaining clips if one fails', async () => {
    getAnthropic.mockReturnValue({
      messages: {
        create: jest.fn()
          .mockRejectedValueOnce(new Error('Claude timeout'))
          .mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({ score: 6, score_breakdown: {}, hashtags_suggested: [] }) }],
          }),
      },
    });

    const clips = [{ index: 1, duration: 30 }, { index: 2, duration: 40 }];
    const result = await scoreClipsWithImpactRubric(clips, { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' });

    expect(result[0].score.score).toBe(0);
    expect(result[0].score.error).toBe('Claude timeout');
    expect(result[1].score.score).toBe(6);
  });
});

describe('persistClipScore', () => {
  it('should upsert clip_platform_scores and update videos.clip_impact_score', async () => {
    const upsertSpy = jest.spyOn(mock.client, 'upsert');
    const updateSpy = jest.spyOn(mock.client, 'update');
    mock.queueResult({ data: null, error: null }); // upsert
    mock.queueResult({ data: null, error: null }); // update videos

    await persistClipScore('clip-1', 'tiktok', {
      score: 8, score_breakdown: { hook: 2 }, main_strength: 'x', main_weakness: 'y',
      improvement_suggestion: 'z', viral_likelihood: 'Alta', recommended_platform: 'tiktok',
      hashtags_suggested: ['#a'], copy_short: 's', copy_long: 'l',
    });

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ clip_video_id: 'clip-1', platform: 'tiktok', score: 8 }),
      { onConflict: 'clip_video_id,platform' }
    );
    expect(updateSpy).toHaveBeenCalledWith({ clip_impact_score: 8 });
  });
});

describe('rescoreClip', () => {
  it('should fetch the clip, re-score it for the new platform, and persist', async () => {
    const createMock = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ score: 9, score_breakdown: {}, hashtags_suggested: [] }) }],
    });
    getAnthropic.mockReturnValue({ messages: { create: createMock } });

    mock.queueResult({
      data: {
        id: 'clip-1',
        parent_video_id: 'video-1',
        ai_clips_data: {
          duration: 25,
          reason: 'Momento con revelación shockeante',
          tags: ['revelacion'],
          validation: { hasVisualHook: true, confidence: 0.9, suggestions: [] },
        },
      },
      error: null,
    }); // select clip
    mock.queueResult({ data: null, error: null }); // upsert
    mock.queueResult({ data: null, error: null }); // update videos

    const result = await rescoreClip('clip-1', 'instagram', 'comedy');

    expect(result.score).toBe(9);
    expect(result.platform).toBe('instagram');

    // rescoreClip must forward the clip's real content (reason/validation/tags)
    // into the prompt, not just its duration — otherwise re-scoring for another
    // platform suffers the same "no signal" defect as the initial scoring pass.
    const sentPrompt = createMock.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('Momento con revelación shockeante');
    expect(sentPrompt).toContain('gancho visual presente');
  });

  it('should throw if the clip does not exist', async () => {
    mock.queueResult({ data: null, error: { message: 'not found' } });

    await expect(rescoreClip('missing-clip', 'tiktok', 'x')).rejects.toThrow('Clip not found: missing-clip');
  });
});
