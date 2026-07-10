process.env.RABBITMQ_URL = 'amqp://localhost';

const mockChannel = {
  assertExchange: jest.fn().mockResolvedValue({}),
  assertQueue: jest.fn().mockResolvedValue({}),
  bindQueue: jest.fn().mockResolvedValue({}),
  sendToQueue: jest.fn().mockReturnValue(true),
};
const mockConn = { createChannel: jest.fn().mockResolvedValue(mockChannel), on: jest.fn() };
jest.mock('amqplib', () => ({ connect: jest.fn().mockResolvedValue(mockConn) }));

const { assertRepurposeTopology, publishRepurposeJob, REPURPOSE_QUEUE, redactAmqpUrl } = require('../../src/lib/queue');

afterEach(() => jest.clearAllMocks());

describe('redactAmqpUrl', () => {
  test('oculta la contraseña pero conserva host, puerto y usuario', () => {
    expect(redactAmqpUrl('amqp://miuser:secreto123@rabbitmq.railway.internal:5672'))
      .toBe('amqp://miuser:***@rabbitmq.railway.internal:5672');
  });

  test('devuelve un mensaje claro si RABBITMQ_URL no está configurada', () => {
    expect(redactAmqpUrl(undefined)).toBe('(RABBITMQ_URL no configurada)');
    expect(redactAmqpUrl('')).toBe('(RABBITMQ_URL no configurada)');
  });

  test('devuelve un mensaje claro si el valor no es una URL válida', () => {
    expect(redactAmqpUrl('esto-no-es-una-url')).toBe('(RABBITMQ_URL inválida)');
  });
});

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
