# Repurposer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Vidalis user upload a long video (podcast/entrevista/stream, hasta 2h), detectar automáticamente sus mejores capítulos, generar un clip corto por capítulo, puntuar cada uno, y mostrarle cuál es el mejor — todo dentro de la sección "Repurposer" nueva del dashboard existente de Vidalis.

**Architecture:** Backend nuevo endpoint + servicio de orquestación en `marketingDigitalBackend`, reutilizando la tabla `videos` existente (self-referencing vía `parent_video_id`), la función `generateCopyWithClaude` ya usada para puntuar videos completos, y transformaciones de URL de Cloudinary para "cortar" clips sin FFmpeg. Frontend: una vista nueva (`RepurposerView.jsx`) agregada al sidebar existente de `marketingDigitalFrontend`, sin tocar las vistas actuales.

**Tech Stack:** Node/Express, Supabase (Postgres), Google Gemini (`@google/generative-ai`), Anthropic Claude (`@anthropic-ai/sdk`), Cloudinary, React (Vite), Jest (backend only — el frontend no tiene test runner configurado).

**Spec de referencia:** `docs/superpowers/specs/2026-07-06-repurposer-design.md`

## Global Constraints

- No se agrega ninguna columna ni tabla nueva — se reutilizan `parent_video_id`, `ai_clips_data`, `viral_score_real`, `status`, `error_log`, todas ya existentes en `videos`.
- `viral_score_real` es `DECIMAL(4,1)` en escala **1-10**, nunca 0-100 (`migration_analytics_tracking.sql:27`). Cualquier UI nueva debe formatear como `"8.7"`, no `"87"`.
- Duración máxima de video soportada: **7200 segundos (2 horas)**. Se valida antes de crear el registro.
- No se instala ni se invoca FFmpeg. Los clips se generan solo con transformaciones de URL de Cloudinary (`so_/eo_`).
- Repurposer vive dentro de Vidalis (mismo repo backend, mismo repo frontend `marketingDigitalFrontend`, mismo login/tema). No se crea dominio ni proyecto nuevo.
- El puntaje de cada clip se calcula con `generateCopyWithClaude` (basado en transcripción/análisis de contenido), **no** con `scoreVisualVirality`/`/visual-score` (que solo analiza un frame estático).
- El frontend (`marketingDigitalFrontend`) no tiene Jest/Vitest configurado — la verificación de esas tareas es `npm run lint` + `npm run build` + una prueba manual con `npm run dev`, no tests automatizados.
- Backend: seguir el patrón de mocks ya usado en `tests/unit/aiService.promptOrder.test.js` y `tests/helpers/supabaseMock.js` para cualquier test nuevo.

---

## Task 1: `buildClipUrl` — recorte de Cloudinary sin FFmpeg

**Files:**
- Create: `src/services/repurposerService.js`
- Test: `tests/unit/repurposerService.buildClipUrl.test.js`

**Interfaces:**
- Produces: `buildClipUrl(sourceUrl: string, startSeconds: number, endSeconds: number): string` — lanza `Error` si `sourceUrl` no es una URL de Cloudinary válida.

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/repurposerService.buildClipUrl.test.js
const { buildClipUrl } = require('../../src/services/repurposerService');

describe('buildClipUrl', () => {
  test('inserta so_/eo_ antes del public ID para una URL de Cloudinary válida', () => {
    const url = 'https://res.cloudinary.com/demo/video/upload/v1700000000/vidalis_uploads/podcast.mp4';
    const result = buildClipUrl(url, 30, 75);
    expect(result).toBe('https://res.cloudinary.com/demo/video/upload/so_30,eo_75/v1700000000/vidalis_uploads/podcast.mp4');
  });

  test('funciona con start en 0', () => {
    const url = 'https://res.cloudinary.com/demo/video/upload/v1700000000/vidalis_uploads/podcast.mp4';
    const result = buildClipUrl(url, 0, 45);
    expect(result).toBe('https://res.cloudinary.com/demo/video/upload/so_0,eo_45/v1700000000/vidalis_uploads/podcast.mp4');
  });

  test('lanza error si la URL no es de Cloudinary', () => {
    expect(() => buildClipUrl('https://example.com/video.mp4', 0, 10)).toThrow('no es de Cloudinary');
  });

  test('lanza error si la URL de Cloudinary no tiene el formato esperado (sin v<numero>/)', () => {
    const url = 'https://res.cloudinary.com/demo/video/upload/podcast.mp4';
    expect(() => buildClipUrl(url, 0, 10)).toThrow('no estándar');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/repurposerService.buildClipUrl.test.js`
Expected: FAIL — `Cannot find module '../../src/services/repurposerService'`

- [ ] **Step 3: Implementación mínima**

```javascript
// src/services/repurposerService.js
function buildClipUrl(sourceUrl, startSeconds, endSeconds) {
  if (!sourceUrl || !sourceUrl.includes('cloudinary.com') || !sourceUrl.includes('/upload/')) {
    throw new Error(`buildClipUrl: la URL no es de Cloudinary: ${sourceUrl}`);
  }

  const cleanUrl = sourceUrl.replace(/\s+/g, '').split('?')[0];
  const regex = /^(https:\/\/res\.cloudinary\.com\/[^\/]+\/(?:video|image)\/upload\/)(?:[^\/]+\/)*(v\d+\/.*)$/;
  const match = cleanUrl.match(regex);

  if (!match) {
    throw new Error(`buildClipUrl: la URL de Cloudinary no es estándar: ${cleanUrl}`);
  }

  const baseUrl = match[1];
  const publicId = match[2];
  const trans = `so_${startSeconds},eo_${endSeconds}`;
  return `${baseUrl}${trans}/${publicId}`;
}

module.exports = { buildClipUrl };
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/repurposerService.buildClipUrl.test.js`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add src/services/repurposerService.js tests/unit/repurposerService.buildClipUrl.test.js
git commit -m "feat(repurposer): add buildClipUrl to trim clips via Cloudinary URL transform"
```

---

## Task 2: `detectSegments` — Gemini detecta capítulos en el video completo

**Files:**
- Modify: `src/services/aiService.js:685-743` (refactor `buildVideoContentParts` para aceptar un prompt custom) y añadir `detectSegments` después de `analyzeWithGemini` (línea 793) + agregarla a `module.exports` (línea 1661-1674)
- Test: `tests/unit/aiService.detectSegments.test.js`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces: `aiService.detectSegments(mediaUrl: string, title?: string): Promise<Array<{start: number, end: number, title: string, reason: string}>>` — usado por Task 3.

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/aiService.detectSegments.test.js
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = 'test-key';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  })),
}));
jest.mock('@google/generative-ai/server', () => ({
  GoogleAIFileManager: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() },
})));
jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({
    data: Buffer.from('fake-video-bytes'),
    headers: { 'content-type': 'video/mp4' },
  }),
}));

