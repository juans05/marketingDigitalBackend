# Plan detallado — Pasos 3 a 6 + verificación final

**Fecha:** 2026-07-04
**Rama:** `feature/copilot-performance`
**Continúa de:** `docs/superpowers/specs/2026-07-04-copilot-performance-plan.md`
**Estado de lo ya hecho:** Pasos 1 y 2 (fix de escala del score + ventana de
regresión suavizada) ya están implementados, testeados (6/6 tests) y
comiteados en `bb81e3b`. **Este documento es solo para los pasos que
faltan — no he tocado más código de producción desde ese commit.**

Este documento describe, con el código exacto a modificar (líneas actuales
del archivo tras el commit anterior), qué voy a hacer en cada paso restante.
Nada de esto se ejecuta hasta que lo apruebes.

---

## Paso 3 — Paralelizar las 4 queries de `fetchArtistLearningContext`

**Archivo:** `src/services/aiService.js`, función `fetchArtistLearningContext`
(línea 120-153 actual).

### Estado actual (código real, líneas 120-153)

```js
async function fetchArtistLearningContext(artistId) {
  if (!artistId) return null;

  try {
    const { data: artistProfile } = await supabase
      .from('artists')
      .select('name, ai_genre, ai_audience, ai_tone, creative_dna, branding_data')
      .eq('id', artistId)
      .single();

    // 1. Top 10 posts con mejor engagement real (solo los que tienen métricas)
    const { data: topPosts } = await supabase
      .from('videos')
      .select('title, hashtags, platforms, viral_score, viral_score_real, ai_copy_short, analytics_4h')
      .eq('artist_id', artistId)
      .not('viral_score_real', 'is', null)
      .order('viral_score_real', { ascending: false })
      .limit(10);

    // 2. Snapshots agrupados por plataforma (engagement promedio)
    const { data: snapshots } = await supabase
      .from('post_metrics_snapshots')
      .select('platform, likes, comments, views, shares, engagement_rate, viral_score_real')
      .eq('artist_id', artistId)
      .order('snapshot_at', { ascending: false })
      .limit(100);

    // 3. Últimos 3 análisis de insights (para detectar tendencias en decisiones)
    const { data: insightsLog } = await supabase
      .from('analytics_insights_log')
      .select('generated_at, insights, decisions, engagement_rate, best_platform')
      .eq('artist_id', artistId)
      .order('generated_at', { ascending: false })
      .limit(3);

    if (!topPosts?.length && !snapshots?.length) return null;
    // ... el resto de la función usa artistProfile, topPosts, snapshots, insightsLog
```

Cada `await` bloquea al siguiente sin que exista una dependencia real entre
ellas — las 4 consultas usan el mismo `artistId` pero leen tablas distintas
(`artists`, `videos`, `post_metrics_snapshots`, `analytics_insights_log`) y
ninguna necesita el resultado de otra.

### Cambio propuesto

Reemplazar los 4 `await` secuenciales por un único `Promise.all`:

```js
async function fetchArtistLearningContext(artistId) {
  if (!artistId) return null;

  try {
    const [
      { data: artistProfile },
      { data: topPosts },
      { data: snapshots },
      { data: insightsLog },
    ] = await Promise.all([
      supabase
        .from('artists')
        .select('name, ai_genre, ai_audience, ai_tone, creative_dna, branding_data')
        .eq('id', artistId)
        .single(),
      supabase
        .from('videos')
        .select('title, hashtags, platforms, viral_score, viral_score_real, ai_copy_short, analytics_4h')
        .eq('artist_id', artistId)
        .not('viral_score_real', 'is', null)
        .order('viral_score_real', { ascending: false })
        .limit(10),
      supabase
        .from('post_metrics_snapshots')
        .select('platform, likes, comments, views, shares, engagement_rate, viral_score_real')
        .eq('artist_id', artistId)
        .order('snapshot_at', { ascending: false })
        .limit(100),
      supabase
        .from('analytics_insights_log')
        .select('generated_at, insights, decisions, engagement_rate, best_platform')
        .eq('artist_id', artistId)
        .order('generated_at', { ascending: false })
        .limit(3),
    ]);

    if (!topPosts?.length && !snapshots?.length) return null;
    // ... el resto de la función sigue exactamente igual
```

