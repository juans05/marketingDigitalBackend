# Clip Impact Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score each repurposer clip against a specific social platform using a dedicated 7-criteria rubric (hook, retention, emotional impact, clarity, value, CTA, editing), independent of the existing marketing-framework scoring — with the ability to re-score a clip for a different platform, and publish it directly, without losing prior platform scores.

**Architecture:** A new standalone service (`clipImpactScoringService.js`) calls Claude with the rubric prompt (extended to also generate short/long copy in the same call), upserts one row per `(clip, platform)` into a new `clip_platform_scores` table, and mirrors the current score onto `videos.clip_impact_score` for cheap gallery display. The repurposer orchestrator's existing scoring stage swaps to this service; a new endpoint lets the frontend re-score an already-persisted clip for a different platform on demand.

**Tech Stack:** Node.js/Express, Supabase (Postgres), Anthropic Claude (`@anthropic-ai/sdk` via existing `getAnthropic()`), React (frontend).

## Global Constraints

- Do NOT modify `generateCopyWithClaude`, `calibrateScore`, `calibrateScore100`, or any code path used for normal (non-repurposer) video scoring — this is a fully separate system.
- Do NOT reuse `viral_score`/`viral_score_real` columns for this new score. Use `videos.clip_impact_score` and the new `clip_platform_scores` table (see `sql/clip_impact_score_migration.sql`, already written — must be run manually in the Supabase SQL Editor before Task 3 is testable end-to-end; unit tests mock Supabase and don't require it).
- New route params must be named `videoId` (not `clipId`) — `authorizeVideo` middleware (`src/middleware/authMiddleware.js:76`) only reads `req.params.videoId || req.params.parentId`; any other param name silently skips authorization (`if (!videoId) return next();`).
- Follow existing test patterns: `tests/helpers/supabaseMock.js`'s `createSupabaseMock()` for Supabase-touching tests, `jest.mock('../../src/lib/anthropic', ...)` for Claude calls.
- Existing rubric prompt text (Spanish) must be reproduced verbatim from this plan — it was supplied by the user, do not paraphrase it.

---

## File Structure

**Backend — create:**
- `src/services/clipImpactScoringService.js` — rubric prompt, Claude call, scoring, persistence, rescore
- `tests/unit/clipImpactScoringService.test.js`

**Backend — modify:**
- `src/services/repurposerService.js` — Stage 5 swap; `createRepurposeVideo` accepts `platform`/`niche`
- `tests/unit/repurposerService.generateClipsMultiIA.test.js` — updated mocks for the swapped service
- `src/controllers/vidalisController.js` — `createRepurposeVideo` destructures `platform`/`niche`; new `rescoreClip` export
- `src/routes/vidalisRoutes.js` — new rescore route
- `src/services/vidalisService.js` — `fetchArtistGallery` drops the `parent_video_id IS NULL` filter

**Frontend — modify:**
- `src/components/RepurposerView.jsx` — platform selector + niche toggle on upload form; persistent layout; clip cards with rescore/publish buttons
- `src/components/VideoGallery.jsx` — score badge reads `clip_impact_score` for clip rows

---

### Task 1: Rubric prompt + single-clip scoring call

**Files:**
- Create: `src/services/clipImpactScoringService.js`
- Create: `tests/unit/clipImpactScoringService.test.js`

**Interfaces:**
- Consumes: `getAnthropic()` from `src/lib/anthropic.js`, `extractJsonValue()` from `src/lib/jsonExtract.js`
- Produces:
  - `buildRubricPrompt({ parentVideoId, durationSeconds, platform, niche }): string`
  - `async scoreClipForPlatform(clip: {duration: number}, { platform: string, niche: string, parentVideoId: string }): Promise<{score, score_breakdown, main_strength, main_weakness, improvement_suggestion, viral_likelihood, recommended_platform, hashtags_suggested: string[], copy_short, copy_long}>`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/clipImpactScoringService.test.js
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

jest.mock('../../src/lib/anthropic', () => ({ getAnthropic: jest.fn() }));
const { getAnthropic } = require('../../src/lib/anthropic');

const { scoreClipForPlatform } = require('../../src/services/clipImpactScoringService');

afterEach(() => jest.clearAllMocks());

describe('scoreClipForPlatform', () => {
  it('should call Claude with the rubric prompt and parse the score + copy', async () => {
    const mockResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          parent_video_id: 'video-1',
          platform: 'tiktok',
          score: 8.5,
          score_breakdown: { hook: 2, retention: 1.5, emotional_impact: 2, clarity: 1, value: 1, cta: 0.5, editing: 0.5 },
          main_strength: 'Gancho fuerte',
          main_weakness: 'CTA débil',
          improvement_suggestion: 'Agregar pregunta al final',
          viral_likelihood: 'Alta',
          recommended_platform: 'tiktok',
          hashtags_suggested: ['#viral', '#fyp'],
          copy_short: 'No vas a creer esto 😳',
          copy_long: 'Historia completa: ...',
        }),
      }],
    };
    const createMock = jest.fn().mockResolvedValue(mockResponse);
    getAnthropic.mockReturnValue({ messages: { create: createMock } });

    const result = await scoreClipForPlatform(
      { duration: 45 },
      { platform: 'tiktok', niche: 'true crime', parentVideoId: 'video-1' }
    );

    expect(result.score).toBe(8.5);
    expect(result.score_breakdown).toEqual({ hook: 2, retention: 1.5, emotional_impact: 2, clarity: 1, value: 1, cta: 0.5, editing: 0.5 });
    expect(result.copy_short).toBe('No vas a creer esto 😳');
    expect(result.copy_long).toBe('Historia completa: ...');
    expect(result.hashtags_suggested).toEqual(['#viral', '#fyp']);

    const sentPrompt = createMock.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('EVALUADOR DE IMPACTO DE CLIPS');
    expect(sentPrompt).toContain('Video Padre ID: video-1');
    expect(sentPrompt).toContain('Duración del clip: 45');
    expect(sentPrompt).toContain('Plataforma objetivo: tiktok');
    expect(sentPrompt).toContain('Niche: true crime');
  });

  it('should clamp an out-of-range score to 1-10', async () => {
    getAnthropic.mockReturnValue({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ score: 15, score_breakdown: {}, hashtags_suggested: [] }) }],
        }),
      },
    });

    const result = await scoreClipForPlatform({ duration: 30 }, { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' });
    expect(result.score).toBe(10);
  });

  it('should default to score 5 when Claude returns a non-numeric score', async () => {
    getAnthropic.mockReturnValue({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ score: 'muy alto', score_breakdown: {}, hashtags_suggested: [] }) }],
        }),
      },
    });

    const result = await scoreClipForPlatform({ duration: 30 }, { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' });
    expect(result.score).toBe(5);
  });

  it('should throw a readable error when Claude response has no JSON', async () => {
    getAnthropic.mockReturnValue({
      messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'not json at all' }] }) },
    });

    await expect(
      scoreClipForPlatform({ duration: 30 }, { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' })
    ).rejects.toThrow('No JSON found in Claude response');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/clipImpactScoringService.test.js`
Expected: FAIL — `Cannot find module '../../src/services/clipImpactScoringService'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/services/clipImpactScoringService.js
/**
 * clipImpactScoringService.js — Scores a repurposer clip against a specific
 * platform using a dedicated 7-criteria rubric (hook, retention, emotional
 * impact, clarity, value, CTA, editing). Fully independent of
 * generateCopyWithClaude / calibrateScore, which remain untouched and keep
 * scoring normal (non-repurposer) video uploads.
 */

const { createClient } = require('@supabase/supabase-js');
const { getAnthropic } = require('../lib/anthropic');
const { extractJsonValue } = require('../lib/jsonExtract');
const { resolveSupabaseServiceKey } = require('../lib/resolveSupabaseServiceKey');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  resolveSupabaseServiceKey('clipImpactScoringService')
);

function logDebug(message) {
  console.log(`🎯 [ClipImpactScoring] ${message}`);
}

function logError(message) {
  console.error(`❌ [ClipImpactScoring] ${message}`);
}

function buildRubricPrompt({ parentVideoId, durationSeconds, platform, niche }) {
  return `# EVALUADOR DE IMPACTO DE CLIPS - MODELO DE PUNTUACIÓN

Eres un experto en viral content y estrategia de redes sociales.
Tu tarea: Analizar un clip extraído de video y asignarle un score de impacto (1-10).

## CONTEXTO DEL CLIP
- Video Padre ID: ${parentVideoId}
- Duración del clip: ${durationSeconds}
- Plataforma objetivo: ${platform}
- Niche: ${niche}

---

## CRITERIOS DE PUNTUACIÓN (Análisis independiente de cada uno)

### 1. HOOK/ATENCIÓN INICIAL (0-2 puntos)
¿Los primeros 0.5 segundos atrapan?
- **2 pts**: Contraste visual brutal, pregunta intrigante, sorpresa emocional
- **1.5 pts**: Movimiento dinámico, cambio de escena, elemento inesperado
- **1 pt**: Contenido relevante pero sin sorpresa
- **0 pts**: Introducción lenta, no llama atención

### 2. RETENCIÓN (Viewer Hold Rate) (0-2 puntos)
¿Mantiene el engagement en los segundos 1-3?
- **2 pts**: Tensión creciente, plot twist en desarrollo, pregunta sin respuesta
- **1.5 pts**: Información útil revelada progresivamente
- **1 pt**: Contenido consistente sin variación
- **0 pts**: Contenido plano o predecible

### 3. IMPACTO EMOCIONAL (0-2 puntos)
¿Genera reacción visceral?
- **2 pts**: Inspiración, shock, risa genuina, rabia constructiva, asombro
- **1.5 pts**: Emociones moderadas pero claras
- **1 pt**: Emociones ligeras o neutrales
- **0 pts**: Sin impacto emocional

### 4. CLARIDAD DEL MENSAJE (0-1.5 puntos)
¿Se entiende qué es o qué aprenderé en 3-6 segundos?
- **1.5 pts**: Ultra claro, sin confusión
- **0.75 pts**: Claro con pequeña ambigüedad
- **0 pts**: Confuso o poco claro

### 5. VALOR/PROPÓSITO (0-1.5 puntos)
¿El clip ofrece algo (aprendizaje, entretenimiento, inspiración)?
- **1.5 pts**: Enseña algo que la gente buscaba, resuelve un problema, entretiene
- **0.75 pts**: Tiene valor pero limitado
- **0 pts**: Puro relleno sin valor

### 6. CALL-TO-ACTION / ENGANCHE (0-1 punto)
¿Invita a interactuar o continuar?
- **1 pt**: CTA claro, pregunta abierta, continuación en series
- **0.5 pts**: CTA implícito
- **0 pts**: Sin invitación a actuar

### 7. EDICIÓN & PACING (0-0.5 puntos)
¿El ritmo del clip acelera o aburre?
- **0.5 pts**: Transiciones rápidas, cortes estratégicos, música/audio en sync
- **0.25 pts**: Edición correcta pero sin dinamismo
- **0 pts**: Pacing lento o edición confusa

---

## CÁLCULO FINAL

**SCORE BASE** = Suma de todos los criterios (máximo 10)

**AJUSTES POR CONTEXTO:**
- Si es educativo + entretenido: +0.5
- Si tiene elemento de sorpresa: +0.5
- Si es nativo de plataforma (ej: trending sound en TikTok): +0.5
- Si tiene texto overlay confuso: -0.5
- Si es contenido duplicado/genérico: -1

**SCORE FINAL** = Limitado a 1-10

---

## COPY PARA REDES (además del score)
Generá también el copy para acompañar este clip en ${platform}:
- copy_short: caption corto y directo (1-2 oraciones), con gancho, listo para pegar
- copy_long: versión extendida (3-5 oraciones) con storytelling y CTA

---

## ESTRUCTURA DE RESPUESTA

Respondé SOLO con este JSON (sin markdown, sin explicaciones):

{
  "parent_video_id": "${parentVideoId}",
  "platform": "${platform}",
  "score": 0,
  "score_breakdown": {
    "hook": 0,
    "retention": 0,
    "emotional_impact": 0,
    "clarity": 0,
    "value": 0,
    "cta": 0,
    "editing": 0
  },
  "main_strength": "",
  "main_weakness": "",
  "improvement_suggestion": "",
  "viral_likelihood": "",
  "recommended_platform": "",
  "hashtags_suggested": [],
  "copy_short": "",
  "copy_long": ""
}`;
}

async function scoreClipForPlatform(clip, { platform, niche, parentVideoId }) {
  const promptText = buildRubricPrompt({
    parentVideoId,
    durationSeconds: clip.duration,
    platform,
    niche: niche || 'general',
  });

  const client = getAnthropic();
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: promptText }],
  });

  if (!response.content || response.content.length === 0 || !response.content[0].text) {
    throw new Error('Invalid Claude response format');
  }

  const jsonText = extractJsonValue(response.content[0].text);
  if (!jsonText) {
    throw new Error('No JSON found in Claude response');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseError) {
    logError(`Parse error: ${parseError.message}`);
    throw new Error('Invalid Claude response format');
  }

  const rawScore = parseFloat(parsed.score);
  const score = Number.isFinite(rawScore) ? Math.max(1, Math.min(10, rawScore)) : 5;

  return {
    score,
    score_breakdown: parsed.score_breakdown || {},
    main_strength: parsed.main_strength || '',
    main_weakness: parsed.main_weakness || '',
    improvement_suggestion: parsed.improvement_suggestion || '',
    viral_likelihood: parsed.viral_likelihood || '',
    recommended_platform: parsed.recommended_platform || platform,
    hashtags_suggested: Array.isArray(parsed.hashtags_suggested) ? parsed.hashtags_suggested : [],
    copy_short: parsed.copy_short || '',
    copy_long: parsed.copy_long || '',
  };
}