const aiService = require('../../src/services/aiService');

afterEach(() => jest.clearAllMocks());

describe('detectSegments', () => {
  test('devuelve los segmentos parseados desde la respuesta de Gemini', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({
        segments: [
          { start: 30, end: 75, title: 'El error del lanzamiento', reason: 'Hook fuerte y anécdota autocontenida' },
          { start: 200, end: 250, title: 'La negociación', reason: 'Tensión y resolución completas' },
        ],
      }) },
    });

    const segments = await aiService.detectSegments(
      'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', 'Mi Podcast'
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      start: 30, end: 75, title: 'El error del lanzamiento', reason: 'Hook fuerte y anécdota autocontenida',
    });
  });

  test('descarta segmentos inválidos (end <= start, o valores no numéricos)', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({
        segments: [
          { start: 50, end: 40, title: 'Inválido', reason: 'x' },
          { start: 'a', end: 90, title: 'No numérico', reason: 'x' },
          { start: 10, end: 55, title: 'Válido', reason: 'ok' },
        ],
      }) },
    });

    const segments = await aiService.detectSegments(
      'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', 'Mi Podcast'
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].title).toBe('Válido');
  });

  test('lanza error si Gemini no devuelve JSON válido', async () => {
    mockGenerateContent.mockResolvedValueOnce({ response: { text: () => 'no soy json' } });

    await expect(
      aiService.detectSegments('https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', 'Mi Podcast')
    ).rejects.toThrow('no devolvió JSON');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/aiService.detectSegments.test.js`
Expected: FAIL — `aiService.detectSegments is not a function`

- [ ] **Step 3: Refactorizar `buildVideoContentParts` para aceptar un prompt custom**

Reemplazar `src/services/aiService.js:685-743` completo por:

```javascript
async function buildVideoContentParts(mediaUrl, title, promptOverride = null) {
  const INLINE_LIMIT = 18 * 1024 * 1024;
  const fullVideoPrompt = promptOverride || VISUAL_ANALYSIS_PROMPT(title, true);
  const framesPrompt = promptOverride || VISUAL_ANALYSIS_PROMPT(title, false);

  try {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'vidalis-ai/1.0' },
    });
    const buffer = Buffer.from(response.data);
    const videoMime = response.headers['content-type']?.split(';')[0] || 'video/mp4';
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);

    // Videos chicos: inline directo (más rápido)
    if (buffer.length <= INLINE_LIMIT) {
      logDebug(`🎬 [Gemini] Video inline: ${sizeMB}MB (${videoMime})`);
      return {
        parts: [
          { inlineData: { data: buffer.toString('base64'), mimeType: videoMime } },
          fullVideoPrompt,
        ],
        mode: 'full_video',
      };
    }

    // Videos grandes: File API (sin límite práctico)
    logDebug(`🎬 [Gemini] Video grande (${sizeMB}MB) — usando File API...`);
    const file = await uploadVideoToGemini(buffer, videoMime);
    return {
      parts: [
        { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
        fullVideoPrompt,
      ],
      mode: 'full_video_fileapi',
    };
  } catch (err) {
    logDebug(`⚠️ [Gemini] Error con video completo (${err.message}) — fallback a frames`);
  }

  // Fallback: 3 frames
  const thumbUrls = extractVideoThumbnails(mediaUrl);
  const frames = await Promise.allSettled(thumbUrls.map(url => fetchAsBase64(url)));
  const validFrames = frames
    .filter(r => r.status === 'fulfilled')
    .map(r => ({ inlineData: { data: r.value.base64, mimeType: r.value.mimeType } }));

  if (validFrames.length === 0) {
    const fb = await fetchAsBase64(extractVideoThumbnail(mediaUrl));
    validFrames.push({ inlineData: { data: fb.base64, mimeType: fb.mimeType } });
  }

  const extra = validFrames.length > 1
    ? `\n\nEstás viendo ${validFrames.length} frames del video: inicio (0s), gancho (3s) y frame representativo. Analizá el video como un todo.`
    : '';
  return {
    parts: [...validFrames, framesPrompt + extra],
    mode: 'frames',
  };
}
```

(Único cambio: se agregó el 3er parámetro `promptOverride` con default `null`, y las 3 ramas de `return` usan `fullVideoPrompt`/`framesPrompt` en vez de llamar a `VISUAL_ANALYSIS_PROMPT` directamente. Los llamados existentes de `analyzeWithGemini` no pasan ese 3er argumento, así que su comportamiento no cambia.)

- [ ] **Step 4: Agregar `detectSegments` después de `analyzeWithGemini` (después de la línea 793)**

```javascript
const SEGMENT_DETECTION_PROMPT = (title) => `Sos un editor experto en encontrar los mejores momentos de videos largos (podcasts, entrevistas, streams) para convertirlos en clips cortos virales.

Mirá y escuchá el video completo${title ? ` titulado "${title}"` : ''} y encontrá entre 3 y 8 capítulos/momentos que funcionen como clips independientes de 15 a 90 segundos cada uno.

Para cada capítulo, evaluá:
- ¿Tiene un gancho fuerte en los primeros segundos?
- ¿Es una idea completa y autocontenida (no depende de contexto previo)?
- ¿Tiene potencial de generar reacción, curiosidad o identificación?

Devolvé SOLO este JSON (sin markdown, sin explicaciones):
{
  "segments": [
    {
      "start": <segundos, número entero>,
      "end": <segundos, número entero, entre 15 y 90 segundos después de start>,
      "title": "<título corto del momento, máx 60 caracteres>",
      "reason": "<1-2 oraciones explicando por qué este momento funciona como clip, qué gancho tiene y qué lo hace autocontenido>"
    }
  ]
}

Ordená los segmentos por potencial viral, de mayor a menor. No inventes momentos que no aparecen en el video — basate solo en lo que realmente ves y escuchás.
Respondé SOLO con el JSON, sin texto adicional.`;

