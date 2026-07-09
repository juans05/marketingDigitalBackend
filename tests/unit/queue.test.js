process.env.RABBITMQ_URL = 'amqp://localhost';

const mockChannel = {
  assertExchange: jest.fn().mockResolvedValue({}),
  assertQueue: jest.fn().mockResolvedValue({}),
  bindQueue: jest.fn().mockResolvedValue({}),
  sendToQueue: jest.fn().mockReturnValue(true),
};
const mockConn = { createChannel: jest.fn().mockResolvedValue(mockChannel), on: jest.fn() };
jest.mock('amqplib', () => ({ connect: jest.fn().mockResolvedValue(mockConn) }));

const { assertRepurposeTopology, publishRepurposeJob, REPURPOSE_QUEUE } = require('../../src/lib/queue');

afterEach(() => jest.clearAllMocks());

describe('queue topology', () => {
  test('declara la cola principal con dead-letter exchange', async () => {
    await assertRepurposeTopology(mockChannel);
    expect(mockChannel.assertExchange).toHaveBeenCalledWith('repurpose.dlx', 'fanout', { durable: true });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('repurpose.jobs.dlq', { durable: true });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('repurpose.jobs', {
      durable: true, deadLetterExchange: 'repurpose.dlx',
    });
  });
});

describe('publishRepurposeJob', () => {
  test('envía el parentVideoId como mensaje persistente a la cola', async () => {
    await publishRepurposeJob('video-1');
    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      REPURPOSE_QUEUE,
      Buffer.from(JSON.stringify({ parentVideoId: 'video-1' })),
      { persistent: true },
    );
  });
});