module.exports = {
  buildRubricPrompt,
  scoreClipForPlatform,
  // Task 2 adds: scoreClipsWithImpactRubric, persistClipScore, rescoreClip
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/clipImpactScoringService.test.js`
Expected: PASS (4/4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/clipImpactScoringService.js tests/unit/clipImpactScoringService.test.js
git commit -m "feat(clip-impact): add 7-criteria rubric prompt and single-clip scoring call"
```

---

### Task 2: Batch scoring + persistence + rescore

**Files:**
- Modify: `src/services/clipImpactScoringService.js`
- Modify: `tests/unit/clipImpactScoringService.test.js`

**Interfaces:**
- Consumes: `scoreClipForPlatform` (Task 1), Supabase client (module-level `supabase`)
- Produces:
  - `async persistClipScore(clipVideoId: string, platform: string, result: object): Promise<void>` — upserts `clip_platform_scores` on `(clip_video_id, platform)`, mirrors `result.score` onto `videos.clip_impact_score`
  - `async scoreClipsWithImpactRubric(clips: Array<{path, duration, ...}>, { platform, niche, parentVideoId }): Promise<Array>` — used by the orchestrator (Task 3); does NOT persist (clips aren't DB rows yet at that pipeline stage — persistence happens via `clipPersistenceService` right after, which will read `clip.score` off each returned clip)
  - `async rescoreClip(clipVideoId: string, platform: string, niche: string): Promise<{clipVideoId, platform, score, ...}>` — for an *already persisted* clip; fetches its stored duration from `ai_clips_data`, re-scores, persists, returns the result

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/clipImpactScoringService.test.js`:

```javascript
const { scoreClipsWithImpactRubric, persistClipScore, rescoreClip } = require('../../src/services/clipImpactScoringService');

describe('scoreClipsWithImpactRubric', () => {
  it('should throw if clips array is empty', async () => {
    await expect(
      scoreClipsWithImpactRubric([], { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' })
    ).rejects.toThrow('Clips array is required');
  });

  it('should score each clip and attach the result under .score', async () => {
    getAnthropic.mockReturnValue({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ score: 7, score_breakdown: {}, hashtags_suggested: [] }) }],
        }),
      },
    });

    const clips = [{ index: 1, duration: 30 }, { index: 2, duration: 40 }];
    const result = await scoreClipsWithImpactRubric(clips, { platform: 'tiktok', niche: 'comedy', parentVideoId: 'v1' });

    expect(result).toHaveLength(2);
    expect(result[0].score.score).toBe(7);
    expect(result[1].score.score).toBe(7);
  });

  it('should continue scoring remaining clips if one fails', async () => {
    getAnthropic.mockReturnValue({
      messages: {
        create: jest.fn()
          .mockRejectedValueOnce(new Error('Claude timeout'))
          .mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({ score: 6, score_breakdown: {}, hashtags_suggested: [] }) }],
          }),
      },
    });

    const clips = [{ index: 1, duration: 30 }, { index: 2, duration: 40 }];
    const result = await scoreClipsWithImpactRubric(clips, { platform: 'tiktok', niche: 'x', parentVideoId: 'v1' });

    expect(result[0].score.score).toBe(0);
    expect(result[0].score.error).toBe('Claude timeout');
    expect(result[1].score.score).toBe(6);
  });
});