**Nada más cambia** — el resto del cuerpo de la función (cálculo de
`platformStats`, `topHashtags`, `scoreBias`, etc.) no toca `artistProfile`,
`topPosts`, `snapshots` ni `insightsLog` de forma distinta a como ya lo hace;
solo cambia CÓMO se obtienen esos 4 valores (en paralelo, no en serie).

**Riesgo:** bajo. `Promise.all` falla rápido (reject) si cualquiera de las 4
promesas rechaza — igual que hoy, donde un `throw` en cualquier `await`
también aborta la función y cae en el `catch` de más abajo
(`catch (err) { logDebug(...); return null; }`, línea ~258-261 actual). El
comportamiento ante errores no cambia.

**Test que lo va a cubrir:** mock de Supabase que registra el orden de
resolución de las 4 queries y confirma que las 4 promesas se lanzan antes de
que cualquiera resuelva (usando el mismo `createSupabaseMock` que ya existe
en `tests/helpers/supabaseMock.js`, extendido para poder simular 4 respuestas
en la misma ronda). Además, un test que confirma que el resultado final
(`topHashtags`, `platformPerformance`, etc.) es idéntico al que devuelve hoy
con los mismos datos de entrada — para garantizar que paralelizar no cambió
ningún cálculo.

---

## Paso 4 — Caché en memoria de 5 minutos por artista

**Archivo:** `src/services/aiService.js`, mismo entorno que
`fetchArtistLearningContext` y siguiendo el patrón que ya existe para
`fetchGlobalCalibration` (líneas 264-265 actuales):

```js
let _globalCalibrationCache = null;
let _globalCalibrationExpiry = 0;
```

### Cambio propuesto

Agregar una caché análoga, pero **por artista** (un `Map`, no una sola
variable, porque hay múltiples artistas):

```js
const _artistLearningCache = new Map(); // artistId -> { data, expiry }
const ARTIST_LEARNING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
```

Y envolver el cuerpo actual de `fetchArtistLearningContext` así (pseudocódigo
de la estructura, no repito el cuerpo completo que no cambia):

```js
async function fetchArtistLearningContext(artistId) {
  if (!artistId) return null;

  const cached = _artistLearningCache.get(artistId);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  try {
    // ... (el Promise.all del Paso 3 + todo el cálculo actual, sin cambios) ...

    const result = {
      topHashtags,
      platformPerformance,
      // ... el resto de las propiedades que ya arma la función hoy
    };

    _artistLearningCache.set(artistId, { data: result, expiry: Date.now() + ARTIST_LEARNING_CACHE_TTL_MS });
    return result;
  } catch (err) {
    logDebug(`⚠️ [Learning] No se pudo obtener contexto de aprendizaje: ${err.message}`);
    return null;
  }
}
```

**Detalle importante:** los resultados `null` (cuando `!topPosts?.length &&
!snapshots?.length`) **NO se cachean** — si un artista todavía no tiene
métricas, queremos que la próxima llamada intente de nuevo por si ya subió
resultados, en vez de quedar "atascado" en `null` por 5 minutos. Solo se
cachea el resultado exitoso con datos.

**Riesgo:** bajo-medio. Es una caché en memoria del proceso Node — si hay
más de una instancia del backend corriendo (varios dynos/contenedores en
Railway), cada instancia tiene su propia caché, lo cual está bien (no
requiere coordinación, solo implica que el ahorro de queries es "por
instancia"). Si el artista actualiza sus métricas (ej. sincroniza analíticas
de Zernio) dentro de esa ventana de 5 minutos, el análisis de contenido
podría usar datos con hasta 5 minutos de antigüedad — aceptable dado que el
contexto de aprendizaje es agregado histórico, no un dato en tiempo real.