async function detectSegments(mediaUrl, title = '') {
  const built = await buildVideoContentParts(mediaUrl, title, SEGMENT_DETECTION_PROMPT(title));
  const contentParts = built.parts;
  const timeout = built.mode.startsWith('full_video') ? 90000 : 45000;

  const parse = (raw) => {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Gemini no devolvió JSON en detectSegments');
    const parsed = JSON.parse(jsonMatch[0]);
    const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
    return rawSegments
      .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
      .map(s => ({
        start: Math.max(0, Math.round(s.start)),
        end: Math.round(s.end),
        title: (s.title || '').slice(0, 60) || 'Clip sin título',
        reason: s.reason || '',
      }));
  };

  try {
    const model = getGemini().getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await withTimeout(model.generateContent(contentParts), timeout, 'Gemini Segment Detection');
    logDebug(`✅ [Gemini 2.5] Detección de capítulos completada (modo: ${built.mode})`);
    return parse(result.response.text());
  } catch (error) {
    if (!isGeminiUnavailable(error) && !error.message?.includes('Timeout')) throw error;
    logDebug(`⚠️ Gemini 2.5 Flash no disponible en detectSegments (${error.message}). Probando gemini-2.0-flash...`);
    const fallbackModel = getGemini().getGenerativeModel({ model: 'gemini-2.0-flash' });
    const fallbackResult = await withTimeout(fallbackModel.generateContent(contentParts), timeout, 'Gemini Segment Detection (fallback)');
    return parse(fallbackResult.response.text());
  }
}
```

- [ ] **Step 5: Exportar `detectSegments`**

Modificar `src/services/aiService.js:1661-1674`:

```javascript
module.exports = {
  processVideoAI,
  analyzeWithGemini,
  generateCopyWithClaude,
  transcribeWithGroq,
  generateInsights,
  runDeepAuditAnalysis,
  refineCopy,
  analyzeContentStrategy,
  scoreVisualVirality,
  calibrateScore,
  calibrateScore100,
  fetchArtistLearningContext,
  detectSegments,
};
```

- [ ] **Step 6: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/aiService.detectSegments.test.js`
Expected: PASS (3/3)

- [ ] **Step 7: Correr toda la suite de aiService para verificar que el refactor no rompió nada**

Run: `npx jest tests/unit/aiService`
Expected: PASS (todos los archivos `aiService.*.test.js`)

- [ ] **Step 8: Commit**

```bash
git add src/services/aiService.js tests/unit/aiService.detectSegments.test.js
git commit -m "feat(repurposer): add aiService.detectSegments using Gemini full-video understanding"
```

---

## Task 3: `generateClips` — orquestación completa (detectar, cortar, puntuar, guardar)

**Files:**
- Modify: `src/services/repurposerService.js` (agregar sobre lo de Task 1)
- Test: `tests/unit/repurposerService.generateClips.test.js`

**Interfaces:**
- Consumes: `buildClipUrl` (Task 1), `aiService.detectSegments` (Task 2), `aiService.generateCopyWithClaude(geminiAnalysis, transcript, title, platforms, artistContext, learningContext)` (ya existente), `aiService.fetchArtistLearningContext(artistId)` (ya existente).
- Produces: `repurposerService.generateClips(parentVideoId: string): Promise<void>` — usado por Task 5. Efecto secundario: inserta filas hijas en `videos` y actualiza el `status` de la fila padre.

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/repurposerService.generateClips.test.js
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

jest.mock('../../src/services/aiService', () => ({
  detectSegments: jest.fn(),
  generateCopyWithClaude: jest.fn(),
  fetchArtistLearningContext: jest.fn().mockResolvedValue(null),
}));

const aiService = require('../../src/services/aiService');
const { generateClips } = require('../../src/services/repurposerService');

afterEach(() => jest.clearAllMocks());

