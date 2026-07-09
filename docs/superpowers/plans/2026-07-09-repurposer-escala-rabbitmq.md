# Repurposer Escalable (R2 + RabbitMQ + Workers) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rediseñar el pipeline del Repurposer para escalar en horizontal: subida directa a R2, jobs en una cola durable de RabbitMQ y un worker de Node que consume y procesa.

**Architecture:** El navegador sube el video fuente **directo a R2** con una URL prefirmada (no cruza el backend). El API delgado crea la fila padre y **publica** un job en RabbitMQ. Un proceso worker aparte consume la cola (competing consumers, escalable por réplicas) y corre el pipeline existente (`generateClips`), que llama al `/cut` de Python (sin estado, ffmpeg lee de R2 por rango) y sube clips a Cloudinary.

**Tech Stack:** Node.js + Express + Jest (backend), `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (R2), `amqplib` (RabbitMQ), Python + FastAPI + pytest (media service), React (frontend).

**Spec:** [docs/superpowers/specs/2026-07-08-repurposer-escala-rabbitmq-design.md](../specs/2026-07-08-repurposer-escala-rabbitmq-design.md)

## Global Constraints

- Node backend usa **CommonJS** (`require`/`module.exports`), no ESM.
- Tests con **Jest** (`npm test`); mock de Supabase con `tests/helpers/supabaseMock.js` (FIFO de `{ data, error }` vía `mock.queueResult(...)`).
- Supabase se instancia a nivel de módulo; los tests fijan `process.env.SUPABASE_URL` / `SUPABASE_ANON_KEY` **antes** de requerir el servicio.
- IDs únicos con `crypto.randomUUID()` (built-in de Node, sin dependencia nueva).
- Envs R2 ya existentes en `.env`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`.
- Envs nuevas: `RABBITMQ_URL`, `WORKER_PREFETCH` (default `2`).
- Nombres de cola: `repurpose.jobs` (durable) y su DLQ `repurpose.jobs.dlq` vía dead-letter exchange `repurpose.dlx`.
- Keys de R2: `repurposer/sources/{artistId}/{uuid}.{ext}`.
- Mensajes al usuario en español (patrón del código actual).

---

## File Structure

**Backend Node (`marketingDigitalBackend`):**
- Create: `src/lib/r2.js` — cliente R2 + presign (buildSourceKey, generatePresignedUploadUrl).
- Create: `src/lib/queue.js` — conexión amqplib + assert de colas + publishRepurposeJob.
- Create: `src/workers/repurposeWorker.js` — consumidor de `repurpose.jobs`.
- Modify: `src/services/repurposerService.js` — presign passthrough, idempotencia, publish, `/cut` por `source_url`.
- Modify: `src/controllers/vidalisController.js` — handler `createRepurposePresign`.
- Modify: `src/routes/vidalisRoutes.js` — ruta `POST /repurpose/presign`.
- Modify: `package.json` — deps + script `worker`.
- Create/Modify tests bajo `tests/unit/`.

**Media service Python (`python-services`):**
- Modify: `main.py` — `/cut` por `source_url`, quitar `/upload` + `/static` + storage local, helper de comando ffmpeg.
- Create: `tests/test_cut.py`, `requirements-dev.txt`.

**Frontend (`marketingDigitalFrontend`):**
- Modify: `src/components/RepurposerView.jsx` — flujo presign → PUT directo → registrar.

---

# MILESTONE 1 — Subida directa a R2

## Task 1: Cliente R2 y URL prefirmada (`src/lib/r2.js`)

**Files:**
- Create: `src/lib/r2.js`
- Test: `tests/unit/r2.presign.test.js`
- Modify: `package.json` (deps)

**Interfaces:**
- Produces:
  - `buildSourceKey(artistId: string, filename: string): string` → `repurposer/sources/{artistId}/{uuid}.{ext}`
  - `generatePresignedUploadUrl({ artistId, filename, contentType }): Promise<{ uploadUrl: string, sourceUrl: string, key: string }>`

- [ ] **Step 1: Instalar dependencias de R2**

Run:
```bash
npm install @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3
```
Expected: se agregan a `dependencies` en `package.json`.

- [ ] **Step 2: Escribir el test que falla**

Create `tests/unit/r2.presign.test.js`:
```js
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
```

- [ ] **Step 3: Correr el test para verlo fallar**

