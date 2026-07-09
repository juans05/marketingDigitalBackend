# Diseño: Repurposer (sección nueva dentro de Vidalis)

**Fecha:** 2026-07-06
**Repos involucrados:** `marketingDigitalBackend` (este repo) + `marketingDigitalFrontend`
**Decisión de producto:** Repurposer NO es un producto/dominio separado. Es una
sección nueva dentro del Vidalis existente — mismo login, mismo billing de
Sparks, mismo tema visual, mismo backend. Si el uso futuro demuestra que el
público (creadores solo) es genuinamente distinto, se puede spinear a marca
propia más adelante; eso no se decide ahora.

---

## 1. Qué hace el producto

Usuario sube un video largo (podcast, entrevista, stream, 30min–2h) →
Repurposer detecta automáticamente los mejores capítulos/segmentos → genera un
clip corto por cada segmento → puntúa cada clip → **le dice al usuario cuál
clip es el mejor** (esto último es el punto central del producto, no un
detalle secundario).

---

## 2. Principio rector: reutilizar, no duplicar

Todo lo que ya existe en Vidalis se reutiliza tal cual:

| Necesidad | Se reutiliza | Se construye nuevo |
|---|---|---|
| Guardar el video y sus clips | Tabla `videos` (self-referencing vía `parent_video_id`, ya existe en `update_db_for_clips.sql`, sin usar hasta hoy) | — |
| Metadata de cada clip (start/end, razón) | Columna `ai_clips_data JSONB` (ya existe, sin usar) | — |
| Transcripción con timestamps | Llamada Gemini ya usada en `aiService.processVideoAI` | — |
| Puntuar cada clip | `generateCopyWithClaude()` en `aiService.js:808` (el mismo mecanismo que ya puntúa el video completo — basado en transcripción, calibrado con `calibrateScore100`) aplicado al fragmento de transcripción de cada segmento | — |
| Cortar el video en clips | Transformación de URL de Cloudinary (`so_/eo_`) sobre el `source_url` ya subido | Helper `buildClipUrl()` |
| Auth, billing (Sparks), artist/agency model | Middleware y servicios existentes | — |
| Elegir los mejores segmentos de un video largo | — | **Nuevo**: prompt a Claude sobre transcripción+timestamps |
| Ranking / "cuál es el mejor" | — | **Nuevo**: ordenar por score y marcar el top en la respuesta |
| UI de upload/galería | Patrones de `UploadSection.jsx`, `VideoGallery.jsx`, `ContentCopilot.jsx` | **Nuevo**: `RepurposerView.jsx` |

No se agrega: FFmpeg, cola/queue nueva, base de datos nueva, servicio de IA
independiente, dominio/frontend separado.