describe('generateClips', () => {
  test('crea un clip por cada segmento detectado, con score y metadata', async () => {
    mock.queueResult({
      data: { id: 'parent-1', artist_id: 'artist-1', title: 'Podcast largo', source_url: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', platforms: null },
      error: null,
    }); // select parent
    mock.queueResult({
      data: { id: 'artist-1', name: 'Juan', ai_genre: 'tech', ai_audience: null, ai_tone: null, active_platforms: ['tiktok'] },
      error: null,
    }); // select artist

    aiService.detectSegments.mockResolvedValueOnce([
      { start: 10, end: 40, title: 'Momento 1', reason: 'Hook fuerte' },
      { start: 100, end: 150, title: 'Momento 2', reason: 'Anécdota completa' },
    ]);
    aiService.generateCopyWithClaude
      .mockResolvedValueOnce({ viral_score: 8.5, ai_copy_short: 'a', ai_copy_long: 'aa', hashtags: '#a' })
      .mockResolvedValueOnce({ viral_score: 6.1, ai_copy_short: 'b', ai_copy_long: 'bb', hashtags: '#b' });

    mock.queueResult({ error: null }); // insert clip 1
    mock.queueResult({ error: null }); // insert clip 2
    mock.queueResult({ error: null }); // update parent status ready

    await generateClips('parent-1');

    expect(aiService.generateCopyWithClaude).toHaveBeenCalledTimes(2);
    expect(aiService.generateCopyWithClaude.mock.calls[0]).toEqual([
      'Hook fuerte', null, 'Momento 1', ['tiktok'],
      { nombre: 'Juan', genero: 'tech', audiencia: null, tono: null },
      null,
    ]);
  });

  test('si un segmento falla al puntuar, se omite y se sigue con los demás', async () => {
    mock.queueResult({
      data: { id: 'parent-1', artist_id: 'artist-1', title: 'Podcast', source_url: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', platforms: null },
      error: null,
    });
    mock.queueResult({
      data: { id: 'artist-1', name: 'Juan', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: [] },
      error: null,
    });

    aiService.detectSegments.mockResolvedValueOnce([
      { start: 10, end: 40, title: 'Falla', reason: 'x' },
      { start: 100, end: 150, title: 'OK', reason: 'y' },
    ]);
    aiService.generateCopyWithClaude
      .mockRejectedValueOnce(new Error('Claude timeout'))
      .mockResolvedValueOnce({ viral_score: 7, ai_copy_short: 'b', ai_copy_long: 'bb', hashtags: '#b' });

    mock.queueResult({ error: null }); // insert del único clip que sí funcionó
    mock.queueResult({ error: null }); // update parent status ready

    await expect(generateClips('parent-1')).resolves.toBeUndefined();
  });

  test('si detectSegments no encuentra ningún capítulo, marca el video como failed', async () => {
    mock.queueResult({
      data: { id: 'parent-1', artist_id: 'artist-1', title: 'Podcast', source_url: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4', platforms: null },
      error: null,
    });
    mock.queueResult({
      data: { id: 'artist-1', name: 'Juan', ai_genre: null, ai_audience: null, ai_tone: null, active_platforms: [] },
      error: null,
    });
    aiService.detectSegments.mockResolvedValueOnce([]);
    mock.queueResult({ error: null }); // update status failed

    await expect(generateClips('parent-1')).resolves.toBeUndefined();
    expect(aiService.generateCopyWithClaude).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/repurposerService.generateClips.test.js`
Expected: FAIL — `generateClips is not a function` (o `undefined`)

- [ ] **Step 3: Implementación**

Agregar al final de `src/services/repurposerService.js` (y agregar los requires al principio del archivo):

```javascript
const { createClient } = require('@supabase/supabase-js');
const aiService = require('./aiService');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

// ... (buildClipUrl de Task 1 va acá, antes de generateClips) ...

async function generateClips(parentVideoId) {
  const { data: parent, error: parentErr } = await supabase
    .from('videos')
    .select('id, artist_id, title, source_url, platforms')
    .eq('id', parentVideoId)
    .single();
  if (parentErr || !parent) throw new Error(`Video padre no encontrado: ${parentVideoId}`);

  const { data: artist } = await supabase
    .from('artists')
    .select('id, name, ai_genre, ai_audience, ai_tone, active_platforms')
    .eq('id', parent.artist_id)
    .single();

  const artistContext = artist && (artist.ai_genre || artist.ai_audience || artist.ai_tone) ? {
    nombre: artist.name,
    genero: artist.ai_genre || null,
    audiencia: artist.ai_audience || null,
    tono: artist.ai_tone || null,
  } : null;

  const targetPlatforms = parent.platforms?.length ? parent.platforms
    : (artist?.active_platforms?.length ? artist.active_platforms : ['tiktok', 'instagram', 'youtube']);

  const learningContext = await aiService.fetchArtistLearningContext(parent.artist_id);

  let segments;
  try {
    segments = await aiService.detectSegments(parent.source_url, parent.title);
  } catch (err) {
    await supabase.from('videos').update({
      status: 'failed',
      error_log: JSON.stringify({ step: 'detectSegments', message: err.message }),
    }).eq('id', parentVideoId);
    return;
  }

  if (!segments.length) {
    await supabase.from('videos').update({
      status: 'failed',
      error_log: JSON.stringify({ step: 'detectSegments', message: 'No se detectaron capítulos en el video' }),
    }).eq('id', parentVideoId);
    return;
  }

  let clipsCreated = 0;
  for (const segment of segments) {
    try {
      const clipUrl = buildClipUrl(parent.source_url, segment.start, segment.end);
      const copy = await aiService.generateCopyWithClaude(
        segment.reason, null, segment.title, targetPlatforms, artistContext, learningContext
      );

      const { error: insertErr } = await supabase.from('videos').insert([{
        parent_video_id: parentVideoId,
        artist_id: parent.artist_id,
        title: segment.title,
        source_url: clipUrl,
        status: 'ready',
        viral_score_real: copy.viral_score,
        ai_clips_data: {
          start: segment.start,
          end: segment.end,
          reason: segment.reason,
          ai_copy_short: copy.ai_copy_short,
          ai_copy_long: copy.ai_copy_long,
          hashtags: copy.hashtags,
        },
      }]);
      if (insertErr) throw insertErr;
      clipsCreated++;
    } catch (err) {
      console.error(`⚠️ [Repurposer] Segmento omitido (${segment.title}):`, err.message);
    }
  }

  await supabase.from('videos').update({
    status: clipsCreated > 0 ? 'ready' : 'failed',
    error_log: clipsCreated > 0 ? null : JSON.stringify({ step: 'generateClips', message: 'Ningún clip se generó correctamente' }),
  }).eq('id', parentVideoId);
}

module.exports = { buildClipUrl, generateClips };
```

(Nota: el `module.exports` reemplaza al de Task 1 — es el mismo objeto, ahora con `generateClips` agregado.)

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/repurposerService.generateClips.test.js`
Expected: PASS (3/3)

- [ ] **Step 5: Correr también el test de Task 1 para verificar que nada se rompió**

Run: `npx jest tests/unit/repurposerService`
Expected: PASS (todos los archivos `repurposerService.*.test.js`)

- [ ] **Step 6: Commit**

```bash
git add src/services/repurposerService.js tests/unit/repurposerService.generateClips.test.js
git commit -m "feat(repurposer): add generateClips orchestration (detect, cut, score, save)"
```

---

## Task 4: Ranking — `getClipsByParent` ordena por score y marca el mejor

**Files:**
- Modify: `src/services/vidalisService.js:1549-1557`
- Test: `tests/unit/vidalisService.getClipsByParent.test.js`

**Interfaces:**
- Produces: `vidalisService.getClipsByParent(parentId: string): Promise<Array<Video & {isBest: boolean}>>` ordenado por `viral_score_real` descendente, usado por `GET /vidalis/clips/:parentId` (ya conectado, sin cambios en el controller ni la ruta).

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/vidalisService.getClipsByParent.test.js
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const vidalisService = require('../../src/services/vidalisService');

afterEach(() => jest.clearAllMocks());

describe('getClipsByParent', () => {
  test('ordena los clips por viral_score_real descendente y marca el primero con isBest', async () => {
    mock.queueResult({
      data: [
        { id: 'a', viral_score_real: 6.2, created_at: '2026-01-01' },
        { id: 'b', viral_score_real: 9.1, created_at: '2026-01-02' },
        { id: 'c', viral_score_real: 7.8, created_at: '2026-01-03' },
      ],
      error: null,
    });

    const clips = await vidalisService.getClipsByParent('parent-1');

    expect(clips.map(c => c.id)).toEqual(['b', 'c', 'a']);
    expect(clips[0].isBest).toBe(true);
    expect(clips[1].isBest).toBe(false);
    expect(clips[2].isBest).toBe(false);
  });

  test('trata viral_score_real null como 0 al ordenar', async () => {
    mock.queueResult({
      data: [
        { id: 'a', viral_score_real: null, created_at: '2026-01-01' },
        { id: 'b', viral_score_real: 3.5, created_at: '2026-01-02' },
      ],
      error: null,
    });

    const clips = await vidalisService.getClipsByParent('parent-1');

    expect(clips.map(c => c.id)).toEqual(['b', 'a']);
    expect(clips[0].isBest).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/vidalisService.getClipsByParent.test.js`
Expected: FAIL — el orden devuelto es el de inserción (por `created_at`), no por score; `clips[0].isBest` es `undefined`

- [ ] **Step 3: Implementación**

Reemplazar `src/services/vidalisService.js:1549-1557`:

```javascript
exports.getClipsByParent = async (parentId) => {
  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .eq('parent_video_id', parentId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const sorted = [...data].sort((a, b) => (b.viral_score_real || 0) - (a.viral_score_real || 0));
  return sorted.map((clip, index) => ({ ...clip, isBest: index === 0 }));
};
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/vidalisService.getClipsByParent.test.js`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add src/services/vidalisService.js tests/unit/vidalisService.getClipsByParent.test.js
git commit -m "feat(repurposer): sort clips by score and flag the best one"
```

---

## Task 5: Endpoint `POST /vidalis/repurpose/upload`

**Files:**
- Modify: `src/services/repurposerService.js` (agregar `createRepurposeVideo`)
- Modify: `src/controllers/vidalisController.js` (agregar `createRepurposeVideo`, después de `exports.processVideo` en la línea 283)
- Modify: `src/routes/vidalisRoutes.js:44` (agregar la ruta nueva justo después de la línea de `/videos/from-url`)
- Test: `tests/unit/repurposerService.createRepurposeVideo.test.js`

**Interfaces:**
- Consumes: `generateClips` (Task 3, invocada de forma fire-and-forget vía `module.exports.generateClips` para que sea espiable en tests).
- Produces: `repurposerService.createRepurposeVideo({artistId, sourceUrl, title, durationSeconds}): Promise<Video>` — usado por el controller.

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/unit/repurposerService.createRepurposeVideo.test.js
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));
jest.mock('../../src/services/aiService', () => ({
  detectSegments: jest.fn(), generateCopyWithClaude: jest.fn(), fetchArtistLearningContext: jest.fn(),
}));

const repurposerService = require('../../src/services/repurposerService');

afterEach(() => jest.clearAllMocks());

describe('createRepurposeVideo', () => {
  test('crea la fila padre con status processing y dispara generateClips', async () => {
    jest.spyOn(repurposerService, 'generateClips').mockResolvedValue();

    mock.queueResult({ data: { id: 'artist-1' }, error: null }); // select artist
    mock.queueResult({ data: [{ id: 'video-1', artist_id: 'artist-1', status: 'processing' }], error: null }); // insert video

    const video = await repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4',
      title: 'Mi podcast',
      durationSeconds: 3600,
    });

    expect(video.status).toBe('processing');
    expect(repurposerService.generateClips).toHaveBeenCalledWith('video-1');
  });

  test('rechaza videos de más de 2 horas antes de tocar la base de datos', async () => {
    await expect(repurposerService.createRepurposeVideo({
      artistId: 'artist-1',
      sourceUrl: 'https://res.cloudinary.com/demo/video/upload/v1/podcast.mp4',
      durationSeconds: 8000,
    })).rejects.toThrow('más de 2 horas');
  });

  test('rechaza si falta artistId o sourceUrl', async () => {
    await expect(repurposerService.createRepurposeVideo({ sourceUrl: 'x' })).rejects.toThrow('requeridos');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/repurposerService.createRepurposeVideo.test.js`
Expected: FAIL — `createRepurposeVideo is not a function`

- [ ] **Step 3: Implementación — `repurposerService.js`**

Agregar (y actualizar el `module.exports` final):

```javascript
const MAX_DURATION_SECONDS = 7200; // 2 horas

async function createRepurposeVideo({ artistId, sourceUrl, title, durationSeconds }) {
  if (!artistId || !sourceUrl) {
    throw new Error('artistId y sourceUrl son requeridos');
  }
  if (durationSeconds && durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error(`El video dura más de 2 horas (${Math.round(durationSeconds / 60)} min) — no soportado todavía`);
  }

  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('id')
    .eq('id', artistId)
    .single();
  if (artistErr || !artist) throw new Error(`Artista no encontrado: ${artistId}`);

  const cleanSourceUrl = sourceUrl.replace(/\s+/g, '');

  const { data, error } = await supabase
    .from('videos')
    .insert([{
      artist_id: artistId,
      title: title || 'Video sin título',
      source_url: cleanSourceUrl,
      status: 'processing',
    }])
    .select();
  if (error) throw error;

  const video = data[0];

  module.exports.generateClips(video.id).catch(err => {
    console.error(`❌ [Repurposer] Error generando clips para ${video.id}:`, err.message);
  });

  return video;
}

module.exports = { buildClipUrl, generateClips, createRepurposeVideo, MAX_DURATION_SECONDS };
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/repurposerService.createRepurposeVideo.test.js`
Expected: PASS (3/3)

- [ ] **Step 5: Controller — `vidalisController.js`**

Agregar después de `exports.processVideo` (línea 283):

```javascript
exports.createRepurposeVideo = async (req, res) => {
  try {
    const { artistId, sourceUrl, title, durationSeconds } = req.body;
    const repurposerService = require('../services/repurposerService');
    const video = await repurposerService.createRepurposeVideo({ artistId, sourceUrl, title, durationSeconds });
    res.status(201).json(video);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
```

- [ ] **Step 6: Ruta — `vidalisRoutes.js`**

Agregar justo después de la línea 44 (`router.post('/videos/from-url', authenticateToken, vidalisController.uploadFromUrl);`):

```javascript
router.post('/repurpose/upload', authenticateToken, authorizeArtist, vidalisController.createRepurposeVideo);
```

- [ ] **Step 7: Verificar que el servidor levanta sin errores**

Run: `node -e "require('./src/routes/vidalisRoutes.js'); console.log('OK')"`
Expected: `OK` (sin excepciones de require)

- [ ] **Step 8: Correr toda la suite de tests del backend**

Run: `npx jest`
Expected: PASS — todos los tests existentes + los nuevos de este plan

- [ ] **Step 9: Commit**

```bash
git add src/services/repurposerService.js src/controllers/vidalisController.js src/routes/vidalisRoutes.js tests/unit/repurposerService.createRepurposeVideo.test.js
git commit -m "feat(repurposer): add POST /vidalis/repurpose/upload endpoint"
```

---

## Task 6: `RepurposerView.jsx` — upload, progreso y galería

**Files:**
- Create: `d:\Github\marketingDigitalFrontend\src\components\RepurposerView.jsx`

**Interfaces:**
- Consumes (backend, ya construido en Tasks 1-5): `GET /api/vidalis/cloudinary-signature?resourceType=video`, `POST /api/vidalis/repurpose/upload`, `GET /api/vidalis/video/:videoId` (ya existente, para poll de `status`), `GET /api/vidalis/clips/:parentId` (ya existente, ahora devuelve `isBest`).
- Produces: `<RepurposerView artistId={string} />` — usado por Task 7.

**Nota:** este repo (`marketingDigitalFrontend`) no tiene Jest/Vitest configurado (`package.json` solo define `dev`/`build`/`lint`/`preview`). La verificación de este task es `npm run build` (catches errores de sintaxis/JSX) + una prueba manual con `npm run dev`, no un test automatizado.

- [ ] **Step 1: Crear el componente completo**

```jsx
// src/components/RepurposerView.jsx
import { useState, useEffect, useRef } from 'react';
import { Upload, Loader2, AlertCircle, Sparkles } from 'lucide-react';

const API = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const getToken = () => { try { return JSON.parse(localStorage.getItem('vidalis_user') || '{}').token || ''; } catch { return ''; } };
const headers = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` });

const MAX_DURATION_SECONDS = 7200; // 2 horas

const PROCESSING_STEPS = [
  'Analizando el video',
  'Detectando los mejores capítulos',
  'Generando clips',
  'Calculando el score de cada clip',
];

const ScoreBadge = ({ score }) => {
  const s = score || 0;
  const color = s >= 8 ? '#10B981' : s >= 5 ? '#F59E0B' : '#71717A';
  return (
    <span style={{ background: color, color: '#0A0A0B', fontWeight: 800, fontSize: '12px', padding: '2px 8px', borderRadius: '100px' }}>
      {s.toFixed(1)}
    </span>
  );
};

const RepurposerView = ({ artistId }) => {
  const [phase, setPhase] = useState('upload'); // upload | processing | gallery
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [uploadPhase, setUploadPhase] = useState('');
  const [error, setError] = useState('');
  const [clips, setClips] = useState([]);
  const pollRef = useRef(null);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const handleFileChange = (f) => {
    if (!f) return;
    if (!f.type.startsWith('video/')) {
      setError('Solo se aceptan archivos de video');
      return;
    }
    setError('');
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };

  const fetchClips = async (id) => {
    try {
      const res = await fetch(`${API}/api/vidalis/clips/${id}`, { headers: headers() });
      const data = await res.json();
      setClips(Array.isArray(data) ? data : []);
      setPhase('gallery');
    } catch (err) {
      setError('Error cargando los clips generados');
    }
  };

  const startPolling = (id) => {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API}/api/vidalis/video/${id}`, { headers: headers() });
        const video = await res.json();
        if (video.status === 'ready') {
          clearInterval(pollRef.current);
          await fetchClips(id);
        } else if (video.status === 'failed') {
          clearInterval(pollRef.current);
          let message = 'No se pudieron generar los clips';
          try { message = JSON.parse(video.error_log)?.message || message; } catch { /* error_log no es JSON */ }
          setError(message);
          setPhase('upload');
        }
      } catch (err) {
        console.error('Error consultando estado del video:', err);
      }
    }, 4000);
  };

  const handleUpload = async () => {
    if (!file) return;
    setError('');
    try {
      setUploadPhase('signing');
      const sigRes = await fetch(`${API}/api/vidalis/cloudinary-signature?resourceType=video`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const sig = await sigRes.json();

      setUploadPhase('uploading');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('api_key', sig.apiKey);
      fd.append('timestamp', sig.timestamp);
      fd.append('signature', sig.signature);
      fd.append('folder', sig.folder);
      fd.append('access_mode', 'public');
      fd.append('resource_type', 'video');
      if (sig.eager) fd.append('eager', sig.eager);

      const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/video/upload`, {
        method: 'POST', body: fd,
      });
      const uploaded = await uploadRes.json();
      if (!uploadRes.ok) throw new Error('Error subiendo el video a Cloudinary');

      if (uploaded.duration && uploaded.duration > MAX_DURATION_SECONDS) {
        throw new Error(`El video dura ${Math.round(uploaded.duration / 60)} minutos — el máximo soportado es 2 horas`);
      }

      setUploadPhase('registering');
      const res = await fetch(`${API}/api/vidalis/repurpose/upload`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          artistId,
          sourceUrl: uploaded.secure_url,
          title: title || file.name,
          durationSeconds: uploaded.duration || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error registrando el video');

      setPhase('processing');
      setUploadPhase('');
      startPolling(data.id);
    } catch (err) {
      setError(err.message);
      setUploadPhase('');
    }
  };

  const reset = () => {
    setPhase('upload'); setFile(null); setTitle(''); setClips([]); setError('');
  };

  if (phase === 'processing') {
    return (
      <div className="card-pro" style={{ minHeight: '260px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 size={40} className="animate-spin" style={{ color: '#7C3AED', marginBottom: '16px' }} />
        <div style={{ color: '#FFFFFF', fontWeight: 700, marginBottom: '16px' }}>Analizando tu video...</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: '#B8B8C0' }}>
          {PROCESSING_STEPS.map(step => <div key={step}>🔵 {step}</div>)}
        </div>
      </div>
    );
  }

  if (phase === 'gallery') {
    const best = clips.find(c => c.isBest);
    const rest = clips.filter(c => !c.isBest);
    return (
      <div>
        {best && (
          <div style={{ border: '2px solid #7C3AED', borderRadius: '14px', padding: '14px', marginBottom: '20px', background: '#1C1C1F', position: 'relative' }}>
            <div style={{ position: 'absolute', top: '-11px', left: '16px', background: 'linear-gradient(135deg,#4F46E5,#7C3AED)', color: '#fff', fontSize: '11px', fontWeight: 800, padding: '3px 10px', borderRadius: '100px' }}>
              ⭐ MEJOR CLIP
            </div>
            <div style={{ marginTop: '6px' }}>
              <div style={{ color: '#fff', fontWeight: 700, fontSize: '14px', marginBottom: '4px' }}>{best.title}</div>
              <ScoreBadge score={best.viral_score_real} />
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
          {rest.map(clip => (
            <div key={clip.id} style={{ background: '#121214', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '12px', padding: '12px' }}>
              <div style={{ color: '#fff', fontSize: '12px', marginBottom: '6px' }}>{clip.title}</div>
              <ScoreBadge score={clip.viral_score_real} />
            </div>
          ))}
        </div>
        <button onClick={reset} className="btn-secondary" style={{ marginTop: '20px' }}>Subir otro video</button>
      </div>
    );
  }

  return (
    <div className="card-pro" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px' }}>
      <div style={{ color: '#fff', fontSize: '20px', fontWeight: 800, marginBottom: '6px' }}>Convierte un video largo en clips virales</div>
      <div style={{ color: '#B8B8C0', fontSize: '13px', marginBottom: '24px' }}>Sube tu podcast, entrevista o stream — la IA encuentra los mejores momentos</div>

      {error && (
        <div style={{ color: '#EF4444', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      <label className="file-drop" style={{ cursor: 'pointer', width: '100%', maxWidth: '480px' }}>
        <Upload size={32} />
        <div style={{ color: '#fff', fontWeight: 600, marginTop: '8px' }}>
          {file ? file.name : 'Arrastra tu video aquí o haz clic'}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>MP4, MOV, WebM — máx 2 horas</div>
        <input type="file" accept="video/*" style={{ display: 'none' }} onChange={(e) => handleFileChange(e.target.files?.[0])} />
      </label>

      <button
        onClick={handleUpload}
        disabled={!file || !!uploadPhase}
        style={{ marginTop: '20px', background: 'linear-gradient(135deg,#4F46E5,#7C3AED)', color: '#fff', border: 'none', padding: '12px 24px', borderRadius: '10px', fontWeight: 700, opacity: (!file || uploadPhase) ? 0.5 : 1 }}
      >
        {uploadPhase === 'signing' && 'Preparando subida...'}
        {uploadPhase === 'uploading' && 'Subiendo video...'}
        {uploadPhase === 'registering' && 'Iniciando análisis...'}
        {!uploadPhase && <><Sparkles size={16} style={{ marginRight: '6px' }} />Generar clips</>}
      </button>
    </div>
  );
};

export default RepurposerView;
```

- [ ] **Step 2: Verificar que el proyecto compila**

Run: `npm run build` (dentro de `marketingDigitalFrontend`)
Expected: build exitoso, sin errores de sintaxis/JSX en `RepurposerView.jsx`

- [ ] **Step 3: Commit**

```bash
git add src/components/RepurposerView.jsx
git commit -m "feat(repurposer): add RepurposerView with upload, processing and clip gallery states"
```

---

## Task 7: Wiring en `Dashboard.jsx`

**Files:**
- Modify: `d:\Github\marketingDigitalFrontend\src\pages\Dashboard.jsx`

**Interfaces:**
- Consumes: `RepurposerView` (Task 6).

- [ ] **Step 1: Agregar el import del componente y del ícono**

En la línea 20 (después de `import GrowthToolsView from '../components/GrowthToolsView';`), agregar:

```javascript
import RepurposerView from '../components/RepurposerView';
```

En la línea 22, agregar `Film` a la lista de íconos importados de `lucide-react`:

```javascript
import { LogOut, Sparkles, BarChart3, Calendar, Loader2, Share2, Zap, MessageCircle, Settings as SettingsIcon, Lightbulb, TrendingUp, Handshake, FileText, Bell, MoreHorizontal, Search, FlaskConical, Film } from 'lucide-react';
```

- [ ] **Step 2: Agregar el botón al sidebar**

Después del botón de "Content Copilot" (línea 261-263), agregar:

```jsx
<button className={activeView === 'repurposer' ? 'active' : ''} onClick={() => setActiveView('repurposer')}>
  <Film size={20} /> <span style={{ fontWeight: '600' }}>Repurposer</span>
</button>
```

- [ ] **Step 3: Agregar el título de la vista**

Después de la línea `{activeView === 'content' && 'AI Content Copilot'}` (línea 313), agregar:

```jsx
{activeView === 'repurposer' && 'Repurposer'}
```

- [ ] **Step 4: Renderizar el componente**

Después del bloque de `{activeView === 'growthtools' && currentArtistId && (...)}` (línea 423-425), agregar:

```jsx
{activeView === 'repurposer' && currentArtistId && (
  <RepurposerView artistId={currentArtistId} />
)}
```

- [ ] **Step 5: Verificar que el proyecto compila**

Run: `npm run build`
Expected: build exitoso

- [ ] **Step 6: Prueba manual**

Run: `npm run dev`, iniciar sesión, verificar:
1. Aparece "Repurposer" en el sidebar con el ícono de film.
2. Al hacer clic, se muestra la pantalla de upload (drop zone).
3. (Si hay un artista con `artistId` válido y backend corriendo) subir un video corto de prueba y verificar que pasa a "Analizando tu video..." y eventualmente a la galería de clips.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Dashboard.jsx
git commit -m "feat(repurposer): wire RepurposerView into the Vidalis dashboard sidebar"
```

---

## Self-Review

**1. Cobertura del spec:** Cada sección de `docs/superpowers/specs/2026-07-06-repurposer-design.md` tiene tarea: 3.1/3.4 endpoint+ranking → Tasks 4-5; 3.2 detección → Task 2; 3.3 orquestación/scoring → Task 3; 4.1-4.3 frontend → Tasks 6-7. Sección 5 (manejo de errores) está cubierta en Task 3 (segmento omitido, status failed) y Task 6 (mensaje de error en UI). Sección 6 (testing) cubierta task por task.

**2. Placeholders:** ninguno — cada step tiene código completo, comandos exactos y salida esperada.

**3. Consistencia de tipos:** `buildClipUrl(sourceUrl, start, end)` (Task 1) se llama igual en Task 3. `detectSegments(mediaUrl, title)` (Task 2) devuelve `{start,end,title,reason}[]`, consumido tal cual en Task 3. `generateClips(parentVideoId)` (Task 3) es invocado como `module.exports.generateClips(video.id)` en Task 5 (mismo nombre, mismo shape). `getClipsByParent` (Task 4) agrega `isBest`, consumido en `RepurposerView.jsx` (Task 6) como `clip.isBest`. `viral_score_real` tratado como escala 1-10 de forma consistente en Task 4 (umbral de sort) y Task 6 (`ScoreBadge`, umbrales ≥8/≥5).
