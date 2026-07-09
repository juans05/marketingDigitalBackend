const http = require('http');
const { getChannel, REPURPOSE_QUEUE } = require('../lib/queue');
const { generateClips } = require('../services/repurposerService');

// El worker no sirve HTTP (solo consume RabbitMQ), pero Railway hace un check
// de red sobre el puerto asignado a todo servicio aunque no tenga
// healthcheckPath configurado. Sin nada escuchando, ese check expira siempre.
// Este servidor mínimo solo existe para satisfacerlo.
function createHealthServer(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'repurpose-worker' }));
  });
  server.listen(port);
  return server;
}

async function handleMessage(msg, deps) {
  const { generateClips: run, channel } = deps;
  const { parentVideoId } = JSON.parse(msg.content.toString());
  console.log(`📥 [Worker] Job recibido: ${parentVideoId}`);
  const startedAt = Date.now();
  try {
    await run(parentVideoId);
    channel.ack(msg);
    console.log(`✅ [Worker] Job ${parentVideoId} OK en ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
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
  createHealthServer(process.env.PORT || 3000);
  startWorker().catch((err) => {
    console.error('❌ [Worker] No se pudo arrancar:', err.message);
    process.exit(1);
  });
}

module.exports = { handleMessage, startWorker, createHealthServer };
