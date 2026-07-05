# Plan: Mejora de Performance y Corrección del Scoring — AI Content Copilot

**Fecha:** 2026-07-04
**Rama:** `feature/copilot-performance` (creada desde `main`)
**Endpoint afectado:** `POST /api/vidalis/analyze-content`
**Archivos principales:** `src/services/aiService.js`, `src/controllers/vidalisController.js`

Este documento describe, paso a paso, qué se va a cambiar y por qué, para que
puedas revisar cada punto antes de que lo implemente. No he tocado código de
producción todavía (solo traje el tooling de tests de la otra rama).

---

## Parte 1 — Por qué "casi todos los videos" reciben un score parecido

Esto es lo más importante y lo que probablemente notaste. Encontré **un bug
real de mezcla de escalas** en la calibración del score, más dos problemas de
diseño que aplanan los resultados. Es la causa más probable de que el Copilot
te devuelva números parecidos sin importar el contenido.

### 1.1 — Bug de escalas: 0-10 vs 0-100 (el más grave)

- El prompt le pide a Claude un score en escala **0-100** (`aiService.js:1449`:
  `"score": <número entero 0-100...>`).
- Pero la función que calibra ese score con datos reales,
  `calibrateScore100()` ([aiService.js:408-417](src/services/aiService.js#L408-L417)),
  hace esto:
  ```js
  function calibrateScore100(rawScore100, learningContext, platform) {
    const raw10 = rawScore100 / 10;              // 85 → 8.5
    const result = calibrateScore(raw10, learningContext, platform); // calibra en escala 1-10
    return {
      score: Math.max(0, Math.min(100, result.score * 10)), // vuelve a *10
      ...
    };
  }
  ```
- El problema está dentro de `calibrateScore()` ([aiService.js:337-402](src/services/aiService.js#L337-L402)),
  línea 380-381:
  ```js
  adjusted = Math.max(1, Math.min(10, parseFloat(adjusted.toFixed(1)))); // clamp a 1-10
  adjusted = Math.round(adjusted); // ⚠️ redondea a ENTERO (1,2,3...10)
  ```
  Esto colapsa el score a **solo 10 valores posibles** (1 a 10) antes de
  multiplicarlo de nuevo por 10. Es decir: aunque Claude te dé 87 en un video y
  62 en otro, ambos se convierten a `8.7` y `6.2`, se **redondean a enteros**
  (`9` y `6`), y se multiplican de nuevo (`90` y `60`). Se pierde toda la
  granularidad fina del 0-100 — el score final SIEMPRE termina en un múltiplo
  de 10 (0, 10, 20, ..., 100).
- Además, la "regresión a la media" (línea 369-377) empuja cualquier score,
  sea cual sea, hacia el promedio histórico del artista cuando hay pocos
  datos — con **menos de 15 posts analizados**, el score se mezcla
  fuertemente con `historicalAvg`. Si el artista tiene pocos videos con
  métricas reales (`totalPostsAnalyzed < 15`, el caso típico), *todos* los
  scores nuevos se acercan al mismo promedio histórico sin importar qué tan
  bueno o malo sea el contenido nuevo.

**Efecto combinado:** videos claramente distintos (uno mediocre, uno muy
bueno) terminan con scores que (a) solo pueden ser múltiplos de 10, y (b) se
jalan hacia el mismo promedio histórico si el artista tiene pocos datos. Esto
explica el patrón "casi todos los videos salen parecido".

**Corrección propuesta:**
- Hacer que `calibrateScore100` calibre **directamente en escala 0-100**, sin
  pasar por una conversión a 1-10 con redondeo a entero. El clamp final debe
  ser `Math.max(0, Math.min(100, Math.round(adjusted)))` (entero 0-100, no
  0-10) — esto solo restaura 91 valores posibles, no 10.
- Suavizar el peso de la regresión a la media para que no domine con pocos
  datos (actualmente a 5 posts ya pesa 33%, a 10 posts pesa 67%). Propongo
  bajar el techo de la ventana de 15 a **30 posts** para que la regresión sea
  más gradual y el score nuevo pese más al principio.

### 1.2 — El prompt no fuerza suficiente contraste

Revisando el prompt completo ([aiService.js:1360-1364](src/services/aiService.js#L1360-L1364)),
los criterios de scoring están bien redactados (5 bandas claras de 0-100), pero:
- No hay ningún **ejemplo concreto** de un score bajo vs alto para anclar al
  modelo — los LLMs tienden a regresión a la media cuando no tienen anclas
  duras.
- El texto le pide "frialdad analítica" y "no seas complaciente", lo cual es
  correcto, pero no incluye una instrucción explícita de **usar todo el rango
  0-100** y evitar la tendencia común de los modelos a agruparse alrededor de
  50-70.

**Corrección propuesta (opcional, de bajo riesgo):** agregar una línea al
`system_prompt` pidiendo explícitamente distribuir los scores en todo el
rango y evitar default a la franja media "segura". Esto es un cambio de texto
puro, sin riesgo técnico, y lo dejaría como el último paso — quiero tu visto
bueno porque toca el copy exacto que ve la IA.

### 1.3 — Qué NO voy a tocar del prompt

El resto del prompt (frameworks HOOK-RETAIN-REWARD, AIDA, PAS, 3H, gatillos
psicológicos, la exigencia de JSON puro) está bien estructurado y no lo veo
como causa del problema. No planeo reescribirlo, solo:
1. Arreglar el bug de escala (1.1) — esto es código, no prompt.
2. Añadir una línea sobre usar todo el rango (1.2) — cambio de texto mínimo,
   con tu aprobación.

---

## Parte 2 — Performance (lo que pediste originalmente)

### 2.1 — Paralelizar las 4 queries de `fetchArtistLearningContext`

Archivo: `src/services/aiService.js:120-153`.

Hoy las 4 consultas a Supabase (perfil de artista, top-10 posts, 100
snapshots, insights log) se hacen con `await` una tras otra — cada una
espera a que termine la anterior sin necesidad, ya que no dependen entre sí.

**Cambio:** envolver las 4 en `Promise.all([...])` para que viajen en
paralelo. Reduce esa sección de ~400-800ms a ~150-200ms (el tiempo de la
consulta más lenta, no la suma de las 4).

### 2.2 — Caché de 5 minutos por artista

Mismo archivo. Actualmente cada análisis vuelve a ejecutar las 4 queries
desde cero, aunque el usuario analice 5 ideas seguidas para el mismo artista
en un par de minutos — los datos históricos no cambian tan rápido.

**Cambio:** agregar una caché en memoria con TTL de 5 minutos, keyed por
`artistId`, siguiendo el mismo patrón que ya usa `_globalCalibrationCache`
([aiService.js:264-265](src/services/aiService.js#L264-L265)) para la
calibración global. Un análisis repetido del mismo artista dentro de la
ventana de 5 min se ahorra las 4 queries por completo.

### 2.3 — Evitar la query duplicada de `artists`/`videos`

El controller ([vidalisController.js:100-107](src/controllers/vidalisController.js#L100-L107))
ya consulta `artists` (nombre, tono) y `videos` (historial reciente) para
armar `artistContext`. El servicio, dentro de `fetchArtistLearningContext`,
vuelve a consultar `artists` (con más columnas: género, audiencia, ADN
creativo) y `videos` (con más columnas: hashtags, copy, analytics).

Las columnas que pide cada uno son distintas, así que no es 100% duplicado,
pero sí se puede evitar el segundo `SELECT` a `artists` reutilizando el ya
hecho en el controller si le pasamos las columnas que faltan. **Decisión: NO
lo voy a fusionar en este cambio** — el riesgo de tocar el contrato entre
controller y servicio no vale el ahorro (~50-100ms de una sola query
pequeña), comparado con las ganancias de 2.1 y 2.2. Lo dejo documentado por
si en el futuro se quiere optimizar más.

### 2.4 — Fallback con `jsonrepair` al parsear la respuesta de Claude

Archivo: `src/services/aiService.js:1477-1480`.

Hoy, si Claude devuelve un JSON con un error de formato menor (coma de más,
comilla sin escapar), `JSON.parse` falla y toda la función lanza un error
500 — el usuario pierde los 10 Sparks que ya se descontaron
([vidalisController.js:97](src/controllers/vidalisController.js#L97)) sin
recibir el análisis.

El proyecto ya usa `jsonrepair` en otra parte del código
([app.js:112](src/app.js#L112)) para el mismo tipo de problema con webhooks
de n8n.

**Cambio:** si `JSON.parse(jsonMatch[0])` falla, intentar
`JSON.parse(jsonrepair(jsonMatch[0]))` antes de lanzar el error. Esto no
cambia el comportamiento cuando el JSON ya es válido (que es el caso normal);
solo agrega una red de seguridad para el caso raro de JSON malformado.

---

## Parte 3 — Plan de implementación (TDD, paso a paso)

Voy a seguir TDD: por cada cambio, escribo primero el test que falla (RED),
luego el código mínimo para que pase (GREEN), corro la suite completa, y
recién ahí hago commit. Esto es lo que voy a hacer, en este orden:

| # | Paso | Archivo(s) | Test que lo cubre |
|---|------|-----------|-------------------|
| 1 | Fix escala: `calibrateScore100` calibra en 0-100 sin redondeo intermedio a 1-10 | `aiService.js` (función `calibrateScore100` y ajuste del clamp en `calibrateScore`) | Test: dos raw scores distintos (ej. 62 y 87) con el mismo `learningContext` deben producir salidas distintas y NO ambas terminar en múltiplo de 10 |
| 2 | Suavizar regresión a la media (ventana 15→30 posts) | `aiService.js` (línea 369, `regressionWeight`) | Test: con `totalPostsAnalyzed=10`, el peso hacia la media debe ser menor que antes |
| 3 | Paralelizar las 4 queries de `fetchArtistLearningContext` | `aiService.js:120-153` | Test: mock de Supabase cuenta que las 4 promesas se lanzan antes de que cualquiera resuelva (o simplemente se verifica que el resultado sigue siendo correcto con `Promise.all`) |
| 4 | Caché TTL 5 min por artista | `aiService.js` (nueva variable de caché junto a `fetchArtistLearningContext`) | Test: dos llamadas seguidas con el mismo `artistId` dentro de 5 min → Supabase se consulta una sola vez |
| 5 | `jsonrepair` como fallback de parseo en `analyzeContentStrategy` | `aiService.js:1477-1480` | Test: respuesta de Claude con JSON ligeramente roto → igual se parsea y devuelve resultado, no lanza error |
| 6 (opcional, con tu OK) | Línea en el prompt pidiendo usar todo el rango 0-100 | `aiService.js` (`system_prompt` dentro de `analyzeContentStrategy`) | No aplica test automatizado (es texto de prompt) — se revisa manualmente el copy antes de commitear |

Cada paso es un commit separado, así puedes revisar el diff de cada uno
individualmente si quieres (`git log` en la rama `feature/copilot-performance`
mostrará cada commit por separado).

---

## Lo que NO voy a cambiar

- El modelo de IA usado (`claude-haiku-4-5-20251001`) ni los tokens/temperatura.
- El contrato del endpoint (`POST /analyze-content`) — mismos parámetros de
  entrada, misma forma de respuesta JSON.
- El costo en Sparks (10 por análisis).
- Los frameworks del prompt (HOOK-RETAIN-REWARD, AIDA, PAS, 3H).
- La query duplicada del punto 2.3 (documentada pero no resuelta ahora).

## Cómo lo vas a poder verificar

- Cada commit trae su propio test en verde (`npm test`).
- Al final corro la suite completa y te muestro el resultado.
- Puedes revisar `git log --oneline feature/copilot-performance` y
  `git show <hash>` de cada commit antes de decidir mergear.
- No voy a mergear ni hacer push sin que me confirmes.

---

¿Apruebas este plan tal como está? En particular necesito tu OK explícito
para:
1. El fix de escala (1.1) — es un cambio de comportamiento real en los
   números que ve el usuario (scores más variados/precisos que antes).
2. Si quieres que incluya el paso 6 (línea nueva en el prompt) o prefieres
   dejar el texto del prompt intacto por ahora.
