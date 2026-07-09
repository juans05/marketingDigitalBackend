# Diseño: Repurposer escalable — subida directa + RabbitMQ + workers

**Fecha:** 2026-07-08
**Repos involucrados:** `marketingDigitalBackend` + `marketingDigitalFrontend` + `python-services`
**Reemplaza/extiende:** [2026-07-06-repurposer-design.md](2026-07-06-repurposer-design.md)

---

## 0. Contexto y motivación

La v1 del Repurposer funciona pero no escala: el video fuente entra **por el
servicio** (navegador → Python → nube), el pipeline corre **fire-and-forget en
el proceso de Node** (si Node reinicia/deploya, se pierden los jobs en curso), y
la concurrencia se limitaba con un semáforo en un solo proceso. Eso aguanta
decenas de usuarios, no 200-1000.

Esta v2 rediseña el almacenamiento y la ejecución para **escalar en horizontal
desde el día 1**, reutilizando casi todo el código de pipeline ya existente
(`aiService.detectSegments`, `generateClips`, el `/cut` de Python). El cambio
grande es **dónde entra el archivo** (directo a R2) y **dónde corre el
pipeline** (un worker que consume de una cola durable, no en el API).

### Decisiones tomadas (cerradas en brainstorming)

| Decisión | Resultado |
|---|---|
| ¿Dónde se guarda el video **fuente**? | **R2 (todos)**. El fuente nunca se le muestra al usuario (solo lo leen Gemini y ffmpeg), así que Cloudinary no aporta nada. Se elimina la regla de "30 min". |
| ¿Dónde se guardan los **clips**? | **Cloudinary** (cortos, se entregan al usuario, aprovechan transforms/CDN). |
| ¿Cómo entra el archivo? | **Subida directa a R2** con URL prefirmada. El archivo **no cruza** el backend. |
| ¿Cómo corta ffmpeg el fuente? | **Opción A**: `ffmpeg -ss <inicio> -to <fin> -i <url R2> -c copy` — lee por rango HTTP, solo baja el segmento del clip, no el video completo. |
| ¿Cómo se ejecuta el pipeline? | **Cola RabbitMQ + workers de Node** (competing consumers, escalan por réplicas). |
| ¿Reintentos? | El fuente vive en R2; el worker re-lee de ahí. **El cliente nunca re-sube.** |
| Nivel de ambición | **Escalable desde el día 1** (no MVP con semáforo). |

---

## 1. Arquitectura

```
Navegador ──① presign──► API (Node, delgado) ──④ publish──► RabbitMQ (repurpose.jobs, durable)
   │  ▲ ② uploadUrl          │ ③ registra                          │ ⑤ consume (competing)
   │  └────────────┐         └──► Supabase (fila padre: queued)     ▼
   └──② PUT directo─┼──► ☁ R2 (fuente)                        Worker 1..N (Node) ── escalan
      (no toca      │        ▲ lee por rango (retry incluido)       │ ⑥ pipeline:
       el server)   │        │                                      │  a ffprobe (≤2h)
                    │        └──────────────────────────────────────┤  b Gemini → capítulos
                    │                                                │  c POST /cut → Python
                    │                          Media svc (Python) ◄──┘  d Claude → score
                    │                          /cut sin estado         e INSERT clips (DB)
                    │                          ffmpeg -ss -i <R2> ──► ☁ Cloudinary (clips)
                    └── ⑦ poll GET /clips/:id ◄── API
```

Diagrama visual: `docs/repurposer-arch.html`.

### Piezas y responsabilidad

- **API (Node)** — delgado, sin estado, escala por réplicas. Firma URLs de
  subida, crea la fila padre, **publica** el job en RabbitMQ, sirve estado. No
  procesa video.
- **RabbitMQ** — broker de mensajes. Cola durable `repurpose.jobs` + una
  dead-letter queue `repurpose.jobs.dlq`.
- **Workers (Node)** — proceso(s) aparte, competing consumers, escalan por
  réplicas. Corren el pipeline completo (el mismo `generateClips` de hoy,
  movido al contexto del worker).
- **Media service (Python)** — `/cut` sin estado, escala por réplicas. Corta con
  ffmpeg leyendo de R2 y sube clips a Cloudinary. Se le quita todo el
  almacenamiento local.

---

## 2. Almacenamiento

### 2.1 R2 (fuentes)
- Bucket: `R2_BUCKET_NAME` (ya en `.env`). Endpoint S3-compatible:
  `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.
- Key: `repurposer/sources/{artistId}/{uuid}.{ext}`.
- URL pública para lectura (Gemini + ffmpeg): `${R2_PUBLIC_URL}/{key}`.
- **CORS del bucket**: permitir `PUT` desde el origen del frontend (dominio de
  producción + `http://localhost:5173` en dev). Headers: `PUT`, `Content-Type`.

### 2.2 Cloudinary (clips)
- Sin cambios respecto a hoy: `cloudinary.uploader.upload(resource_type="video",
  folder="vidalis/{artistId}/clips")` en el `/cut` de Python.