describe('persistClipScore', () => {
  it('should upsert clip_platform_scores and update videos.clip_impact_score', async () => {
    const upsertSpy = jest.spyOn(mock.client, 'upsert');
    const updateSpy = jest.spyOn(mock.client, 'update');
    mock.queueResult({ data: null, error: null }); // upsert
    mock.queueResult({ data: null, error: null }); // update videos

    await persistClipScore('clip-1', 'tiktok', {
      score: 8, score_breakdown: { hook: 2 }, main_strength: 'x', main_weakness: 'y',
      improvement_suggestion: 'z', viral_likelihood: 'Alta', recommended_platform: 'tiktok',
      hashtags_suggested: ['#a'], copy_short: 's', copy_long: 'l',
    });

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ clip_video_id: 'clip-1', platform: 'tiktok', score: 8 }),
      { onConflict: 'clip_video_id,platform' }
    );
    expect(updateSpy).toHaveBeenCalledWith({ clip_impact_score: 8 });
  });
});

describe('rescoreClip', () => {
  it('should fetch the clip, re-score it for the new platform, and persist', async () => {
    getAnthropic.mockReturnValue({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ score: 9, score_breakdown: {}, hashtags_suggested: [] }) }],
        }),
      },
    });

    mock.queueResult({ data: { id: 'clip-1', parent_video_id: 'video-1', ai_clips_data: { duration: 25 } }, error: null }); // select clip
    mock.queueResult({ data: null, error: null }); // upsert
    mock.queueResult({ data: null, error: null }); // update videos

    const result = await rescoreClip('clip-1', 'instagram', 'comedy');

    expect(result.score).toBe(9);
    expect(result.platform).toBe('instagram');
  });

  it('should throw if the clip does not exist', async () => {
    mock.queueResult({ data: null, error: { message: 'not found' } });

    await expect(rescoreClip('missing-clip', 'tiktok', 'x')).rejects.toThrow('Clip not found: missing-clip');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/clipImpactScoringService.test.js`
Expected: FAIL — `scoreClipsWithImpactRubric is not a function` (and similarly for the other two)

- [ ] **Step 3: Add the implementation**

Append to `src/services/clipImpactScoringService.js`, replacing the `module.exports` block:

```javascript
async function scoreClipsWithImpactRubric(clips, { platform, niche, parentVideoId }) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('Clips array is required');
  }

  const scoredClips = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    try {
      logDebug(`Scoring clip ${i + 1}/${clips.length} for platform ${platform}`);
      const result = await scoreClipForPlatform(clip, { platform, niche, parentVideoId });
      scoredClips.push({ ...clip, score: result });
    } catch (error) {
      logError(`Failed to score clip ${i + 1}: ${error.message}`);
      scoredClips.push({
        ...clip,
        score: {
          score: 0,
          score_breakdown: {},
          main_strength: '',
          main_weakness: '',
          improvement_suggestion: '',
          viral_likelihood: '',
          recommended_platform: platform,
          hashtags_suggested: [],
          copy_short: '',
          copy_long: '',
          error: error.message,
        },
      });
    }
  }

  logDebug(`Scored ${scoredClips.length} clips`);
  return scoredClips;
}

