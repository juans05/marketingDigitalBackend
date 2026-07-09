jest.mock('../../src/lib/r2', () => ({
  generatePresignedUploadUrl: jest.fn().mockResolvedValue({
    uploadUrl: 'https://r2/signed', sourceUrl: 'https://cdn/key', key: 'repurposer/sources/a/x.mp4',
  }),
}));

const controller = require('../../src/controllers/vidalisController');
const r2 = require('../../src/lib/r2');

function mockRes() {
  return { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
afterEach(() => jest.clearAllMocks());

describe('createRepurposePresign', () => {
  test('devuelve la URL prefirmada para el artista y archivo dados', async () => {
    const req = { body: { artistId: 'a', filename: 'p.mp4', contentType: 'video/mp4' } };
    const res = mockRes();
    await controller.createRepurposePresign(req, res);
    expect(r2.generatePresignedUploadUrl).toHaveBeenCalledWith({ artistId: 'a', filename: 'p.mp4', contentType: 'video/mp4' });
    expect(res.statusCode).toBe(200);
    expect(res.body.uploadUrl).toBe('https://r2/signed');
  });

  test('responde 400 si falta artistId', async () => {
    r2.generatePresignedUploadUrl.mockRejectedValueOnce(new Error('artistId es requerido'));
    const req = { body: { filename: 'p.mp4' } };
    const res = mockRes();
    await controller.createRepurposePresign(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('artistId');
  });
});