### 2.3 Ciclo de vida del fuente
- El fuente **permanece en R2** durante todos los reintentos del job.
- Se borra **solo tras el ack de éxito** del job (o vía lifecycle rule de R2 con
  expiración N días — a definir en implementación). Nunca se borra antes de que
  el job termine OK.

---

## 3. Backend Node

### 3.1 Endpoint nuevo: `POST /vidalis/repurpose/presign`
```
Body: { artistId, filename, contentType }
Resp: { uploadUrl, sourceUrl, key }
```
- Valida artista + plan/Sparks (mismo middleware que el resto de Vidalis).
- Genera URL prefirmada de `PUT` a R2 con `@aws-sdk/client-s3` +
  `@aws-sdk/s3-request-presigner` (dependencias nuevas). Expiración corta
  (ej. 10 min).
- Devuelve también la `sourceUrl` pública final (la que quedará tras el PUT).

### 3.2 Endpoint adaptado: `POST /vidalis/repurpose/upload`
```
Body: { artistId, sourceUrl, title }   // ya NO recibe archivo
```
- Crea la fila padre en `videos` (`status: 'queued'`).
- **Publica** `{ parentVideoId }` en RabbitMQ (`repurpose.jobs`) en vez del
  `generateClips(...).catch()` fire-and-forget actual.
- Responde `{ videoId }` de inmediato.
- La validación de duración (≤2h) se mueve al worker (paso `a`), que hace
  `ffprobe` sobre la URL de R2. (Hoy `durationSeconds` llegaba `null`; ya no se
  depende del cliente para eso.)

### 3.3 Publisher de RabbitMQ: `src/lib/queue.js` (nuevo)
- Conexión `amqplib` a `RABBITMQ_URL` (nueva env), con reconexión.
- `publishRepurposeJob(parentVideoId)` — publica en la cola durable con
  `persistent: true`.
- Declara `repurpose.jobs` (durable) con `x-dead-letter-exchange` apuntando a la
  DLQ, y `repurpose.jobs.dlq`.

### 3.4 Worker: `src/workers/repurposeWorker.js` (nuevo, proceso aparte)
- Consume `repurpose.jobs` con `prefetch(N)` (N configurable, controla
  concurrencia por worker — reemplaza el semáforo).
- Por mensaje: ejecuta `generateClips(parentVideoId)`; si termina OK → `ack`; si
  lanza → `nack` sin requeue directo (RabbitMQ lo manda a la DLQ tras los
  reintentos configurados).
- Se arranca como servicio independiente en Railway (`node
  src/workers/repurposeWorker.js`), escalable en réplicas.

### 3.5 `generateClips` — cambios
- **Idempotencia**: al inicio, **borra las filas hijas** (`parent_video_id =
  parentVideoId`) antes de regenerar — eso es lo que garantiza que un reintento
  no duplique en la galería. Los clips huérfanos que puedan quedar en Cloudinary
  son solo costo (no afectan correctitud); su limpieza se resuelve aparte
  (guardar `public_id` en `ai_clips_data` y borrar, o lifecycle) — ver §11.
- Ya usa Opción A: pasa `source_url` (URL de R2) al `/cut` de Python (se elimina
  el hack `source_url.split('/').pop()` y el paso de `video_id` local).
- Se elimina el fallback `buildClipUrl` de Cloudinary-por-URL (solo servía para
  fuentes en Cloudinary; ya no aplica). El `/cut` de Python es el único camino.

---

## 4. Media service (Python)

### 4.1 Se elimina
- Endpoint `/upload`, el mount `app.mount("/static", ...)`, `STATIC_DIR` /
  `VIDEOS_DIR` y todo el almacenamiento local de fuentes. Ya no entran archivos
  por el servicio → desaparece de raíz el problema del watcher / `WinError
  10055` / disco lleno.
- (Los endpoints de scraper quedan intactos.)

### 4.2 `/cut` — se mantiene y ajusta
```
Body: { source_url, segments: [{start, end, title}], artist_id }
```
- Por cada segmento: `ffmpeg -ss <start> -to <end> -i <source_url> -c copy
  <clip_temp>` (temp en carpeta del SO, no en el proyecto), sube a Cloudinary,
  borra el temp.
- El trabajo pesado corre en **threadpool** (endpoint `def` o
  `run_in_threadpool`) para que cada réplica atienda cortes concurrentes sin
  bloquear el event loop.
- Devuelve `{ clips: [{ title, start, end, secure_url, duration, status? }] }`
  como hoy.

---

## 5. Frontend (`RepurposerView.jsx`)

Nuevo flujo de subida (reemplaza la llamada a Python `/upload`):
1. `POST ${API}/api/vidalis/repurpose/presign { artistId, filename, contentType }`
   → `{ uploadUrl, sourceUrl }`.
2. `PUT` del archivo **directo a `uploadUrl`** (R2) vía `XMLHttpRequest` con
   `upload.onprogress` (misma UX de barra de progreso que hoy).
3. `POST ${API}/api/vidalis/repurpose/upload { artistId, sourceUrl, title }`.
4. Poll de `GET ${API}/api/vidalis/clips/:parentId` hasta `status: ready`.