async function persistClipScore(clipVideoId, platform, result) {
  const { error: upsertError } = await supabase
    .from('clip_platform_scores')
    .upsert({
      clip_video_id: clipVideoId,
      platform,
      score: result.score,
      score_breakdown: result.score_breakdown,
      main_strength: result.main_strength,
      main_weakness: result.main_weakness,
      improvement_suggestion: result.improvement_suggestion,
      viral_likelihood: result.viral_likelihood,
      recommended_platform: result.recommended_platform,
      hashtags_suggested: result.hashtags_suggested,
      copy_short: result.copy_short,
      copy_long: result.copy_long,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'clip_video_id,platform' });

  if (upsertError) throw upsertError;

  const { error: updateError } = await supabase
    .from('videos')
    .update({ clip_impact_score: result.score })
    .eq('id', clipVideoId);

  if (updateError) throw updateError;

  logDebug(`Persisted score for clip ${clipVideoId} / ${platform}: ${result.score}`);
}

async function rescoreClip(clipVideoId, platform, niche) {
  const { data: clipRow, error } = await supabase
    .from('videos')
    .select('id, parent_video_id, ai_clips_data')
    .eq('id', clipVideoId)
    .single();

  if (error || !clipRow) {
    throw new Error(`Clip not found: ${clipVideoId}`);
  }

  const clip = { duration: clipRow.ai_clips_data?.duration || 0 };

  const result = await scoreClipForPlatform(clip, {
    platform,
    niche: niche || 'general',
    parentVideoId: clipRow.parent_video_id,
  });

  await persistClipScore(clipVideoId, platform, result);

  return { clipVideoId, platform, ...result };
}

