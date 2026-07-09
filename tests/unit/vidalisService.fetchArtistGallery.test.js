process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const vidalisService = require('../../src/services/vidalisService');

afterEach(() => jest.clearAllMocks());

describe('fetchArtistGallery', () => {
  test('excluye los clips hijos del Repurposer filtrando parent_video_id nulo', async () => {
    const isSpy = jest.spyOn(mock.client, 'is');
    mock.queueResult({
      data: [
        { id: 'v1', artist_id: 'artist-1', parent_video_id: null },
        { id: 'v2', artist_id: 'artist-1', parent_video_id: null },
      ],
      error: null,
    });

    const videos = await vidalisService.fetchArtistGallery('artist-1');

    expect(isSpy).toHaveBeenCalledWith('parent_video_id', null);
    expect(videos.map(v => v.id)).toEqual(['v1', 'v2']);
  });
});
