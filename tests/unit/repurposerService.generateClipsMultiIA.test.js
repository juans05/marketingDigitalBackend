process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

jest.mock('../../src/services/transcriptionService', () => ({
  transcribeVideo: jest.fn(),
}));
jest.mock('../../src/services/momentDetectionService', () => ({
  detectMomentsWithClaude: jest.fn(),
}));
jest.mock('../../src/services/clipGenerationService', () => ({
  generateClips: jest.fn(),
  cleanupClips: jest.fn(),
}));
jest.mock('../../src/services/clipValidationService', () => ({
  validateClipsWithGemini: jest.fn(),
}));
jest.mock('../../src/services/clipScoringService', () => ({
  scoreClipsWithVidalis: jest.fn(),
}));

const transcriptionService = require('../../src/services/transcriptionService');
const momentDetectionService = require('../../src/services/momentDetectionService');
const clipGenerationService = require('../../src/services/clipGenerationService');
const clipValidationService = require('../../src/services/clipValidationService');
const clipScoringService = require('../../src/services/clipScoringService');

const { generateClipsMultiIA } = require('../../src/services/repurposerService');

afterEach(() => jest.clearAllMocks());

describe('generateClipsMultiIA', () => {
  test('orchestrates all 5 services and updates DB at each stage', async () => {
    const videoPath = '/tmp/video.mp4';
    const videoId = 'video-1';

    // Mock responses from each service
    const segments = [{ text: 'Full transcript text here...', start: 0, end: 5 }];
    transcriptionService.transcribeVideo.mockResolvedValue({
      text: 'Full transcript text here...',
      segments
    });

    const moments = [
      { index: 1, start: 10, end: 30, reason: 'Hook', confidence: 0.9, tags: [] },
      { index: 2, start: 50, end: 70, reason: 'Punchline', confidence: 0.8, tags: [] }
    ];
    momentDetectionService.detectMomentsWithClaude.mockResolvedValue(moments);

    const clips = [
      { index: 1, path: '/tmp/clip_1.mp4', startTime: 10, endTime: 30, duration: 20, sizeBytes: 5000 },
      { index: 2, path: '/tmp/clip_2.mp4', startTime: 50, endTime: 70, duration: 20, sizeBytes: 5000 }
    ];
    clipGenerationService.generateClips.mockResolvedValue(clips);

    const validatedClips = [
      { ...clips[0], validation: { hasVisualHook: true, confidence: 0.9, suggestions: [] } },
      { ...clips[1], validation: { hasVisualHook: true, confidence: 0.85, suggestions: [] } }
    ];
    clipValidationService.validateClipsWithGemini.mockResolvedValue(validatedClips);

    const scoredClips = [
      { ...validatedClips[0], score: { viralScore: 85, scoreBreakdown: {}, recommendedPlatforms: ['tiktok'] } },
      { ...validatedClips[1], score: { viralScore: 75, scoreBreakdown: {}, recommendedPlatforms: ['instagram'] } }
    ];
    clipScoringService.scoreClipsWithVidalis.mockResolvedValue(scoredClips);

    // Queue DB responses (1 select for each update, then no error)
    for (let i = 0; i < 6; i++) {
      mock.queueResult({ data: { ai_clips_data: {} }, error: null });
      mock.queueResult({ data: null, error: null });
    }

    const result = await generateClipsMultiIA(videoPath, videoId);

    // Verify all services were called
    expect(transcriptionService.transcribeVideo).toHaveBeenCalledWith(videoPath, videoId);
    expect(momentDetectionService.detectMomentsWithClaude).toHaveBeenCalledWith(segments, '', videoId);
    expect(clipGenerationService.generateClips).toHaveBeenCalledWith(videoPath, moments, videoId);
    expect(clipValidationService.validateClipsWithGemini).toHaveBeenCalledWith(clips, videoId);
    expect(clipScoringService.scoreClipsWithVidalis).toHaveBeenCalledWith(validatedClips, videoId);

    // Verify result is the final scored clips
    expect(result).toEqual(scoredClips);
    expect(result.length).toBe(2);

    // Verify cleanup was called
    expect(clipGenerationService.cleanupClips).toHaveBeenCalled();
  });

  test('handles error at any stage, updates DB, and re-throws', async () => {
    const videoPath = '/tmp/video.mp4';
    const videoId = 'video-2';

    transcriptionService.transcribeVideo.mockResolvedValue({
      text: 'Transcript...'
    });

    // Simulate error at moment detection stage
    momentDetectionService.detectMomentsWithClaude.mockRejectedValue(
      new Error('Claude API error')
    );

    // Queue DB responses (1 select + 1 update for transcribing, 1 select + 1 update for error)
    mock.queueResult({ data: { ai_clips_data: {} }, error: null });
    mock.queueResult({ data: null, error: null });
    mock.queueResult({ data: { ai_clips_data: {} }, error: null });
    mock.queueResult({ data: null, error: null });

    await expect(generateClipsMultiIA(videoPath, videoId)).rejects.toThrow('Claude API error');

    // Verify services were called
    expect(transcriptionService.transcribeVideo).toHaveBeenCalled();
    expect(momentDetectionService.detectMomentsWithClaude).toHaveBeenCalled();
  });

  test('updates DB with stage progress at each step', async () => {
    const videoPath = '/tmp/video.mp4';
    const videoId = 'video-3';
    const updateSpy = jest.spyOn(mock.client, 'update');

    transcriptionService.transcribeVideo.mockResolvedValue({ text: 'Text' });
    momentDetectionService.detectMomentsWithClaude.mockResolvedValue([
      { index: 1, start: 0, end: 20, reason: 'Good', confidence: 0.9, tags: [] }
    ]);
    clipGenerationService.generateClips.mockResolvedValue([
      { index: 1, path: '/tmp/clip.mp4', startTime: 0, endTime: 20, duration: 20, sizeBytes: 1000 }
    ]);
    clipValidationService.validateClipsWithGemini.mockResolvedValue([
      { index: 1, path: '/tmp/clip.mp4', startTime: 0, endTime: 20, duration: 20, sizeBytes: 1000, validation: { hasVisualHook: true, confidence: 0.9, suggestions: [] } }
    ]);
    clipScoringService.scoreClipsWithVidalis.mockResolvedValue([
      { index: 1, path: '/tmp/clip.mp4', startTime: 0, endTime: 20, duration: 20, sizeBytes: 1000, validation: { hasVisualHook: true, confidence: 0.9, suggestions: [] }, score: { viralScore: 80 } }
    ]);

    // Queue enough DB responses for all stages
    for (let i = 0; i < 6; i++) {
      mock.queueResult({ data: { ai_clips_data: {} }, error: null });
      mock.queueResult({ data: null, error: null });
    }

    await generateClipsMultiIA(videoPath, videoId);

    // Verify update was called
    expect(updateSpy).toHaveBeenCalled();

    // Get all update calls
    const updateCalls = updateSpy.mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  test('cleans up temp clips directory in finally block even on error', async () => {
    const videoPath = '/tmp/video.mp4';
    const videoId = 'video-4';

    transcriptionService.transcribeVideo.mockResolvedValue({ text: 'Text' });
    momentDetectionService.detectMomentsWithClaude.mockResolvedValue([
      { index: 1, start: 0, end: 20, reason: 'Good', confidence: 0.9, tags: [] }
    ]);
    clipGenerationService.generateClips.mockResolvedValue([
      { index: 1, path: '/tmp/clips_xxx_123/clip_1.mp4', startTime: 0, endTime: 20, duration: 20, sizeBytes: 1000 }
    ]);
    clipValidationService.validateClipsWithGemini.mockRejectedValue(new Error('Validation failed'));

    // Queue DB responses
    for (let i = 0; i < 4; i++) {
      mock.queueResult({ data: { ai_clips_data: {} }, error: null });
      mock.queueResult({ data: null, error: null });
    }

    try {
      await generateClipsMultiIA(videoPath, videoId);
    } catch {}

    // Verify cleanup was called
    expect(clipGenerationService.cleanupClips).toHaveBeenCalled();
  });

  test('handles empty moments list with error', async () => {
    const videoPath = '/tmp/video.mp4';
    const videoId = 'video-5';

    transcriptionService.transcribeVideo.mockResolvedValue({ text: 'Text' });
    momentDetectionService.detectMomentsWithClaude.mockRejectedValue(
      new Error('No valid moments detected')
    );

    // Queue DB responses
    mock.queueResult({ data: { ai_clips_data: {} }, error: null });
    mock.queueResult({ data: null, error: null });
    mock.queueResult({ data: { ai_clips_data: {} }, error: null });
    mock.queueResult({ data: null, error: null });

    await expect(generateClipsMultiIA(videoPath, videoId)).rejects.toThrow('No valid moments detected');
  });
});