module.exports = {
  buildRubricPrompt,
  scoreClipForPlatform,
  scoreClipsWithImpactRubric,
  persistClipScore,
  rescoreClip,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/clipImpactScoringService.test.js`
Expected: PASS (9/9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/clipImpactScoringService.js tests/unit/clipImpactScoringService.test.js
git commit -m "feat(clip-impact): add batch scoring, persistence, and rescore-for-platform"
```

---

### Task 3: Wire into the orchestrator + accept platform/niche on upload

**Files:**
- Modify: `src/services/repurposerService.js`
- Modify: `tests/unit/repurposerService.generateClipsMultiIA.test.js`

**Interfaces:**
- Consumes: `scoreClipsWithImpactRubric` (Task 2)
- Produces: `generateClipsMultiIA(videoPath, parentVideoId, artistId, parentTitle, platform, niche)` — two new trailing params; `createRepurposeVideo({ artistId, sourceUrl, title, durationSeconds, platform, niche })` — two new fields, stored as top-level `videos` columns are NOT needed (kept inside `ai_clips_data` seed, read back via `generateClipsMultiIAFromDatabase`)

- [ ] **Step 1: Read current orchestrator stage 5 and createRepurposeVideo**

```bash
grep -n "scoreClipsWithClaude\|async function createRepurposeVideo\|async function generateClipsMultiIA\b\|async function generateClipsMultiIAFromDatabase" src/services/repurposerService.js
```

- [ ] **Step 2: Write the failing test**

Open `tests/unit/repurposerService.generateClipsMultiIA.test.js`. Replace the `clipScoringService` mock block and its usages:

```javascript
// Replace this existing mock:
// jest.mock('../../src/services/clipScoringService', () => ({
//   scoreClipsWithClaude: jest.fn(),
// }));
// const clipScoringService = require('../../src/services/clipScoringService');

// With:
jest.mock('../../src/services/clipImpactScoringService', () => ({
  scoreClipsWithImpactRubric: jest.fn(),
}));
const clipImpactScoringService = require('../../src/services/clipImpactScoringService');
```

Then in the first test (`'orchestrates all 6 services...'`), replace:

```javascript
clipScoringService.scoreClipsWithClaude.mockResolvedValue(scoredClips);
```
with:
```javascript
clipImpactScoringService.scoreClipsWithImpactRubric.mockResolvedValue(scoredClips);
```

and replace the call to `generateClipsMultiIA(videoPath, videoId, 'artist-1', 'Podcast ep 4')` with:
```javascript
const result = await generateClipsMultiIA(videoPath, videoId, 'artist-1', 'Podcast ep 4', 'tiktok', 'comedy');
```

and replace the assertion:
```javascript
expect(clipScoringService.scoreClipsWithClaude).toHaveBeenCalledWith(validatedClips, videoId);
```
with:
```javascript
expect(clipImpactScoringService.scoreClipsWithImpactRubric).toHaveBeenCalledWith(
  validatedClips,
  { platform: 'tiktok', niche: 'comedy', parentVideoId: videoId }
);
```

Do the same replacement (mock name + resolved value) in the `'updates DB with stage progress at each step'` test.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/repurposerService.generateClipsMultiIA.test.js`
Expected: FAIL — `Cannot find module '../../src/services/clipImpactScoringService'` (created in Task 1-2, so this should actually resolve — the real failure will be the changed call signature/assertion not matching current `repurposerService.js`)

- [ ] **Step 4: Update the orchestrator**

In `src/services/repurposerService.js`, replace the import:

```javascript
const { scoreClipsWithClaude } = require('./clipScoringService');
```
with:
```javascript
const { scoreClipsWithImpactRubric } = require('./clipImpactScoringService');
```

Replace the `generateClipsMultiIA` signature and Stage 5 body:

```javascript
async function generateClipsMultiIA(videoPath, parentVideoId, artistId = null, parentTitle = '', platform = 'tiktok', niche = 'general') {
```

```javascript
    // Stage 5: Score clips (dedicated 7-criteria impact rubric, not the
    // marketing-framework scoring used for normal videos)
    await updateVideoClipsData(parentVideoId, { stage: 'scoring', totalClips: validatedClips.length });
    logDebug(`🎯 [Repurposer] ${parentVideoId} → stage: scoring`);
    const scoredClips = await scoreClipsWithImpactRubric(validatedClips, { platform, niche, parentVideoId });
```

Update `generateClipsMultiIAFromDatabase` to fetch and pass through `platform`/`niche`:

```javascript
async function generateClipsMultiIAFromDatabase(parentVideoId) {
  const { data: parent, error: parentErr } = await supabase
    .from('videos')
    .select('id, source_url, artist_id, title, ai_clips_data')
    .eq('id', parentVideoId)
    .single();

  if (parentErr || !parent) {
    throw new Error(`Video not found: ${parentVideoId}`);
  }

  if (!parent.source_url) {
    throw new Error(`Video has no source URL: ${parentVideoId}`);
  }

  const platform = parent.ai_clips_data?.platform || 'tiktok';
  const niche = parent.ai_clips_data?.niche || 'general';

  let tempVideoPath = null;

  try {
    tempVideoPath = await downloadVideoToTemp(parent.source_url);
    const scoredClips = await generateClipsMultiIA(tempVideoPath, parentVideoId, parent.artist_id, parent.title, platform, niche);
    return scoredClips;
  } finally {
    if (tempVideoPath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
        }
      } catch (err) {
        logError(`Failed to cleanup temp video ${tempVideoPath}: ${err.message}`);
      }
    }
  }
}
```

Update `createRepurposeVideo` to accept and store `platform`/`niche`:

```javascript
async function createRepurposeVideo({ artistId, sourceUrl, title, durationSeconds, platform, niche }) {
  console.log(`📤 [Repurposer] createRepurposeVideo: artistId=${artistId}, sourceUrl=${sourceUrl}, title=${title}, durationSeconds=${durationSeconds}, platform=${platform}, niche=${niche}`);

  if (!artistId || !sourceUrl) {
    throw new Error('artistId y sourceUrl son requeridos');
  }
  validateSourceUrl(sourceUrl);
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
      status: 'queued',
      ai_clips_data: { platform: platform || 'tiktok', niche: niche || 'general' },
    }])
    .select();
  if (error) {
    console.error('❌ [Repurposer] Error insertando video en Supabase:', JSON.stringify(error));
    throw new Error(error.message || error.details || error.hint || 'Error guardando el video en la base de datos');
  }

  const video = data[0];
  console.log(`✅ [Repurposer] Video creado en Supabase: ${video.id}`);

  try {
    const { publishRepurposeJob } = require('../lib/queue');
    await publishRepurposeJob(video.id);
    console.log(`📤 [Repurposer] Job encolado en RabbitMQ: ${video.id} (artista ${artistId})`);
  } catch (queueErr) {
    console.error(`❌ [Repurposer] No se pudo encolar el job para ${video.id}:`, queueErr.message);
    await supabase.from('videos').update({
      status: 'failed',
      error_log: JSON.stringify({ step: 'publishRepurposeJob', message: queueErr.message }),
    }).eq('id', video.id);
    throw new Error(`El video se guardó pero no se pudo encolar para procesar: ${queueErr.message}`);
  }

  return video;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/repurposerService.generateClipsMultiIA.test.js`
Expected: PASS (5/5 tests)

- [ ] **Step 6: Run the full suite**

Run: `cd d:/Github/marketingDigitalBackend && npm test`
Expected: All suites pass (no other file references `clipScoringService` after this — verify with `grep -rn "clipScoringService" src/ tests/`; if `src/services/clipScoringService.js` and its test are now unused, leave them in place for this task — a later cleanup task removes them explicitly rather than silently deleting working, tested code)

- [ ] **Step 7: Commit**

```bash
git add src/services/repurposerService.js tests/unit/repurposerService.generateClipsMultiIA.test.js
git commit -m "feat(clip-impact): wire impact rubric into orchestrator, accept platform/niche on upload"
```

---

### Task 4: Rescore API endpoint

**Files:**
- Modify: `src/controllers/vidalisController.js`
- Modify: `src/routes/vidalisRoutes.js`
- Test: `tests/unit/vidalisController.rescoreClip.test.js`

**Interfaces:**
- Consumes: `rescoreClip(clipVideoId, platform, niche)` from `clipImpactScoringService.js` (Task 2)
- Produces: `POST /api/vidalis/clips/:videoId/rescore` — route param MUST be `videoId` per Global Constraints (authorizeVideo requirement)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/vidalisController.rescoreClip.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/vidalisController.rescoreClip.test.js`
Expected: FAIL — `vidalisController.rescoreClip is not a function`

