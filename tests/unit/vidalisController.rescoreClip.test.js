jest.mock('../../src/services/clipImpactScoringService', () => ({
  rescoreClip: jest.fn(),
}));
const { rescoreClip } = require('../../src/services/clipImpactScoringService');
const vidalisController = require('../../src/controllers/vidalisController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

afterEach(() => jest.clearAllMocks());

describe('vidalisController.rescoreClip', () => {
  it('should call rescoreClip with the video id, platform, and niche from the body', async () => {
    rescoreClip.mockResolvedValue({ clipVideoId: 'clip-1', platform: 'instagram', score: 9 });
    const req = { params: { videoId: 'clip-1' }, body: { platform: 'instagram', niche: 'comedy' } };
    const res = mockRes();

    await vidalisController.rescoreClip(req, res);

    expect(rescoreClip).toHaveBeenCalledWith('clip-1', 'instagram', 'comedy');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ clipVideoId: 'clip-1', platform: 'instagram', score: 9 });
  });

  it('should return 400 if platform is missing', async () => {
    const req = { params: { videoId: 'clip-1' }, body: {} };
    const res = mockRes();

    await vidalisController.rescoreClip(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(rescoreClip).not.toHaveBeenCalled();
  });

  it('should return 500 with the error message when rescoreClip throws', async () => {
    rescoreClip.mockRejectedValue(new Error('Clip not found: clip-1'));
    const req = { params: { videoId: 'clip-1' }, body: { platform: 'tiktok' } };
    const res = mockRes();

    await vidalisController.rescoreClip(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Clip not found: clip-1' });
  });
});