**Nota sobre el scoring — por qué NO se usa `/visual-score`:** se investigó
`scoreVisualVirality()` ([aiService.js:1577](src/services/aiService.js#L1577))
y solo analiza un **frame/thumbnail estático** extraído del video
(`extractVideoThumbnail`), evaluando gancho visual, calidad, thumbnail power,
etc. — no analiza la transcripción ni el contenido hablado. Como los capítulos
se eligen justamente por su contenido hablado, dos clips con un frame visual
parecido (mismo speaker, mismo fondo) recibirían un score similar aunque uno
tenga contenido mucho mejor. Por eso se usa el mecanismo basado en
transcripción (`generateCopyWithClaude`) en su lugar — ver sección 3.2.

---

## 3. Backend

### 3.1 Endpoint nuevo

```
POST /vidalis/repurpose/upload
Body: { artistId, sourceUrl, title }
```
- Crea la fila padre en `videos` (`status: 'processing'`, `source_url` = URL
  larga ya subida a Cloudinary vía el flujo de firma existente).
- Valida duración/tamaño (tope 2h, alineado a `PROJECT_REPURPOSER.md`) antes de
  disparar el pipeline, para no gastar transcripción en videos fuera de rango.
- Dispara el pipeline de forma async (mismo patrón fire-and-forget que
  `registerVideo` usa hoy) y responde de inmediato con `{ videoId }`.

### 3.2 Servicio nuevo: `src/services/repurposerService.js`

- `detectSegments(transcript, durationSeconds)` — prompt a Claude con la
  transcripción + timestamps, devuelve `[{ start, end, title, reason }]`
  (3–8 segmentos; el número exacto lo decide el modelo según el contenido, no
  un valor fijo).
- `buildClipUrl(sourceUrl, start, end)` — arma la URL de Cloudinary recortada
  (`so_<start>,eo_<end>`), sin procesar video en el servidor.
- `generateClips(parentVideoId)` — orquesta todo:
  1. Lee la fila padre, transcribe (reusa la llamada Gemini existente).
  2. `detectSegments(...)`.
  3. Por cada segmento: `buildClipUrl(...)` → INSERT fila hija en `videos`
     (`parent_video_id`, `source_url` = URL recortada, `ai_clips_data` = `{start,
     end, title, reason}`) → recorta la porción de `transcript` correspondiente
     a `[start, end]` → `generateCopyWithClaude(geminiAnalysis, transcriptSlice,
     segmentTitle, platforms, artistContext, learningContext)` → guarda
     `copy.viral_score` en `viral_score_real` (el copy/hashtags que devuelve de
     paso quedan guardados en `ai_clips_data` como borrador, sin construir UI
     para editarlos todavía — ver sección 7).
  4. Si un segmento falla (score o URL), se salta y se continúa con los demás
     — no se cae el batch completo.
  5. Al terminar, marca la fila padre `status: 'ready'` (o `'failed'` si la
     transcripción/detección de segmentos falla por completo, con detalle en
     `error_log`, columna ya existente).

### 3.3 Cambio mínimo en endpoint existente

`GET /vidalis/clips/:parentId` (ya existe, `vidalisController.getClips` →
`vidalisService.getClipsByParent`): se modifica la respuesta para **ordenar
por `viral_score_real` descendente** y marcar el primero con `isBest: true`.
No se agrega endpoint nuevo ni columna nueva — el ranking se calcula al leer,
no se persiste.

---

## 4. Frontend (`marketingDigitalFrontend`)

Confirmado por mockup visual (aprobado por el usuario) — tema oscuro real de
Vidalis (`--bg-primary: #0A0A0B`, `--primary: #4F46E5`, `--accent: #7C3AED`,
de `src/index.css`), no el tema claro/violeta descrito originalmente en
`STITCH_PROMPT.md` para un Repurposer "producto aparte".

### 4.1 Navegación

Nuevo ítem "🎬 Repurposer" en el sidebar de `Dashboard.jsx`, siguiendo el
patrón `activeView`/`setActiveView` ya usado por `ContentCopilot`,
`GrowthToolsView`, etc. No reemplaza ni reordena las secciones existentes.

### 4.2 Componente nuevo: `RepurposerView.jsx`

Tres estados dentro del mismo componente (no son 3 rutas separadas):

1. **Upload** — drop zone (reusa el patrón de firma+subida de Cloudinary de
   `UploadSection.jsx`), texto de formatos soportados y tope de 2h, aviso de
   plan/Sparks disponibles.
2. **Procesando** — mientras `status === 'processing'`, poll del video padre
   (mismo patrón de polling ya usado en otras vistas). Checklist visual de
   pasos: Transcribiendo → Detectando capítulos → Generando clips → Puntuando.
3. **Galería de clips** — `GET /vidalis/clips/:parentId`, ordenado por score.
   El clip con `isBest: true` se muestra destacado **arriba y separado** de la
   grilla (borde violeta, badge "⭐ Mejor clip"), no solo con un badge de score
   igual que los demás. El resto en grilla de 3 columnas con thumbnail,
   duración, score con color (verde ≥80, ámbar 50-79, gris <50), plataformas y
   acciones (Preview, Publicar).

### 4.3 Llamadas a API

Mismo patrón que `ContentCopilot.jsx`: `fetch(`${API}/api/vidalis/...`)` con
el JWT existente. Sin cliente HTTP nuevo.

---

## 5. Manejo de errores

- Transcripción o detección de segmentos falla por completo → `status:
  'failed'` + `error_log`, la UI muestra el error y permite reintentar.
- Falla el score o el recorte de un segmento puntual → se omite ese clip, el
  resto del batch continúa.
- Validación de duración/tamaño en el upload, antes de gastar en transcripción.

---

## 6. Testing

- Unit: `detectSegments` (parseo de la respuesta de Claude a `[{start,end,...}]`,
  incluyendo respuesta malformada) y `buildClipUrl` (URL de Cloudinary correcta
  para distintos start/end, incluyendo bordes en 0 y en la duración total).
- Integración: `POST /vidalis/repurpose/upload` con video mock → verifica que
  se crean filas hijas con `parent_video_id` y `viral_score_real` poblado
  (mockeando Claude/Gemini/Cloudinary/`generateCopyWithClaude`).
- Reusa los patrones ya existentes en `tests/unit/aiService.*.test.js`.

---

## 7. Fuera de alcance (explícitamente, para esta primera versión)

- FFmpeg / procesamiento de video propio.
- Subtítulos automáticos, watermark, reencuadre 9:16 real (Cloudinary puede
  hacer transformaciones adicionales después si se necesita, pero no es parte
  de este diseño).
- Publicación automática a redes desde Repurposer (se puede enganchar al flujo
  de publish existente de Vidalis después).
- Frontend/dominio separado (`repurposer.com`) — ver "Decisión de producto" al
  inicio de este documento.
