process.env.R2_ACCOUNT_ID = 'acc123';
process.env.R2_ACCESS_KEY_ID = 'key';
process.env.R2_SECRET_ACCESS_KEY = 'secret';
process.env.R2_BUCKET_NAME = 'vidalis';
process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://acc123.r2.cloudflarestorage.com/vidalis/signed?X-Amz=1'),
}));

const { buildSourceKey, generatePresignedUploadUrl } = require('../../src/lib/r2');

afterEach(() => jest.clearAllMocks());

describe('buildSourceKey', () => {
  test('usa el prefijo por artista y conserva la extensión', () => {
    const key = buildSourceKey('artist-1', 'Mi Podcast.mp4');
    expect(key).toMatch(/^repurposer\/sources\/artist-1\/[0-9a-f-]{36}\.mp4$/);
  });

  test('cae a .mp4 si el archivo no tiene extensión', () => {
    const key = buildSourceKey('artist-1', 'video');
    expect(key).toMatch(/\.mp4$/);
  });
});

describe('generatePresignedUploadUrl', () => {
  test('devuelve uploadUrl firmada y sourceUrl pública basada en R2_PUBLIC_URL', async () => {
    const out = await generatePresignedUploadUrl({ artistId: 'artist-1', filename: 'p.mp4', contentType: 'video/mp4' });
    expect(out.uploadUrl).toContain('X-Amz');
    expect(out.sourceUrl).toBe(`https://cdn.example.com/${out.key}`);
    expect(out.key).toMatch(/^repurposer\/sources\/artist-1\//);
  });
});
