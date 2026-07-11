process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const vidalisService = require('../../src/services/vidalisService');

afterEach(() => jest.clearAllMocks());

describe('fetchArtistGallery', () => {
  it('should NOT filter by parent_video_id (clips should be included)', async () => {
    const isSpy = jest.spyOn(mock.client, 'is');
    mock.queueResult({ data: [{ id: 'v1' }, { id: 'clip-1', parent_video_id: 'v1' }], error: null });

    const result = await vidalisService.fetchArtistGallery('artist-1', {});

    expect(isSpy).not.toHaveBeenCalledWith('parent_video_id', null);
    expect(result).toHaveLength(2);
  });
});
