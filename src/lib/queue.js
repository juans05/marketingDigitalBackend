const amqp = require('amqplib');

const REPURPOSE_QUEUE = 'repurpose.jobs';
const REPURPOSE_DLQ = 'repurpose.jobs.dlq';
const REPURPOSE_DLX = 'repurpose.dlx';

let connPromise = null;
let channelPromise = null;

async function assertRepurposeTopology(channel) {
  await channel.assertExchange(REPURPOSE_DLX, 'fanout', { durable: true });
  await channel.assertQueue(REPURPOSE_DLQ, { durable: true });
  await channel.bindQueue(REPURPOSE_DLQ, REPURPOSE_DLX, '');
  await channel.assertQueue(REPURPOSE_QUEUE, { durable: true, deadLetterExchange: REPURPOSE_DLX });
}

async function getChannel() {
  if (!channelPromise) {
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
  console.error('❌ [Repurposer] publicando en cola:', parentVideoId);
  const ch = await getChannel();
  ch.sendToQueue(
    REPURPOSE_QUEUE,
    Buffer.from(JSON.stringify({ parentVideoId })),
    { persistent: true },
  );
}

module.exports = { assertRepurposeTopology, publishRepurposeJob, getChannel, REPURPOSE_QUEUE, REPURPOSE_DLQ, REPURPOSE_DLX };