**Test que lo va a cubrir:** dos llamadas seguidas a
`fetchArtistLearningContext('mismo-id')` dentro de la ventana de 5 min deben
hacer que Supabase se consulte **una sola vez** (el mock cuenta cuántas
veces se invoca `.from()`). Una tercera llamada con `Date.now()` mockeado
más allá de los 5 minutos debe volver a consultar.

---

## Paso 5 — `jsonrepair` como red de seguridad al parsear la respuesta de Claude

**Archivo:** `src/services/aiService.js`, dentro de `analyzeContentStrategy`
(líneas 1519-1522 actuales):

### Estado actual

```js
    const raw = msg.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude no devolvió JSON en analyzeContentStrategy');
    const parsed = JSON.parse(jsonMatch[0]);
```

Si `JSON.parse` lanza (JSON válido en estructura general pero con un error
menor de sintaxis — coma colgante, comilla sin escapar dentro de un string,
etc.), la excepción no se atrapa aquí; sube al `catch` de la función
(línea ~1530) y se relanza como error 500 al controller
(`vidalisController.js:134`), y el usuario ya pagó 10 Sparks
(`deductSparks`, línea 97 del controller) sin recibir el análisis.

`jsonrepair` ya es una dependencia del proyecto (usada en
`src/app.js:112` para reparar JSON malformado de webhooks de n8n).

### Cambio propuesto

```js
    const raw = msg.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude no devolvió JSON en analyzeContentStrategy');

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Red de seguridad: Claude a veces devuelve JSON con errores menores de
      // sintaxis (coma colgante, comillas sin escapar). jsonrepair ya se usa
      // en app.js para el mismo tipo de problema con webhooks de n8n.
      parsed = JSON.parse(jsonrepair(jsonMatch[0]));
    }
```

Y agregar el `require` al inicio del archivo, junto a los demás imports
(línea 1-10 actuales):

```js
const { jsonrepair } = require('jsonrepair');
```