Run: `npm test -- r2.presign`
Expected: FAIL con "Cannot find module '../../src/lib/r2'".

- [ ] **Step 4: Implementar `src/lib/r2.js`**

```js
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function getClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function buildSourceKey(artistId, filename) {
  const dot = String(filename || '').lastIndexOf('.');
  const ext = dot > -1 ? filename.slice(dot + 1).toLowerCase() : 'mp4';
  return `repurposer/sources/${artistId}/${crypto.randomUUID()}.${ext}`;
}

async function generatePresignedUploadUrl({ artistId, filename, contentType }) {
  if (!artistId) throw new Error('artistId es requerido');
  const key = buildSourceKey(artistId, filename);
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType || 'video/mp4',
  });
  const uploadUrl = await getSignedUrl(getClient(), command, { expiresIn: 600 });
  const sourceUrl = `${process.env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
  return { uploadUrl, sourceUrl, key };
}

module.exports = { buildSourceKey, generatePresignedUploadUrl };
```

- [ ] **Step 5: Correr el test para verlo pasar**

Run: `npm test -- r2.presign`
Expected: PASS (5 asserts).

- [ ] **Step 6: Commit**

```bash
git add src/lib/r2.js tests/unit/r2.presign.test.js package.json package-lock.json
git commit -m "feat(repurposer): cliente R2 y generación de URL prefirmada"
```

---

## Task 2: Endpoint `POST /repurpose/presign`

**Files:**
- Modify: `src/controllers/vidalisController.js` (agregar `createRepurposePresign`, junto a `createRepurposeVideo` en la línea ~285)
- Modify: `src/routes/vidalisRoutes.js:45` (agregar ruta)
- Test: `tests/unit/repurposePresign.controller.test.js`

**Interfaces:**
- Consumes: `r2.generatePresignedUploadUrl` (Task 1)
- Produces: `exports.createRepurposePresign(req, res)` — responde `{ uploadUrl, sourceUrl, key }`

- [ ] **Step 1: Escribir el test que falla**

Create `tests/unit/repurposePresign.controller.test.js`:
```js
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
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npm test -- repurposePresign`
Expected: FAIL con "controller.createRepurposePresign is not a function".

- [ ] **Step 3: Implementar el handler**

En `src/controllers/vidalisController.js`, justo después de `exports.createRepurposeVideo = ...` (línea ~293):
```js
exports.createRepurposePresign = async (req, res) => {
  try {
    const { artistId, filename, contentType } = req.body;
    const { generatePresignedUploadUrl } = require('../lib/r2');
    const result = await generatePresignedUploadUrl({ artistId, filename, contentType });
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
```

- [ ] **Step 4: Registrar la ruta**

En `src/routes/vidalisRoutes.js`, después de la línea 45 (`/repurpose/upload`):
```js
router.post('/repurpose/presign', authenticateToken, authorizeArtist, vidalisController.createRepurposePresign);
```

- [ ] **Step 5: Correr el test para verlo pasar**

Run: `npm test -- repurposePresign`
Expected: PASS.

- [ ] **Step 6: Configurar CORS del bucket R2 (manual, sin código)**

En el panel de Cloudflare R2 → bucket → Settings → CORS policy, agregar:
```json
[{ "AllowedOrigins": ["http://localhost:5173", "https://vidalis-frontend-production.up.railway.app"],
   "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
```
Verificación: desde la consola del navegador en el frontend, un `fetch(uploadUrl, { method:'PUT', body: blob })` no debe dar error de CORS.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/vidalisController.js src/routes/vidalisRoutes.js tests/unit/repurposePresign.controller.test.js
git commit -m "feat(repurposer): endpoint POST /repurpose/presign para subida directa a R2"
```

---

# MILESTONE 2 — Cola RabbitMQ + worker

## Task 3: Publisher de RabbitMQ (`src/lib/queue.js`)

**Files:**
- Create: `src/lib/queue.js`
- Test: `tests/unit/queue.test.js`
- Modify: `package.json` (dep `amqplib`)

**Interfaces:**
- Produces:
  - `assertRepurposeTopology(channel): Promise<void>` — declara `repurpose.dlx`, `repurpose.jobs.dlq`, `repurpose.jobs`.
  - `publishRepurposeJob(parentVideoId: string): Promise<void>`
  - `REPURPOSE_QUEUE = 'repurpose.jobs'` (export const)

- [ ] **Step 1: Instalar amqplib**

Run: `npm install amqplib@^0.10`
Expected: `amqplib` en `dependencies`.

- [ ] **Step 2: Escribir el test que falla**

Create `tests/unit/queue.test.js`:
```js
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
```

- [ ] **Step 3: Correr el test para verlo fallar**

Run: `npm test -- queue`
Expected: FAIL con "Cannot find module '../../src/lib/queue'".

- [ ] **Step 4: Implementar `src/lib/queue.js`**

```js
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
  const ch = await getChannel();
  ch.sendToQueue(
    REPURPOSE_QUEUE,
    Buffer.from(JSON.stringify({ parentVideoId })),
    { persistent: true },
  );
}

module.exports = { assertRepurposeTopology, publishRepurposeJob, getChannel, REPURPOSE_QUEUE, REPURPOSE_DLQ, REPURPOSE_DLX };
```

- [ ] **Step 5: Correr el test para verlo pasar**

Run: `npm test -- queue`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue.js tests/unit/queue.test.js package.json package-lock.json
git commit -m "feat(repurposer): publisher de RabbitMQ con cola durable y DLQ"
```

---

## Task 4: `createRepurposeVideo` publica en la cola (no fire-and-forget)

**Files:**
- Modify: `src/services/repurposerService.js:196-214` (función `createRepurposeVideo`)
- Modify: `tests/unit/repurposerService.createRepurposeVideo.test.js`

**Interfaces:**
- Consumes: `queue.publishRepurposeJob` (Task 3)
- Produces: `createRepurposeVideo(...)` crea fila con `status: 'queued'` y publica el job.

- [ ] **Step 1: Actualizar el test que falla**

En `tests/unit/repurposerService.createRepurposeVideo.test.js`, añadir al inicio (después de la línea 9) el mock de la cola:
```js
jest.mock('../../src/lib/queue', () => ({ publishRepurposeJob: jest.fn().mockResolvedValue() }));
const queue = require('../../src/lib/queue');
```
Y reemplazar el primer test (`crea la fila padre con status processing...`) por:
```js
  test('crea la fila padre con status queued y publica el job en la cola', async () => {
    mock.queueResult({ data: { id: 'artist-1' }, error: null }); // select artist
    mock.queueResult({ data: [{ id: 'video-1', artist_id: 'artist-1', status: 'queued' }], error: null }); // insert video

    const video = await repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'https://cdn.example.com/repurposer/sources/artist-1/x.mp4',
      title: 'Mi podcast',
      durationSeconds: 3600,
    });

    expect(video.status).toBe('queued');
    expect(queue.publishRepurposeJob).toHaveBeenCalledWith('video-1');
  });
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npm test -- createRepurposeVideo`
Expected: FAIL (el servicio aún inserta `status: 'processing'` y llama a `generateClips`, no a `publishRepurposeJob`).

- [ ] **Step 3: Modificar `createRepurposeVideo`**

En `src/services/repurposerService.js`, dentro de `createRepurposeVideo`: cambiar el `status` del insert y reemplazar el disparo fire-and-forget.

Cambiar (línea ~202):
```js
      status: 'processing',
```
por:
```js
      status: 'queued',
```
Y reemplazar el bloque (líneas ~209-211):
```js
  module.exports.generateClips(video.id).catch(err => {
    console.error(`❌ [Repurposer] Error generando clips para ${video.id}:`, err.message);
  });
```
por:
```js
  const { publishRepurposeJob } = require('../lib/queue');
  await publishRepurposeJob(video.id);
```

- [ ] **Step 4: Correr toda la suite del servicio**

Run: `npm test -- repurposerService`
Expected: PASS. (Los tests de `generateClips` no dependen de este cambio.)

- [ ] **Step 5: Commit**

```bash
git add src/services/repurposerService.js tests/unit/repurposerService.createRepurposeVideo.test.js
git commit -m "feat(repurposer): encolar job en RabbitMQ en vez de fire-and-forget"
```

---

## Task 5: Idempotencia en `generateClips` (borra hijos previos)

**Files:**
- Modify: `src/services/repurposerService.js` (dentro de `generateClips`, tras leer parent+artist, antes de `detectSegments`)
- Modify: `tests/unit/repurposerService.generateClips.test.js`

**Interfaces:**
- Produces: `generateClips` borra `videos` con `parent_video_id = parentVideoId` antes de regenerar.

- [ ] **Step 1: Añadir el test que falla**

En `tests/unit/repurposerService.generateClips.test.js`, añadir un spy sobre `delete` bajo el `updateSpy` (línea ~15):
```js
const deleteSpy = jest.spyOn(mock.client, 'delete');
```
Y añadir este test nuevo dentro del `describe('generateClips', ...)`:
```js
  test('borra los clips hijos previos antes de regenerar (idempotencia)', async () => {
    mock.queueResult({ data: { id: 'parent-1', artist_id: 'artist-1', title: 'P', source_url: 'https://cdn/x.mp4', platforms: null }, error: null }); // select parent
    mock.queueResult({ data: { id: 'artist-1', name: 'J', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: [] }, error: null }); // select artist
    mock.queueResult({ error: null }); // delete hijos
    aiService.detectSegments.mockResolvedValueOnce([]); // sin segmentos -> corta rápido
    mock.queueResult({ error: null }); // update status failed

    await generateClips('parent-1');
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npm test -- generateClips`
Expected: FAIL — `deleteSpy` no se llamó (0 veces).

- [ ] **Step 3: Implementar el borrado idempotente**

En `src/services/repurposerService.js`, dentro de `generateClips`, justo después del bloque que arma `learningContext` (línea ~53, antes de `let segments;`):
```js
  // Idempotencia: si el job se re-entrega, borra los clips hijos previos para
  // no duplicar en la galería.
  await supabase.from('videos').delete().eq('parent_video_id', parentVideoId);
```

- [ ] **Step 4: Ajustar los tests existentes de `generateClips`**

Los 3 tests existentes ahora consumen un resultado extra (el `delete`). En cada uno, tras las dos líneas de `mock.queueResult` de `select artist`, insertar:
```js
    mock.queueResult({ error: null }); // delete hijos previos (idempotencia)
```
(Es decir: en los 3 tests, agregar esa línea justo después del segundo `mock.queueResult({ ... }); // select artist`.)

- [ ] **Step 5: Correr toda la suite de generateClips**

Run: `npm test -- generateClips`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/repurposerService.js tests/unit/repurposerService.generateClips.test.js
git commit -m "feat(repurposer): generateClips idempotente (borra hijos previos)"
```

---

## Task 6: Worker consumidor (`src/workers/repurposeWorker.js`)

**Files:**
- Create: `src/workers/repurposeWorker.js`
- Test: `tests/unit/repurposeWorker.test.js`
- Modify: `package.json` (script `worker`)

**Interfaces:**
- Consumes: `queue.getChannel`, `queue.REPURPOSE_QUEUE`, `repurposerService.generateClips`
- Produces:
  - `handleMessage(msg, { generateClips, channel }): Promise<void>` — ack en éxito, nack (sin requeue → DLX) en error.
  - `startWorker(): Promise<void>` — arranca el consumidor con `prefetch`.

- [ ] **Step 1: Escribir el test que falla**

Create `tests/unit/repurposeWorker.test.js`:
```js
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
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npm test -- repurposeWorker`
Expected: FAIL con "Cannot find module '../../src/workers/repurposeWorker'".

- [ ] **Step 3: Implementar el worker**

```js
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
```

- [ ] **Step 4: Correr el test para verlo pasar**

Run: `npm test -- repurposeWorker`
Expected: PASS.

- [ ] **Step 5: Añadir el script `worker`**

En `package.json`, dentro de `"scripts"`:
```json
    "worker": "node src/workers/repurposeWorker.js",
```

- [ ] **Step 6: Commit**

```bash
git add src/workers/repurposeWorker.js tests/unit/repurposeWorker.test.js package.json
git commit -m "feat(repurposer): worker consumidor de RabbitMQ (ack/nack + DLQ)"
```

---

# MILESTONE 3 — Media service Python sin estado

## Task 7: `generateClips` pasa `source_url` al `/cut` (Node)

**Files:**
- Modify: `src/services/repurposerService.js:77-90` (bloque "Modo Python")
- Test: `tests/unit/repurposerService.cutPayload.test.js`

**Interfaces:**
- Produces: `generateClips` llama a `POST {CLIPPER_SERVICE_URL}/cut` con `{ source_url, segments, artist_id }` (ya no `video_id`).

- [ ] **Step 1: Escribir el test que falla**

Create `tests/unit/repurposerService.cutPayload.test.js`:
```js
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.CLIPPER_SERVICE_URL = 'http://python:8080';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));
jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ data: { clips: [] } }) }));
jest.mock('../../src/services/aiService', () => ({
  detectSegments: jest.fn().mockResolvedValue([{ start: 1, end: 5, title: 'A', reason: 'r' }]),
  generateCopyWithClaude: jest.fn(), fetchArtistLearningContext: jest.fn().mockResolvedValue(null),
}));

