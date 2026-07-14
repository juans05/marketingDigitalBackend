process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockCreate },
})));

jest.mock('../../src/services/trendService', () => ({
  fetchAllTrends: jest.fn().mockResolvedValue([]),
}));

const { generateDailyIdeas } = require('../../src/services/ideaBankService');

afterEach(() => jest.clearAllMocks());

describe('generateDailyIdeas', () => {
  it('should tell Claude which hooks were already generated recently and not to repeat them', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify([
          { hook: 'Nueva idea 1', bullets: ['a'], cta: 'x', category: 'general', trend_source: null, trend_platform: 'original' },
        ]),
      }],
    });

    mock.queueResult({ data: { tone: 'directo', common_themes: [], preferred_formats: [], hook_patterns: [] }, error: null }); // getStyleProfile
    mock.queueResult({ data: [], error: null }); // getRecentPreferences
    mock.queueResult({ data: [{ hook: 'Idea vieja A' }, { hook: 'Idea vieja B' }], error: null }); // getRecentlyGeneratedHooks
    mock.queueResult({ data: [{ id: 'idea-1', hook: 'Nueva idea 1' }], error: null }); // insert

    await generateDailyIdeas('artist-1', 5);

    const sentPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('Idea vieja A');
    expect(sentPrompt).toContain('Idea vieja B');
    expect(sentPrompt).toMatch(/no.*repit/i);
  });

  it('should fall back to a generic note when there are no recent ideas', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify([]) }],
    });

    mock.queueResult({ data: null, error: null }); // getStyleProfile
    mock.queueResult({ data: [], error: null }); // getRecentPreferences
    mock.queueResult({ data: [], error: null }); // getRecentlyGeneratedHooks
    mock.queueResult({ data: [], error: null }); // insert

    await generateDailyIdeas('artist-1', 5);

    const sentPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('Sin ideas previas');
  });
});
