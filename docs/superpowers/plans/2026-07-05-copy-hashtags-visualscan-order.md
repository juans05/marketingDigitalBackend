# Copy/Hashtags/Visual-Scan Reasoning Order — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the "reason before output" fix (already applied to every numeric score in `aiService.js`) to the two remaining AI-generated outputs shown per video in the "Resultados IA" panel — Copywriting Estratégico (`ai_copy_short`/`ai_copy_long`) and Hashtags de Autoridad (`hashtags`) — plus tighten the Visual Scan's qualitative outputs (`verdict`, `quickFixes`) so they're grounded in the dimension scores instead of generic.

**Architecture:** Both fixes are prompt-text-only changes inside `src/services/aiService.js` (no new files, no schema/DB changes, no controller changes — the JSON key set returned by both functions is unchanged, only the field ORDER and the instruction text). Verified via mocked-Anthropic/Gemini unit tests asserting field order and instruction presence, following the exact pattern already in `tests/unit/aiService.promptOrder.test.js`.

## Global Constraints

- User-facing/prompt strings in Spanish, matching the existing tone in this file.
- CommonJS (`require`/`module.exports`), no ESM.
- Do not change the JSON **keys** returned by `generateCopyWithClaude` or `scoreVisualVirality` — `marketing_breakdown`, `ai_copy_short`, `ai_copy_long`, `hashtags`, `viral_score`, `dimensions`, `content_type_3h`, `psychological_triggers`, `verdict`, `quickFixes`, `overall` all must still be present with the same names; only their textual ORDER in the prompt template and their instruction text may change.
- `checkHashtags()` (banned/risky hashtag filtering in `src/config/bannedHashtags.js`) is unrelated to this plan — do not touch it.
- Tests: mock `@anthropic-ai/sdk` / `@google/generative-ai` the same way `tests/unit/aiService.promptOrder.test.js` already does (see that file for the exact mock setup — do not invent a new mocking approach). Assert order via `indexOf` comparisons on the captured prompt string, anchored to a schema-start marker to avoid false positives from prose mentioning a field name before the JSON block (see that file's `schemaStart` pattern).
- Run `npm test` (full suite) before each commit; it must stay at 100% passing with no new console noise.
- Never commit `debug_ai.log` or `logs/combined1.log` — check `git status --short` before every `git add`.

---

### Task 1: Reorder `generateCopyWithClaude` so copy & hashtags execute the chosen framework

**Files:**
- Modify: `src/services/aiService.js` (function `generateCopyWithClaude`, the JSON schema template currently at lines 928-955, and the "REGLAS DE HASHTAGS" text at lines 957-961)
- Test: `tests/unit/aiService.promptOrder.test.js` (add to the existing `describe('generateCopyWithClaude — ...')` block)

**Interfaces:**
- Consumes: nothing new — `generateCopyWithClaude(geminiAnalysis, transcript, title, platforms, artistContext, learningContext)` keeps its exact signature and return shape.
- Produces: no new exports. The prompt text built inside the function changes; `parseResponse` (unchanged) still reads `parsed.ai_copy_short`, `parsed.ai_copy_long`, `parsed.hashtags`, `parsed.marketing_breakdown.*`, `parsed.viral_score` from whatever JSON Claude returns — object key access, unaffected by prompt text order.

**Problem being fixed:** the current schema (verbatim, current file):
```js
  userContent += `\n\nTítulo del contenido: ${title || '(sin título)'}

Generá el siguiente JSON (sin markdown, sin explicaciones, solo JSON puro). IMPORTANTE: generá los campos en ESTE orden — completá marketing_breakdown PRIMERO (es tu análisis dimensión por dimensión) y calculá viral_score AL FINAL, como el promedio ponderado real de esos sub-scores, nunca como una impresión general escrita antes de analizar:
{
  "ai_copy_short": "Caption corto y potente (1-2 oraciones). Usá AIDA condensado: Attention + Action. Debe frenar el scroll y provocar interacción.",
  "ai_copy_long": "Versión extendida (3-5 oraciones). Seguí AIDA completo o PAS según el contenido. Incluí storytelling, emociones y CTA estratégico.",
  "hashtags": "#etiqueta1 #etiqueta2 ... (15-20 hashtags estratégicos)",
  "marketing_breakdown": {
    "hook_score": 8,
    "retention_score": 7,
    "reward_score": 6,
    "shareability_score": 7,
    "audio_match_score": 8,
    "trend_alignment_score": 5,
    "framework_used": "AIDA",
    "psychological_triggers": ["CURIOSIDAD GAP", "IDENTIFICACIÓN"],
    "content_type_3h": "hub",
    "platform_fit": {
      "tiktok": 8,
      "instagram": 7,
      "youtube": 6
    },
    "best_posting_time": "19:00-21:00",
    "replay_potential": "alto",
    "comment_bait_strength": "medio"
  },
  "viral_score": 7.5
}

REGLAS DE HASHTAGS (MUY IMPORTANTE):
- Combiná 5-7 hashtags de nicho específico del contenido + 5-7 de comunidad/tendencia + 3-5 del artista que históricamente funcionaron.
- NUNCA uses hashtags genéricos saturados como #viral, #fyp, #foryou, #parati, #trending, #explorepage — TikTok/Instagram los ignoran.
- NUNCA uses hashtags baneados o suprimidos (contenido sexual/sugestivo, spam, follow4follow, etc.) — causan shadowban y matan el alcance.
- Priorizá hashtags entre 10K-500K de volumen (nicho rentable) sobre los de millones (ruido).
```

Even though `marketing_breakdown` is instructed to be written first in prose ("IMPORTANTE: ... completá marketing_breakdown PRIMERO"), the JSON schema still LISTS `ai_copy_short`/`ai_copy_long`/`hashtags` before `marketing_breakdown` — and models tend to emit keys in the order the schema lists them, same root cause already fixed for `viral_score` itself. This means the copy is very likely still written before `framework_used` (AIDA/PAS/Storytelling) and `psychological_triggers` are decided, so the copy can't reliably execute a framework that doesn't exist yet at generation time, and hashtags aren't necessarily aligned with the decided `content_type_3h`.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('generateCopyWithClaude — el pipeline principal calcula viral_score después de marketing_breakdown', ...)` block in `tests/unit/aiService.promptOrder.test.js` (reuse the file's existing `mockCreate`/`aiService` setup — do not duplicate the mock boilerplate):

```js
  test('en el schema JSON, "ai_copy_short" y "hashtags" aparecen después de "marketing_breakdown" (el copy ejecuta el framework ya decidido)', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({
        marketing_breakdown: { hook_score: 8, retention_score: 7, reward_score: 6, shareability_score: 7, audio_match_score: 8, trend_alignment_score: 5, framework_used: 'AIDA', psychological_triggers: ['CURIOSIDAD GAP'] },
        ai_copy_short: 'x', ai_copy_long: 'x', hashtags: '#a #b',
        viral_score: 7,
      }) }],
    });

    await aiService.generateCopyWithClaude('análisis visual de prueba', null, 'Mi Video', ['tiktok'], null, null);

    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    const schemaStart = userContent.indexOf('"marketing_breakdown"');
    const idxCopyShort = userContent.indexOf('"ai_copy_short"');
    const idxHashtags = userContent.indexOf('"hashtags"');
    const idxViralScore = userContent.indexOf('"viral_score"', schemaStart);
    expect(schemaStart).toBeGreaterThan(-1);
    expect(idxCopyShort).toBeGreaterThan(schemaStart);
    expect(idxHashtags).toBeGreaterThan(idxCopyShort);
    expect(idxViralScore).toBeGreaterThan(idxHashtags);
  });

  test('las reglas de copy le piden ejecutar el framework y los gatillos ya decididos en marketing_breakdown', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ marketing_breakdown: {}, ai_copy_short: 'x', ai_copy_long: 'x', hashtags: '#a', viral_score: 5 }) }],
    });

    await aiService.generateCopyWithClaude('análisis', null, 'Video', ['tiktok'], null, null);

    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).toMatch(/framework_used/);
    expect(userContent).toMatch(/psychological_triggers/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/unit/aiService.promptOrder.test.js -t "marketing_breakdown"`
Expected: FAIL — `idxCopyShort` is NOT greater than `schemaStart` (copy fields currently precede `marketing_breakdown` in the schema), and/or the second test's instruction text isn't present yet.

- [ ] **Step 3: Reorder the JSON schema and rewrite the hashtag/copy instructions**

In `src/services/aiService.js`, replace the schema block (the object literal between `Generá el siguiente JSON` and the closing `` ` `` before `REGLAS DE HASHTAGS`) with:

```js
Generá el siguiente JSON (sin markdown, sin explicaciones, solo JSON puro). IMPORTANTE: generá los campos en ESTE orden — completá marketing_breakdown PRIMERO (decidí ahí el framework y los gatillos), después escribí el copy y los hashtags EJECUTANDO esa decisión, y calculá viral_score AL FINAL, como el promedio ponderado real de los sub-scores, nunca como una impresión general escrita antes de analizar:
{
  "marketing_breakdown": {
    "hook_score": 8,
    "retention_score": 7,
    "reward_score": 6,
    "shareability_score": 7,
    "audio_match_score": 8,
    "trend_alignment_score": 5,
    "framework_used": "AIDA",
    "psychological_triggers": ["CURIOSIDAD GAP", "IDENTIFICACIÓN"],
    "content_type_3h": "hub",
    "platform_fit": {
      "tiktok": 8,
      "instagram": 7,
      "youtube": 6
    },
    "best_posting_time": "19:00-21:00",
    "replay_potential": "alto",
    "comment_bait_strength": "medio"
  },
  "ai_copy_short": "Caption corto y potente (1-2 oraciones) que EJECUTA el framework_used y al menos uno de los psychological_triggers que ya decidiste arriba — no un texto genérico desconectado de esa decisión. Debe frenar el scroll y provocar interacción.",
  "ai_copy_long": "Versión extendida (3-5 oraciones) que sigue el framework_used completo (AIDA o PAS, según lo que ya decidiste) e incorpora los psychological_triggers detectados. Incluí storytelling, emociones y CTA estratégico.",
  "hashtags": "#etiqueta1 #etiqueta2 ... (15-20 hashtags estratégicos, alineados con el content_type_3h que ya decidiste)",
  "viral_score": 7.5
}

REGLAS DE HASHTAGS (MUY IMPORTANTE):
- Combiná 5-7 hashtags de nicho específico del contenido + 5-7 de comunidad/tendencia + 3-5 del artista que históricamente funcionaron.
- Alineá la mezcla con el content_type_3h que ya decidiste: "hero" pide hashtags aspiracionales/de mayor alcance, "hub" pide hashtags de comunidad/serie, "hygiene" pide hashtags de búsqueda/tutorial.
- NUNCA uses hashtags genéricos saturados como #viral, #fyp, #foryou, #parati, #trending, #explorepage — TikTok/Instagram los ignoran.
- NUNCA uses hashtags baneados o suprimidos (contenido sexual/sugestivo, spam, follow4follow, etc.) — causan shadowban y matan el alcance.
- Priorizá hashtags entre 10K-500K de volumen (nicho rentable) sobre los de millones (ruido).
```

Note: only the field ORDER and the `ai_copy_short`/`ai_copy_long`/`hashtags` description strings and the two added hashtag-rule bullet points changed. `marketing_breakdown`'s own sub-fields, `viral_score`'s position (last) and description, and the rest of "REGLAS DE HASHTAGS" are unchanged from the current file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/unit/aiService.promptOrder.test.js`
Expected: all tests in the file pass (the two new ones plus the pre-existing ones in the same file).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all suites pass, same total count as before plus the 2 new tests, output pristine (no unexpected console noise beyond the pre-existing `logDebug` lines already present in other tests in this file).

- [ ] **Step 6: Commit**

```bash
git add src/services/aiService.js tests/unit/aiService.promptOrder.test.js
git commit -m "fix: make Copywriting Estratégico and Hashtags de Autoridad execute the chosen framework

marketing_breakdown (framework_used, psychological_triggers, content_type_3h)
was listed AFTER ai_copy_short/ai_copy_long/hashtags in the JSON schema,
even though the prose instruction said to decide it first — the same
schema-order bug already fixed for viral_score, but here it meant the
copy and hashtags could be written before the model had committed to a
framework or triggers for them to execute. Reordered so the analysis
comes first and the creative fields explicitly reference and execute
it; hashtags now also reference the decided content_type_3h."
```

---

### Task 2: Ground Visual Scan's `verdict`/`quickFixes` in the actual dimension scores

**Files:**
- Modify: `src/services/aiService.js` (function `scoreVisualVirality`, the prompt string currently defined around the `const prompt = ...` template)
- Test: `tests/unit/aiService.promptOrder.test.js` (add to the existing `describe('scoreVisualVirality — ...')` block)

**Interfaces:**
- Consumes: nothing new — `scoreVisualVirality(mediaUrl, mediaType, platform, artistId)` keeps its exact signature and return shape (`applyVisualCalibration` still reads `parsed.overall`, `parsed.dimensions`, etc. — unaffected by prompt text changes).
- Produces: no new exports, no new JSON keys.

**Problem being fixed:** the current instructions for `verdict` and `quickFixes` (verbatim, current file) are generic and don't explicitly require the model to reference the dimension scores it just wrote:
```js
  "verdict": "<1 frase directa: se viraliza o no, y la razón principal según frameworks de marketing>",
  "quickFixes": [<3 mejoras concretas basadas en frameworks: HOOK más fuerte, gatillo psicológico faltante, optimización de plataforma>]
```
Nothing ties `quickFixes` to whichever of the 6 dimensions actually scored lowest, so the model can default to generic, interchangeable advice ("mejora el hook", "agrega un gatillo") regardless of what the image actually needs.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('scoreVisualVirality — ...')` block in `tests/unit/aiService.promptOrder.test.js`:

```js
  test('el prompt le pide a quickFixes atacar específicamente la dimensión con menor score', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({
        dimensions: {
          hook: { score: 80, label: 'x', detail: 'x' },
          quality: { score: 80, label: 'x', detail: 'x' },
          emotion: { score: 80, label: 'x', detail: 'x' },
          trend: { score: 80, label: 'x', detail: 'x' },
          thumb: { score: 80, label: 'x', detail: 'x' },
          scroll: { score: 80, label: 'x', detail: 'x' },
        },
        content_type_3h: 'hero', psychological_triggers: [], verdict: 'x',
        quickFixes: ['a', 'b', 'c'], overall: 80,
      }) },
    });

    await aiService.scoreVisualVirality('https://example.com/img.jpg', 'image', 'tiktok', null);

    const promptArg = mockGenerateContent.mock.calls[0][0][1];
    expect(promptArg).toMatch(/dimensi[oó]n.*(m[aá]s baja|menor score)/i);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/unit/aiService.promptOrder.test.js -t "quickFixes atacar"`
Expected: FAIL — no such instruction exists in the current prompt text.

- [ ] **Step 3: Add the grounding instruction**

In `src/services/aiService.js`, inside `scoreVisualVirality`'s `prompt` template, locate this line (added in a previous commit):
```js
CALIBRACIÓN: Usá el rango completo 0-100 en cada dimensión — una imagen genuinamente débil va en 0-30, una excepcional en 90+. No agrupes tus respuestas alrededor de 50-70 "por las dudas", y no favorezcas números redondos por costumbre.
```
Immediately after it (same template literal, new line), add:
```js

QUICKFIXES ESPECÍFICOS: Tus 3 quickFixes deben atacar directamente la o las dimensiones con menor score de las 6 que evaluaste — no des consejos genéricos intercambiables entre imágenes distintas. Si "hook" o "scroll" tienen la dimensión más baja, decí específicamente qué cambiaría ESTA imagen puntual para mejorarlas.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest tests/unit/aiService.promptOrder.test.js`
Expected: all tests in the file pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all suites pass, output pristine.

- [ ] **Step 6: Commit**

```bash
git add src/services/aiService.js tests/unit/aiService.promptOrder.test.js
git commit -m "fix: ground Visual Scan quickFixes in the actual lowest-scoring dimension

quickFixes and verdict had no instruction connecting them to the 6
dimension scores the model had just written, so advice could default
to generic, interchangeable suggestions regardless of what the image
specifically needed. Added an explicit instruction to target the
lowest-scoring dimension(s) with concrete, image-specific fixes."
```

---

## Manual verification (after both tasks)

1. Re-read the full diff (`git log -p` for these 2 commits) to confirm no JSON key was added/removed/renamed — only order and instruction text.
2. Confirm `git status --short` shows no `debug_ai.log`/`logs/combined1.log` staged in either commit.
3. Full `npm test` run, all green.