const axios = require('axios');
const { generateClips } = require('../../src/services/repurposerService');
afterEach(() => jest.clearAllMocks());

test('llama a /cut con source_url (la URL de R2), no con video_id', async () => {
  mock.queueResult({ data: { id: 'p1', artist_id: 'a1', title: 'T', source_url: 'https://cdn/repurposer/sources/a1/x.mp4', platforms: ['tiktok'] }, error: null }); // parent
  mock.queueResult({ data: { id: 'a1', name: 'J', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: ['tiktok'] }, error: null }); // artist
  mock.queueResult({ error: null }); // delete hijos
  mock.queueResult({ error: null }); // update final

  await generateClips('p1');

  expect(axios.post).toHaveBeenCalledWith('http://python:8080/cut', {
    source_url: 'https://cdn/repurposer/sources/a1/x.mp4',
    segments: [{ start: 1, end: 5, title: 'A' }],
    artist_id: 'a1',
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npm test -- cutPayload`
Expected: FAIL — el payload actual manda `{ video_id, segments, artist_id }`.

- [ ] **Step 3: Modificar el bloque "Modo Python"**

En `src/services/repurposerService.js`, reemplazar (líneas ~80-89):
```js
      const tempVideoId = parent.source_url.split('/').pop();
      const response = await axios.post(`${clipperUrl.replace(/\/+$/, '')}/cut`, {
        video_id: tempVideoId,
        segments: segments.map(s => ({
          start: s.start,
          end: s.end,
          title: s.title
        })),
        artist_id: parent.artist_id
      });
```
por:
```js
      const response = await axios.post(`${clipperUrl.replace(/\/+$/, '')}/cut`, {
        source_url: parent.source_url,
        segments: segments.map(s => ({ start: s.start, end: s.end, title: s.title })),
        artist_id: parent.artist_id,
      });
```

- [ ] **Step 4: Correr el test para verlo pasar**

Run: `npm test -- cutPayload`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/repurposerService.js tests/unit/repurposerService.cutPayload.test.js
git commit -m "feat(repurposer): generateClips pasa source_url (R2) al /cut de Python"
```

---

## Task 8: `/cut` de Python lee desde `source_url` + pytest

**Files:**
- Modify: `python-services/main.py` (modelo `CutRequest`, endpoint `/cut`, helper de comando)
- Create: `python-services/tests/test_cut.py`
- Create: `python-services/requirements-dev.txt`

**Interfaces:**
- Produces:
  - `build_ffmpeg_cut_command(source_url, start, end, output_path) -> list[str]`
  - `/cut` acepta `{ source_url, segments, artist_id }`.

- [ ] **Step 1: Instalar pytest en el venv**

Create `python-services/requirements-dev.txt`:
```
pytest
```
Run (desde `python-services`):
```bash
./.venv/Scripts/python.exe -m pip install -r requirements-dev.txt
```
Expected: pytest instalado.

- [ ] **Step 2: Escribir el test que falla**

Create `python-services/tests/test_cut.py`:
```python
from main import build_ffmpeg_cut_command

def test_ffmpeg_cut_command_reads_from_url_with_input_seeking():
    cmd = build_ffmpeg_cut_command("https://cdn/x.mp4", 10, 40, "/tmp/clip.mp4")
    # -ss/-to deben ir ANTES de -i para seeking por rango HTTP eficiente
    assert cmd[:1] == ["ffmpeg"]
    i_ss, i_i = cmd.index("-ss"), cmd.index("-i")
    assert i_ss < i_i
    assert cmd[i_i + 1] == "https://cdn/x.mp4"
    assert "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy"
    assert cmd[-1] == "/tmp/clip.mp4"
```

- [ ] **Step 3: Correr el test para verlo fallar**

Run (desde `python-services`): `./.venv/Scripts/python.exe -m pytest tests/test_cut.py -v`
Expected: FAIL con "cannot import name 'build_ffmpeg_cut_command'".

- [ ] **Step 4: Implementar el helper y ajustar `/cut`**

En `python-services/main.py`:

(a) Añadir el helper cerca del endpoint `/cut`:
```python
def build_ffmpeg_cut_command(source_url, start, end, output_path):
    return [
        "ffmpeg", "-y",
        "-ss", str(start),
        "-to", str(end),
        "-i", source_url,
        "-c", "copy",
        output_path,
    ]
```

(b) Cambiar el modelo `CutRequest`: reemplazar el campo `video_id: str` por `source_url: str` (mantener `segments` y `artist_id`).

(c) En `cut_video`, reemplazar el uso de disco local por un temporal del SO y el nuevo comando. Cambiar la firma a `def` (Starlette lo corre en threadpool). Reemplazar el cuerpo que resuelve `video_path` y arma `command` por:
```python
    import tempfile
    temp_dir = tempfile.mkdtemp(prefix="repurpose_")
    files_to_clean = []
    results = []

    for idx, segment in enumerate(payload.segments):
        output_path = os.path.join(temp_dir, f"clip_{idx}.mp4")
        files_to_clean.append(output_path)
        command = build_ffmpeg_cut_command(payload.source_url, segment.start, segment.end, output_path)
        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            upload_result = cloudinary.uploader.upload(
                output_path, resource_type="video",
                folder=f"vidalis/{payload.artist_id}/clips",
            )
            results.append({
                "title": segment.title, "start": segment.start, "end": segment.end,
                "secure_url": upload_result.get("secure_url"), "duration": upload_result.get("duration"),
            })
        except Exception as e:
            results.append({
                "title": segment.title, "start": segment.start, "end": segment.end,
                "status": "failed", "error": str(e),
            })

    background_tasks.add_task(cleanup_files, files_to_clean)
    background_tasks.add_task(shutil.rmtree, temp_dir, ignore_errors=True)
    return {"clips": results}
```
(Eliminar las referencias a `VIDEOS_DIR`/`video_path`/`temp_job_dir` dentro de `/cut`.)

- [ ] **Step 5: Correr el test para verlo pasar**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_cut.py -v`
Expected: PASS.

- [ ] **Step 6: Verificar que el servicio arranca**

Run (desde `python-services`): `./.venv/Scripts/python.exe -c "import main; print('import OK')"`
Expected: `import OK` (sin errores de referencias a variables eliminadas).

- [ ] **Step 7: Commit**

```bash
git add python-services/main.py python-services/tests/test_cut.py python-services/requirements-dev.txt
git commit -m "feat(repurposer): /cut lee el fuente desde source_url (R2) por rango HTTP"
```

---

## Task 9: Quitar `/upload`, `/static` y storage local del Python

**Files:**
- Modify: `python-services/main.py`

**Interfaces:**
- Produces: el servicio Python ya no expone `/upload` ni `/static`, ni escribe fuentes en disco.

- [ ] **Step 1: Eliminar el endpoint `/upload`**

Borrar la función `@app.post("/upload") async def upload_video(...)` completa (líneas ~329-349).

- [ ] **Step 2: Eliminar el mount `/static` y el storage local de fuentes**

Borrar:
```python
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
```
y la línea `from fastapi.staticfiles import StaticFiles`. Reemplazar el bloque de constantes:
```python
STATIC_DIR = "static"
VIDEOS_DIR = os.path.join(STATIC_DIR, "videos")
os.makedirs(VIDEOS_DIR, exist_ok=True)
```
por (solo lo que aún use el scraper, si algo; si nada lo usa, eliminar por completo). Verificar con búsqueda que `STATIC_DIR`/`VIDEOS_DIR` no se usen en ninguna otra parte antes de borrar.

- [ ] **Step 3: Verificar que arranca y responde /health**

Run (desde `python-services`):
```bash
./.venv/Scripts/python.exe -c "import main; print('import OK')"
```
Expected: `import OK`. Luego arrancar `./.venv/Scripts/python.exe run.py` y `curl http://localhost:8080/health` → `{"status":"ok",...}`.

- [ ] **Step 4: Correr pytest completo**

Run: `./.venv/Scripts/python.exe -m pytest -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add python-services/main.py
git commit -m "refactor(repurposer): quitar /upload y /static del media service (sin disco local)"
```

---

## Task 10: Validación de duración ≤2h con ffprobe (antes de Gemini)

**Files:**
- Modify: `python-services/main.py` (helper `build_ffprobe_duration_command` + endpoint `POST /probe`)
- Modify: `python-services/tests/test_cut.py` (test del helper)
- Modify: `src/services/repurposerService.js` (`generateClips`: probar duración antes de `detectSegments`)
- Modify: `tests/unit/repurposerService.cutPayload.test.js` (mockear `/probe`)

**Interfaces:**
- Produces:
  - Python: `build_ffprobe_duration_command(source_url) -> list[str]`; `POST /probe { source_url } -> { duration_seconds: float }`.
  - Node: `generateClips` marca el padre `failed` (step `probe`) si `duration_seconds > 7200`, antes de llamar a Gemini.

- [ ] **Step 1: Test del helper ffprobe (Python) que falla**

Añadir a `python-services/tests/test_cut.py`:
```python
from main import build_ffprobe_duration_command

def test_ffprobe_duration_command_targets_the_url():
    cmd = build_ffprobe_duration_command("https://cdn/x.mp4")
    assert cmd[0] == "ffprobe"
    assert cmd[-1] == "https://cdn/x.mp4"
    assert "duration" in " ".join(cmd)
```

- [ ] **Step 2: Correr para verlo fallar**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_cut.py -k ffprobe -v`
Expected: FAIL con "cannot import name 'build_ffprobe_duration_command'".

- [ ] **Step 3: Implementar helper + endpoint `/probe` en Python**

En `python-services/main.py`:
```python
def build_ffprobe_duration_command(source_url):
    return [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        source_url,
    ]

class ProbeRequest(BaseModel):
    source_url: str

@app.post("/probe")
def probe_video(payload: ProbeRequest):
    try:
        out = subprocess.run(
            build_ffprobe_duration_command(payload.source_url),
            check=True, capture_output=True, text=True,
        )
        return {"duration_seconds": float(out.stdout.strip())}
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"No se pudo leer la duración: {str(e)}")
```
(`BaseModel` ya está importado; reutilizar el import existente de `pydantic`.)

- [ ] **Step 4: Correr para verlo pasar**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_cut.py -v`
Expected: PASS.

- [ ] **Step 5: Test Node que falla — rechazar >2h antes de Gemini**

En `tests/unit/repurposerService.cutPayload.test.js`, añadir este test (usa el mismo `mock`/`axios` del archivo):
```js
test('rechaza el video (failed) si /probe reporta más de 2 horas, sin llamar a Gemini', async () => {
  const aiService = require('../../src/services/aiService');
  mock.queueResult({ data: { id: 'p1', artist_id: 'a1', title: 'T', source_url: 'https://cdn/x.mp4', platforms: ['tiktok'] }, error: null }); // parent
  mock.queueResult({ data: { id: 'a1', name: 'J', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: ['tiktok'] }, error: null }); // artist
  mock.queueResult({ error: null }); // delete hijos
  axios.post.mockResolvedValueOnce({ data: { duration_seconds: 8000 } }); // /probe
  mock.queueResult({ error: null }); // update failed

  await generateClips('p1');

  expect(axios.post).toHaveBeenCalledWith('http://python:8080/probe', { source_url: 'https://cdn/x.mp4' });
  expect(aiService.detectSegments).not.toHaveBeenCalled();
});
```
Y en el test existente `llama a /cut con source_url...`, añadir el mock de `/probe` **antes** del resultado de `/cut` (el `axios.post` se llama primero para probe, luego para cut):
```js
  axios.post
    .mockResolvedValueOnce({ data: { duration_seconds: 120 } }) // /probe
    .mockResolvedValueOnce({ data: { clips: [] } });            // /cut
```
(reemplaza el `mockResolvedValue({ data: { clips: [] } })` global del `jest.mock('axios', ...)` para ese caso.)

- [ ] **Step 6: Correr para verlo fallar**

Run: `npm test -- cutPayload`
Expected: FAIL — hoy `generateClips` no llama a `/probe`.

- [ ] **Step 7: Implementar el probe en `generateClips`**

En `src/services/repurposerService.js`, dentro de `generateClips`, **después** del borrado idempotente y **antes** de `let segments;` / `detectSegments`:
```js
  // Guard de duración: probar ≤2h antes de gastar Gemini (solo en modo Python).
  const probeUrl = process.env.CLIPPER_SERVICE_URL;
  if (probeUrl) {
    try {
      const probe = await axios.post(`${probeUrl.replace(/\/+$/, '')}/probe`, { source_url: parent.source_url });
      const dur = probe.data?.duration_seconds;
      if (dur && dur > 7200) {
        await supabase.from('videos').update({
          status: 'failed',
          error_log: JSON.stringify({ step: 'probe', message: `El video dura más de 2 horas (${Math.round(dur / 60)} min)` }),
        }).eq('id', parentVideoId);
        return;
      }
    } catch (err) {
      console.error(`⚠️ [Repurposer] /probe falló para ${parentVideoId}, se continúa:`, err.message);
    }
  }
```
(Nota: los tests de `generateClips` de la Task 5 no fijan `CLIPPER_SERVICE_URL`, así que este bloque se salta y no requiere cambios ahí.)

- [ ] **Step 8: Correr las suites afectadas**

Run: `npm test -- cutPayload generateClips`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add python-services/main.py python-services/tests/test_cut.py src/services/repurposerService.js tests/unit/repurposerService.cutPayload.test.js
git commit -m "feat(repurposer): validar duración ≤2h con ffprobe antes de Gemini"
```

---

# MILESTONE 4 — Frontend: subida directa

## Task 11: `RepurposerView` con presign → PUT directo → registrar

**Files:**
- Modify: `d:\Github\marketingDigitalFrontend\src\components\RepurposerView.jsx` (bloque de subida, líneas ~88-147)

**Interfaces:**
- Consumes: `POST /api/vidalis/repurpose/presign`, `PUT` directo a R2, `POST /api/vidalis/repurpose/upload`.

- [ ] **Step 1: Reemplazar el bloque de subida**

En `RepurposerView.jsx`, dentro del handler de subida, reemplazar el bloque que llama a `${clipperUrl}/upload` y arma `backendUrl` (líneas ~93-144) por:
```jsx
      // 1. Pedir URL prefirmada al backend
      const presignRes = await fetch(`${API}/api/vidalis/repurpose/presign`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ artistId, filename: file.name, contentType: file.type || 'video/mp4' }),
      });
      const presign = await presignRes.json();
      if (!presignRes.ok) throw new Error(presign.error || 'No se pudo iniciar la subida');

      // 2. PUT directo a R2 con progreso real
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', presign.uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
          ? resolve()
          : reject(new Error('Falló la subida del archivo a R2'));
        xhr.onerror = () => reject(new Error('Error de red al subir el archivo'));
        xhr.send(file);
      });

      // 3. Registrar el video con la URL pública de R2
      setUploadPhase('registering');
      const res = await fetch(`${API}/api/vidalis/repurpose/upload`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ artistId, sourceUrl: presign.sourceUrl, title: title || file.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error registrando el video');
```

- [ ] **Step 2: Verificación manual end-to-end**

Con RabbitMQ, el worker (`npm run worker`), el API (`npm run dev`) y el media service Python corriendo, y `VITE_API_URL` apuntando al API:
1. Subir un video corto en el Repurposer.
2. Verificar en la consola de red: `POST /repurpose/presign` (200), `PUT` a R2 (200, con barra de progreso), `POST /repurpose/upload` (201).
3. La galería pasa de `processing`/`queued` a `ready` con clips.

Expected: el archivo aparece en el bucket R2 (`repurposer/sources/{artistId}/...`), los clips en Cloudinary, y ninguna llamada al viejo `${clipperUrl}/upload`.

- [ ] **Step 3: Commit (repo frontend)**

```bash
git add src/components/RepurposerView.jsx
git commit -m "feat(repurposer): subida directa a R2 con URL prefirmada"
```

---

## Cierre: variables de entorno y despliegue

- [ ] **Documentar envs nuevas** en `.env.example` del backend:
```
# RabbitMQ (Repurposer)
RABBITMQ_URL=amqp://user:pass@host:5672
WORKER_PREFETCH=2
```
- [ ] **Railway**: crear el servicio worker (`npm run worker`) y el add-on de RabbitMQ (o CloudAMQP → `RABBITMQ_URL`). Escalar réplicas del worker según profundidad de la cola.
- [ ] Commit del `.env.example`:
```bash
git add .env.example
git commit -m "docs(repurposer): documentar RABBITMQ_URL y WORKER_PREFETCH"
```