**Riesgo:** muy bajo. Cuando el JSON ya es válido (el caso normal, que es
prácticamente siempre dado que el prompt exige "EXCLUSIVAMENTE un objeto
JSON válido"), el comportamiento es idéntico a hoy — el `try` interno tiene
éxito y `jsonrepair` ni se invoca. Solo actúa como fallback en el caso raro
de JSON roto. Si `jsonrepair` tampoco puede arreglarlo, lanza su propio error
y cae en el mismo `catch` externo que hoy — incluso en el peor caso, el
comportamiento no empeora.

**Test que lo va a cubrir:** mock de `getAnthropic().messages.create` que
devuelve un JSON con una coma colgante (`{"score": 80,}`) → se espera que
`analyzeContentStrategy` devuelva el objeto parseado igual (sin lanzar). Un
segundo test confirma que con JSON ya válido el comportamiento no cambia
(mismo resultado que antes del cambio).

---

## Paso 6 — Instrucción de usar todo el rango 0-100 en el prompt

**Archivo:** `src/services/aiService.js`, dentro del `system_prompt` por
defecto de `analyzeContentStrategy` (dentro de `cfg.system_prompt`, dentro
del bloque `REGLA CRÍTICA DE SISTEMA` actual).

### Estado actual (fragmento relevante)

```js
    system_prompt: aiConfig.system_prompt || `Asumí el rol de un Estratega Principal de Contenido Viral en Vidalis AI. ...

FRAMEWORKS QUE DEBÉS APLICAR:
- HOOK-RETAIN-REWARD: ...
- AIDA: ...
- PAS: ...
- 3H (Hero/Hub/Hygiene): ...
- GATILLOS PSICOLÓGICOS: ...

REGLA CRÍTICA DE SISTEMA: Tu respuesta debe ser EXCLUSIVAMENTE un objeto JSON válido. Cero markdown, cero comillas invertidas, cero texto introductorio. Si incluís un solo carácter fuera del JSON, el pipeline fallará.`,
```

### Cambio propuesto

Agregar una línea nueva **antes** de la `REGLA CRÍTICA DE SISTEMA`, sin tocar
el resto del texto:

```js
    system_prompt: aiConfig.system_prompt || `Asumí el rol de un Estratega Principal de Contenido Viral en Vidalis AI. ...

FRAMEWORKS QUE DEBÉS APLICAR:
- HOOK-RETAIN-REWARD: ...
- AIDA: ...
- PAS: ...
- 3H (Hero/Hub/Hygiene): ...
- GATILLOS PSICOLÓGICOS: ...

CALIBRACIÓN DE SCORE: Usá el rango completo de 0 a 100 — no default a la franja "segura" de 50-70. Un video genuinamente débil debe recibir un score bajo (0-30) sin miedo, y un video excepcional debe recibir 90+. Evitá agrupar tus respuestas alrededor del promedio; cada score debe reflejar la calidad real de ESTE contenido específico, no una estimación conservadora.

REGLA CRÍTICA DE SISTEMA: Tu respuesta debe ser EXCLUSIVAMENTE un objeto JSON válido. Cero markdown, cero comillas invertidas, cero texto introductorio. Si incluís un solo carácter fuera del JSON, el pipeline fallará.`,
```

**Riesgo:** ninguno a nivel de código (es un cambio de texto puro dentro de
un template string ya existente). El único "riesgo" es de producto: cambia
sutilmente qué tan agresivo es el modelo puntuando — pero es exactamente lo
que pediste (usar rango 0-100).

**Nota:** este cambio de prompt es el único paso de los 6 que **no tiene un
test automatizado tradicional** (no se puede aseverar determinísticamente
qué score va a dar un LLM). Lo que sí puedo testear es que el string final
del `system_prompt` contiene la nueva instrucción (test de humo simple que
verifica que el texto se armó bien), y dejar constancia en el reporte final
de que la validación real de "los scores ahora varían más" requiere
observación en uso real con contenido variado — no es algo que un test
unitario pueda demostrar de forma determinística.

---

## Verificación final (después de los 4 pasos)

1. **Suite completa:** `npm test` — debe mostrar todos los test suites en
   verde, incluyendo los 2 ya existentes (`smoke.test.js`,
   `aiService.calibration.test.js`) más los nuevos de esta tanda.
2. **Revisión de que no se coló nada indebido al commit:**
   `git status --short` antes de cada `git add`, confirmando que
   `debug_ai.log` y `logs/combined1.log` (archivos de log que se
   modifican solos al correr la app/tests) **no** se incluyen en los commits
   — mismo cuidado que ya apliqué en el commit anterior (`bb81e3b`).
3. **Commits separados**, uno por paso (igual que en la tanda anterior):
   - `perf: parallelize artist learning context queries`
   - `perf: cache artist learning context for 5 minutes`
   - `fix: add jsonrepair fallback when parsing Claude's JSON response`
   - `docs: instruct the model to use the full 0-100 scoring range`
4. **Resumen que te voy a entregar al terminar**, con:
   - Tabla de los 4 commits (hash corto + mensaje).
   - Resultado de `npm test` (cuántos tests, todos verdes).
   - Un recordatorio de que la rama `feature/copilot-performance` sigue sin
     mergear — queda pendiente tu decisión de merge/PR/discard al final,
     igual que se hizo con la rama de verificación de email.

---

## Qué NO cambia en estos 4 pasos

- El contrato del endpoint `POST /analyze-content` (mismos parámetros de
  entrada, misma forma de respuesta).
- El modelo de IA, tokens o temperatura.
- El costo en Sparks.
- Los frameworks del prompt (HOOK-RETAIN-REWARD, AIDA, PAS, 3H) — solo se
  agrega una línea nueva sobre el rango de scoring (Paso 6).
- La lógica de calibración de los Pasos 1-2 (ya implementada y comiteada) —
  este documento no la vuelve a tocar.

---

¿Apruebas estos 4 pasos tal como están especificados? Si quieres que ajuste
algo (por ejemplo el TTL de 5 minutos del Paso 4, o el texto exacto del
Paso 6), dímelo y actualizo el documento antes de tocar código.
