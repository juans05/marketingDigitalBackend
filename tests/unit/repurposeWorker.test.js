const { handleMessage } = require('../../src/workers/repurposeWorker');

function msgFor(payload) { return { content: Buffer.from(JSON.stringify(payload)) }; }
afterEach(() => jest.clearAllMocks());

describe('handleMessage', () => {
  test('procesa el job y hace ack cuando generateClips termina bien', async () => {
    const generateClips = jest.fn().mockResolvedValue();
    const channel = { ack: jest.fn(), nack: jest.fn() };
    await handleMessage(msgFor({ parentVideoId: 'v1' }), { generateClips, channel });
    expect(generateClips).toHaveBeenCalledWith('v1');
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  test('hace nack sin requeue (va a la DLQ) cuando generateClips lanza', async () => {
    const generateClips = jest.fn().mockRejectedValue(new Error('boom'));
    const channel = { ack: jest.fn(), nack: jest.fn() };
    await handleMessage(msgFor({ parentVideoId: 'v1' }), { generateClips, channel });
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });
});