- [ ] **Step 3: Add the controller export**

In `src/controllers/vidalisController.js`, near `createRepurposeVideo` (line ~285), add:

```javascript
exports.rescoreClip = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { platform, niche } = req.body;
    if (!platform) {
      return res.status(400).json({ error: 'platform es requerido' });
    }
    const { rescoreClip } = require('../services/clipImpactScoringService');
    const result = await rescoreClip(videoId, platform, niche || 'general');
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
```

- [ ] **Step 4: Add the route**

In `src/routes/vidalisRoutes.js`, after line 58 (`router.get('/clips/:parentId', ...)`), add:

```javascript
router.post('/clips/:videoId/rescore', authenticateToken, authorizeVideo, vidalisController.rescoreClip);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/vidalisController.rescoreClip.test.js`
Expected: PASS (3/3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/controllers/vidalisController.js src/routes/vidalisRoutes.js tests/unit/vidalisController.rescoreClip.test.js
git commit -m "feat(clip-impact): add POST /clips/:videoId/rescore endpoint"
```

---

### Task 5: Main gallery shows clips with their impact score

**Files:**
- Modify: `src/services/vidalisService.js`
- Modify: `d:\Github\marketingDigitalFrontend\src\components\VideoGallery.jsx`
- Test: `tests/unit/vidalisService.fetchArtistGallery.test.js`

**Interfaces:**
- Produces: `fetchArtistGallery(artistId, options)` no longer filters out clips

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/vidalisService.fetchArtistGallery.test.js
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { createSupabaseMock } = require('../helpers/supabaseMock');
const mock = createSupabaseMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mock.client }));

const vidalisService = require('../../src/services/vidalisService');

afterEach(() => jest.clearAllMocks());

describe('fetchArtistGallery', () => {
  it('should NOT filter by parent_video_id (clips should be included)', async () => {
    const isSpy = jest.spyOn(mock.client, 'is');
    mock.queueResult({ data: [{ id: 'v1' }, { id: 'clip-1', parent_video_id: 'v1' }], error: null });

    const result = await vidalisService.fetchArtistGallery('artist-1', {});

    expect(isSpy).not.toHaveBeenCalledWith('parent_video_id', null);
    expect(result).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/vidalisService.fetchArtistGallery.test.js`
Expected: FAIL — `isSpy` WAS called with `('parent_video_id', null)`

- [ ] **Step 3: Remove the filter**

In `src/services/vidalisService.js`, in `fetchArtistGallery` (line ~752-767):

```javascript
exports.fetchArtistGallery = async (artistId, options = {}) => {
  const { limit = 20, page = 1 } = options;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw error;
  return data;
};
```

(Only change: the `.is('parent_video_id', null)` line is removed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd d:/Github/marketingDigitalBackend && npx jest tests/unit/vidalisService.fetchArtistGallery.test.js`
Expected: PASS

- [ ] **Step 5: Update the frontend score badge**

In `d:\Github\marketingDigitalFrontend\src\components\VideoGallery.jsx`, replace line 414:

```jsx
<ScoreBadge score={video.viral_score} calibration={video.score_calibration} />
```
with:
```jsx
<ScoreBadge
  score={video.parent_video_id ? video.clip_impact_score : video.viral_score}
  calibration={video.parent_video_id ? null : video.score_calibration}
/>
```

- [ ] **Step 6: Verify the frontend builds**

Run: `cd d:/Github/marketingDigitalFrontend && npx eslint src/components/VideoGallery.jsx && npm run build`
Expected: No lint errors, build succeeds

- [ ] **Step 7: Commit**

```bash
cd d:/Github/marketingDigitalBackend
git add src/services/vidalisService.js tests/unit/vidalisService.fetchArtistGallery.test.js
git commit -m "feat(clip-impact): stop hiding repurposer clips from the main gallery query"

cd d:/Github/marketingDigitalFrontend
git add src/components/VideoGallery.jsx
git commit -m "feat(clip-impact): show clip_impact_score for clip rows in the gallery badge"
```

---

### Task 6: Upload form — platform selector + niche toggle

**Files:**
- Modify: `d:\Github\marketingDigitalFrontend\src\components\RepurposerView.jsx`

**Interfaces:**
- Produces: `handleUpload()` now sends `platform` and `niche` in the `POST /api/vidalis/repurpose/upload` body

- [ ] **Step 1: Add state and the upload-form controls**

In `RepurposerView.jsx`, add new state alongside the existing ones (near line 50-58):

```javascript
const [platform, setPlatform] = useState('');
const [useArtistGenre, setUseArtistGenre] = useState(true);
const [customNiche, setCustomNiche] = useState('');
```

Add a prop for the artist's connected platforms and genre — `RepurposerView` currently only receives `artistId`. Update the component signature and how `Dashboard.jsx` renders it:

In `RepurposerView.jsx`, change:
```javascript
const RepurposerView = ({ artistId }) => {
```
to:
```javascript
const RepurposerView = ({ artistId, activePlatforms = [], artistGenre = '' }) => {
```

In `d:\Github\marketingDigitalFrontend\src\components\Dashboard.jsx`, find where `RepurposerView` is rendered (around line 432-434) and pass the two new props, matching how `activePlatforms` is already passed to `AnalyticsPanel`/`VideoGallery` elsewhere in the same file (`activeArtist?.active_platforms || []`):

```jsx
<RepurposerView
  artistId={currentArtistId}
  activePlatforms={activeArtist?.active_platforms || []}
  artistGenre={activeArtist?.ai_genre || ''}
/>
```

- [ ] **Step 2: Render the platform selector and niche toggle in the upload form**

In the upload-phase render (the final `return` block, before the file-drop `<label>`), add:

```jsx
<div style={{ width: '100%', maxWidth: '480px', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
  <div>
    <div style={{ color: '#B8B8C0', fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>Red social objetivo</div>
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      {(activePlatforms.length ? activePlatforms : ['instagram', 'tiktok', 'youtube']).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => setPlatform(p)}
          style={{
            padding: '8px 14px', borderRadius: '100px', fontSize: '12px', fontWeight: 700,
            border: platform === p ? '2px solid #7C3AED' : '1px solid rgba(255,255,255,0.15)',
            background: platform === p ? 'rgba(124,58,237,0.15)' : 'transparent',
            color: '#fff', cursor: 'pointer', textTransform: 'capitalize',
          }}
        >
          {p}
        </button>
      ))}
    </div>
  </div>

  <div>
    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#B8B8C0', cursor: 'pointer' }}>
      <input type="checkbox" checked={useArtistGenre} onChange={(e) => setUseArtistGenre(e.target.checked)} />
      Usar género del artista {artistGenre ? `(${artistGenre})` : ''}
    </label>
    {!useArtistGenre && (
      <input
        type="text"
        value={customNiche}
        onChange={(e) => setCustomNiche(e.target.value)}
        placeholder="Ej: true crime, comedia, finanzas..."
        style={{ marginTop: '8px', width: '100%', padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.15)', background: '#121214', color: '#fff', fontSize: '13px' }}
      />
    )}
  </div>
</div>
```

- [ ] **Step 3: Send platform/niche in the upload request and validate platform is selected**

In `handleUpload`, change the guard clause:

```javascript
const handleUpload = async () => {
  if (!file || !platform) return;
```

And in the "3. Registrar el video" fetch body, add the two fields:

```javascript
      const res = await fetch(`${API}/api/vidalis/repurpose/upload`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          artistId,
          sourceUrl: presign.sourceUrl,
          title: title || file.name,
          platform,
          niche: useArtistGenre ? artistGenre : customNiche,
        }),
      });
```

Update the submit button's `disabled` check to also require a platform:

```jsx
      <button
        onClick={handleUpload}
        disabled={!file || !platform || !!uploadPhase}
```

- [ ] **Step 4: Verify the frontend builds**

Run: `cd d:/Github/marketingDigitalFrontend && npx eslint src/components/RepurposerView.jsx src/components/Dashboard.jsx && npm run build`
Expected: No lint errors, build succeeds

- [ ] **Step 5: Update the backend controller to accept the new fields**

In `d:\Github\marketingDigitalBackend\src\controllers\vidalisController.js`, update `createRepurposeVideo` (line ~285-294):

```javascript
exports.createRepurposeVideo = async (req, res) => {
  try {
    const { artistId, sourceUrl, title, durationSeconds, platform, niche } = req.body;
    const repurposerService = require('../services/repurposerService');
    const video = await repurposerService.createRepurposeVideo({ artistId, sourceUrl, title, durationSeconds, platform, niche });
    res.status(201).json(video);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
```

- [ ] **Step 6: Commit**

```bash
cd d:/Github/marketingDigitalBackend
git add src/controllers/vidalisController.js
git commit -m "feat(clip-impact): accept platform/niche in the repurpose upload endpoint"

cd d:/Github/marketingDigitalFrontend
git add src/components/RepurposerView.jsx src/components/Dashboard.jsx
git commit -m "feat(clip-impact): add platform selector and niche toggle to the upload form"
```

---

### Task 7: Persistent layout + clip cards with rescore/publish

**Files:**
- Modify: `d:\Github\marketingDigitalFrontend\src\components\RepurposerView.jsx`

**Interfaces:**
- Consumes: `POST /api/vidalis/clips/:videoId/rescore` (Task 4), existing `POST /api/vidalis/publish-now/:videoId`

- [ ] **Step 1: Restructure the render to a persistent layout**

By this point (after Task 6), the component has exactly three render blocks in this order: `if (phase === 'processing') { return (...) }`, `if (phase === 'gallery') { return (...) }`, then a final unconditional `return (...)` containing the upload form (file-drop label + submit button + the platform/niche controls added in Task 6). Do this as mechanical cut-and-paste edits — move the existing JSX, don't retype it:

1. Find the final unconditional `return (` at the bottom of the component — it starts with `<div className="card-pro" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px' }}>` and is the LAST return in the file. Cut everything from that `<div className="card-pro"...>` through its matching `</div>` (immediately before that return's closing `);`) and paste it, verbatim, as the value of a new `const uploadForm = ( ... );` declaration placed directly above the `if (phase === 'processing')` block. Delete the now-empty final `return (...)` — nothing should remain at the bottom of the component after this cut except the new combined `return` from step 3 below.
2. Convert `if (phase === 'processing') { return ( <div className="card-pro" ...> ... </div> ); }` into `{phase === 'processing' && ( <div className="card-pro" ...> ... </div> )}` — delete the `if (...) {`/closing `}` wrapper and the `return`, keep everything from `<div className="card-pro"` to its matching `</div>` exactly as-is.
3. Do the same `if`-to-`&&` conversion for `if (phase === 'gallery') { return (...) }`, but ALSO replace its inner clip-rendering JSX per Step 2 below (don't keep the old `best`/`rest` split — that's superseded by the new per-clip cards).

Wrap all three pieces in one final return:

```javascript
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {uploadForm}

      {phase === 'processing' && (
        <div className="card-pro" style={{ minHeight: '260px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          {/* ... exact existing processing-phase JSX, unchanged ... */}
        </div>
      )}

      {phase === 'gallery' && clips.length > 0 && (
        <div>
          {/* ... clip cards, see Step 2 below ... */}
        </div>
      )}
    </div>
  );
```

Note: `phase` still drives which section is active, but the upload form is no longer inside the conditional — it always renders. Remove the `reset()` function's `setPhase('upload')` calls that were only needed to "return" to the upload screen — `phase` now only toggles the processing/gallery sections below the (always-visible) form. Keep `reset()` clearing `clips`/`error`/`file`/`title` as before; drop `setPhase('upload')` from it (there's no separate upload phase to return to anymore) and instead reset `phase` to `'idle'` — add a check `phase === 'gallery'` (not a generic non-upload check) so the results section only shows after a real run.

- [ ] **Step 2: Replace clip cards with score + copy + hashtags + action buttons**

Add local state for the rescore UI and a publish handler, near the other `useState` calls:

```javascript
  const [rescoringId, setRescoringId] = useState(null);
  const [rescorePlatform, setRescorePlatform] = useState({});
```

Add handlers (near `fetchClips`):

```javascript
  const handleRescore = async (clipId, newPlatform) => {
    setRescoringId(clipId);
    try {
      const res = await fetch(`${API}/api/vidalis/clips/${clipId}/rescore`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ platform: newPlatform, niche: useArtistGenre ? artistGenre : customNiche }),
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.error || 'Error al re-puntuar el clip');
      setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, clip_impact_score: updated.score, ai_copy_short: updated.copy_short, hashtags: (updated.hashtags_suggested || []).join(' ') } : c)));
    } catch (err) {
      setError(err.message);
    } finally {
      setRescoringId(null);
    }
  };

  const handlePublish = async (clipId, clipPlatform) => {
    try {
      const res = await fetch(`${API}/api/vidalis/publish-now/${clipId}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ platforms: [clipPlatform] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al publicar el clip');
    } catch (err) {
      setError(err.message);
    }
  };
```

Replace the clip-rendering JSX (currently `best`/`rest` cards showing only `title` + `ScoreBadge`) with cards that also show copy/hashtags and the two action buttons:

```jsx
{clips.map((clip) => (
  <div key={clip.id} style={{ background: '#121214', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '12px', padding: '16px', marginBottom: '14px' }}>
    <div style={{ color: '#fff', fontSize: '14px', fontWeight: 700, marginBottom: '6px' }}>{clip.title}</div>
    <ScoreBadge score={clip.clip_impact_score} />
    {clip.ai_copy_short && (
      <div style={{ color: '#B8B8C0', fontSize: '12px', marginTop: '8px' }}>{clip.ai_copy_short}</div>
    )}
    {clip.hashtags && (
      <div style={{ color: '#7C9FFF', fontSize: '11px', marginTop: '4px' }}>{clip.hashtags}</div>
    )}
    <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
      <select
        value={rescorePlatform[clip.id] || ''}
        onChange={(e) => setRescorePlatform((prev) => ({ ...prev, [clip.id]: e.target.value }))}
        style={{ fontSize: '11px', background: '#1C1C1F', color: '#fff', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', padding: '4px' }}
      >
        <option value="">Otra red...</option>
        {activePlatforms.filter((p) => p !== platform).map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
      <button
        onClick={() => rescorePlatform[clip.id] && handleRescore(clip.id, rescorePlatform[clip.id])}
        disabled={!rescorePlatform[clip.id] || rescoringId === clip.id}
        className="btn-secondary"
        style={{ fontSize: '11px', padding: '6px 10px' }}
      >
        {rescoringId === clip.id ? 'Puntuando...' : 'Puntuar para otra red'}
      </button>
      <button
        onClick={() => handlePublish(clip.id, platform)}
        className="btn-secondary"
        style={{ fontSize: '11px', padding: '6px 10px' }}
      >
        Subir a {platform}
      </button>
    </div>
  </div>
))}
```

(This replaces the previous `best`/`rest` split-layout — every clip now gets the same card treatment, since "best" isn't meaningful across independently re-scorable platforms.)

- [ ] **Step 3: Verify the frontend builds**

Run: `cd d:/Github/marketingDigitalFrontend && npx eslint src/components/RepurposerView.jsx && npm run build`
Expected: No lint errors, build succeeds

- [ ] **Step 4: Manual verification**

Run: `cd d:/Github/marketingDigitalFrontend && npm run dev`
Open the Repurposer tab. Confirm:
- Upload form has a platform selector (pills) and niche toggle, upload button disabled until a platform is picked
- After upload, the form stays visible while a processing indicator appears below it
- On completion, clip cards appear below the (still-visible) form, each showing a score, copy, hashtags, "Puntuar para otra red" and "Subir a {platform}" buttons
- Clicking "Puntuar para otra red" after picking a platform from the dropdown updates that card's score

- [ ] **Step 5: Commit**

```bash
cd d:/Github/marketingDigitalFrontend
git add src/components/RepurposerView.jsx
git commit -m "feat(clip-impact): persistent layout with clip cards, rescore, and publish buttons"
```

---

## Summary

1. ✅ Rubric prompt + single-clip Claude scoring call
2. ✅ Batch scoring, persistence (`clip_platform_scores` upsert + `videos.clip_impact_score`), rescore
3. ✅ Orchestrator swap (Stage 5) + platform/niche accepted on upload
4. ✅ `POST /clips/:videoId/rescore` endpoint
5. ✅ Main gallery includes clips, shows `clip_impact_score`
6. ✅ Upload form: platform selector + niche toggle
7. ✅ Persistent layout, clip cards with rescore/publish buttons

**Before Task 3 is testable end-to-end (not just unit tests):** run `sql/clip_impact_score_migration.sql` in the Supabase SQL Editor.

**Not covered by this plan** (existing, untouched): `generateCopyWithClaude`, `calibrateScore`, `clipScoringService.js` (superseded but left in place — no other code references it after Task 3; a future cleanup task can remove it once confirmed dead).
