const { getChannel, REPURPOSE_QUEUE } = require('../lib/queue');
const { generateClips } = require('../services/repurposerService');

async function handleMessage(msg, deps) {
  const { generateClips: run, channel } = deps;
  const { parentVideoId } = JSON.parse(msg.content.toString());
  try {
    await run(parentVideoId);
    channel.ack(msg);
  } catch (err) {
    console.error(`❌ [Worker] Job ${parentVideoId} falló, va a la DLQ:`, err.message);
    channel.nack(msg, false, false); // requeue=false -> dead-letter
  }
}

async function startWorker() {
  const channel = await getChannel();
  const prefetch = Number(process.env.WORKER_PREFETCH || 2);
  await channel.prefetch(prefetch);
  console.log(`🐇 [Worker] Escuchando ${REPURPOSE_QUEUE} (prefetch=${prefetch})`);
  await channel.consume(REPURPOSE_QUEUE, (msg) => {
    if (msg) handleMessage(msg, { generateClips, channel });
  });
}

if (require.main === module) {
  require('dotenv').config();
  startWorker().catch((err) => {
    console.error('❌ [Worker] No se pudo arrancar:', err.message);
    process.exit(1);
  });
}

module.exports = { handleMessage, startWorker };