Se elimina `VITE_CLIPPER_SERVICE_URL` del frontend (el navegador ya no habla con
el servicio Python; solo con el API y con R2).

---

## 6. Concurrencia y escala

- **Throughput** = nº de workers × `prefetch`. Se escala agregando réplicas del
  worker; RabbitMQ reparte (competing consumers). Sin semáforos manuales.
- **API y media service**: sin estado → réplicas detrás del load balancer de
  Railway.
- **Aislamiento por cuenta**: keys con `{artistId}/{uuid}`; cada job trae su
  `artist_id` y `source_url`; sin estado global compartido → subidas concurrentes
  de distintas cuentas nunca se pisan.
- **Techo real: Gemini.** CPU/ancho de banda/jobs dejan de ser el límite. El
  costo y cuota de Gemini analizando videos de 1-2h es el techo. Optimización
  futura (fuera de alcance, ver §9): detectar capítulos con **solo el audio**.

---

## 7. Manejo de errores y confiabilidad

- **Job falla** → `nack` → reintentos de RabbitMQ → si agota, va a la **DLQ**
  (`repurpose.jobs.dlq`) para inspección/alerta, sin bloquear la cola.
- **Reintento** → worker re-lee el fuente de R2 (el cliente no re-sube);
  `generateClips` es idempotente (borra hijos previos antes de regenerar).
- **detectSegments falla del todo** → fila padre `status: 'failed'` +
  `error_log`; la UI muestra el error y permite reintentar (re-encola).
- **Falla un segmento puntual** (corte o score) → se omite ese clip, el batch
  continúa (comportamiento actual).
- **Video > 2h** (paso `a`, ffprobe) → `status: 'failed'` con mensaje claro, sin
  gastar Gemini.
- **Fuente > tope de tamaño** en R2 → rechazado en el `presign`/PUT (límite de
  R2 configurable).

---

## 8. Testing

- **Node unit**: `presign` arma una URL de R2 válida; `queue.publishRepurposeJob`
  publica en la cola correcta (mock de `amqplib`); `generateClips` borra hijos
  previos antes de regenerar (idempotencia).
- **Node integración**: encolar → worker procesa → se crean filas hijas con
  `parent_video_id` y `viral_score_real` (mock Gemini/Claude/Cloudinary/`/cut`).
- **Python unit**: `/cut` construye el comando ffmpeg correcto con `source_url`
  como input (mock `subprocess` + `cloudinary`); limpieza de temporales.
- **Reintento idempotente**: reprocesar el mismo `parentVideoId` no duplica
  clips.
- Reusa los patrones de `tests/unit/aiService.*.test.js`.

---

## 9. Infra

- **RabbitMQ** managed (CloudAMQP o add-on de Railway) → `RABBITMQ_URL`.
- Servicio **worker** de Node en Railway (`src/workers/repurposeWorker.js`),
  réplicas escalables.
- **R2**: configurar CORS del bucket para el `PUT` directo.
- Envs nuevas: `RABBITMQ_URL`, `WORKER_PREFETCH` (default 2). R2 ya está en
  `.env` (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET_NAME`, `R2_PUBLIC_URL`).

---

## 10. Milestones de implementación

Cada milestone se puede implementar y probar por separado.

1. **M1 — Subida directa a R2**: endpoint `presign` (Node) + PUT directo en el
   frontend + CORS del bucket. Resultado: el fuente llega a R2 sin pasar por el
   servidor. (El pipeline puede seguir corriendo como hoy temporalmente.)
2. **M2 — Cola + worker**: `queue.js` + `repurposeWorker.js` + RabbitMQ; el
   `/upload` pasa a publicar en vez de fire-and-forget; idempotencia en
   `generateClips`. Resultado: jobs durables, no se pierden en deploy, escalan.
3. **M3 — Limpieza del media service**: quitar `/upload`, `/static` y storage
   local en Python; `/cut` en threadpool; `generateClips` pasa `source_url` a
   `/cut`. Resultado: Python sin estado y sin disco.
4. **M4 — Frontend final**: `RepurposerView` con el flujo presign→PUT→registrar;
   quitar `VITE_CLIPPER_SERVICE_URL`. Resultado: UX completa end-to-end.

---

## 11. Fuera de alcance (v1 de esta v2)

- Detección de capítulos por **audio-only** (optimización de costo/cuota de
  Gemini) — siguiente paso natural cuando el volumen lo justifique.
- **Supabase Realtime** en vez de polling para el estado.
- **Borrado automático** del fuente en R2 tras generar clips (se puede resolver
  con lifecycle rules de R2 mientras tanto).
- Mover **clips** a R2 (siguen en Cloudinary por ser cortos y entregarse al
  usuario).
- **Limpieza de clips huérfanos** en Cloudinary tras un reintento (persistir
  `public_id` y borrar) — hoy solo se garantiza no duplicar en la galería.
- Autoescalado dinámico de workers según profundidad de la cola (se puede
  agregar después con métricas de RabbitMQ).
