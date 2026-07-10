const amqp = require('amqplib');

const REPURPOSE_QUEUE = 'repurpose.jobs';
const REPURPOSE_DLQ = 'repurpose.jobs.dlq';
const REPURPOSE_DLX = 'repurpose.dlx';

let connPromise = null;
let channelPromise = null;

// RABBITMQ_URL trae usuario y contraseña embebidos (amqp://user:pass@host:port)
// -- nunca se loguea completa. Esto muestra host/puerto/usuario, útil para
// confirmar que apunta al broker correcto, sin exponer la contraseña.
function redactAmqpUrl(url) {
  if (!url) return '(RABBITMQ_URL no configurada)';
  try {
    const parsed = new URL(url);
    const auth = parsed.username ? `${parsed.username}:***@` : '';
    return `${parsed.protocol}//${auth}${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return '(RABBITMQ_URL inválida)';
  }
}

async function assertRepurposeTopology(channel) {
  await channel.assertExchange(REPURPOSE_DLX, 'fanout', { durable: true });
  await channel.assertQueue(REPURPOSE_DLQ, { durable: true });
  await channel.bindQueue(REPURPOSE_DLQ, REPURPOSE_DLX, '');
  await channel.assertQueue(REPURPOSE_QUEUE, { durable: true, deadLetterExchange: REPURPOSE_DLX });
}

async function getChannel() {
  if (!channelPromise) {
    console.log(`🐇 [Queue] Conectando a RabbitMQ: ${redactAmqpUrl(process.env.RABBITMQ_URL)}`);
    connPromise = amqp.connect(process.env.RABBITMQ_URL);
    channelPromise = connPromise.then(async (conn) => {
      conn.on('close', () => { connPromise = null; channelPromise = null; });
      conn.on('error', () => { connPromise = null; channelPromise = null; });
      const ch = await conn.createChannel();
      await assertRepurposeTopology(ch);
      return ch;
    });
  }
  return channelPromise;
}

async function publishRepurposeJob(parentVideoId) {
  const ch = await getChannel();
  ch.sendToQueue(
    REPURPOSE_QUEUE,
    Buffer.from(JSON.stringify({ parentVideoId })),
    { persistent: true },
  );
}

module.exports = { assertRepurposeTopology, publishRepurposeJob, getChannel, redactAmqpUrl, REPURPOSE_QUEUE, REPURPOSE_DLQ, REPURPOSE_DLX };
