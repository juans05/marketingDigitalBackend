# Plan de Implementación: Integración Completa de Zernio en Vidalis.AI

Este documento detalla la planificación y el diseño técnico para la integración de la API de **Zernio** (`https://zernio.com/api/v1`) en la plataforma **Vidalis.AI** como un nuevo proveedor de publicación y automatización conversacional (`publish_mode = 'zernio'`).

El plan está diseñado de manera modular y sumamente detallada para permitir el desarrollo en paralelo o su avance a través de agentes automatizados de IA.

> ### 🔎 Estado de Validación (revisión técnica 2026-06-13)
> Este plan fue **contrastado contra el código real** del backend. La arquitectura es sólida y la mayoría de supuestos son correctos (columnas `ayrshare_profile_key`/`social_keys`/`publish_mode`/`ayrshare_post_id`, `buildCloudinaryUrl`, `getSocialStatus`, middleware `authorizeArtist`). Se incorporaron correcciones en los puntos marcados con ⚠️ a lo largo del documento:
> 1. **`accountId` por plataforma** — antes no se definía de dónde salía; ahora fluye vía `options.accounts` desde `social_keys` (Sección 2.B y 3).
> 2. **Colisión de `ayrshare_profile_key`** al cambiar de modo — discriminación por prefijo `prof_` (Estrategia de DB y Sección 3).
> 3. **Bug del logger** — `logger.log()` no existe en el winston actual; usar `logger.error/info` (Sección 2 y Seguridad).
> 4. **Webhook HMAC sobre body crudo** + nombres de payload por confirmar (Sección 4.13).
> 5. **`social_keys` específico de zernio** para no romper `upload-post`/`direct` (Sección 2.A).
> 6. Menores: `axios-retry` no instalado, alcance real de sanitización, cleanup del perfil de prueba, mensaje de error de `setPublishMode`.

---

## 🎯 Arquitectura General

Zernio coexistirá con los modos actuales de publicación:
* `direct` (Usa Meta Graph API a través de `instagramService.js`).
* `upload-post` (Usa `uploadPostService.js`).
* `zernio` (Nuevo modo que usará `zernioService.js`).

### 💾 Estrategia de Base de Datos (Cero Migraciones)
Para evitar migraciones estructurales de base de datos en producción, reutilizaremos la columna `ayrshare_profile_key` en la tabla `artists` para guardar el **Profile ID de Zernio** (`prof_...`).
* Cuando `publish_mode === 'zernio'`, el valor en `ayrshare_profile_key` se interpretará como el `profileId` de Zernio.

> #### ⚠️ Riesgo de colisión al cambiar de modo (validado contra `socialPublisher.js`)
> La columna `ayrshare_profile_key` **ya se reutiliza** hoy para el `profileId` de Upload-Post (ver comentario en `socialPublisher.js:8-12`). Si un artista que ya estaba en `upload-post` cambia a `zernio`, la columna contendrá una clave de Upload-Post, **no** un `prof_...` de Zernio. El branch de Zernio en `getConnectUrl` solo crea perfil `if (!profileId)`, por lo que intentaría usar la clave ajena y fallaría.
>
> **Regla de discriminación (sin migración):** tratar el valor como `profileId` de Zernio **solo si empieza con `prof_`**. En caso contrario (vacío o formato de Upload-Post), crear un perfil nuevo en Zernio y sobrescribir la columna. Esto replica el heurístico `isOldFormat` ya existente para Upload-Post (`socialPublisher.js:50-51`).
>
> ```javascript
> const isZernioProfile = (key) => typeof key === 'string' && key.startsWith('prof_');
> ```

---

## 🛠️ Detalle de Cambios a Realizar

### 1. Variables de Entorno
Añadir soporte para la autenticación con Zernio.

* **Archivos a modificar:** 
  * [d:\Github\marketingDigitalBackend\.env.example](file:///d:/Github/marketingDigitalBackend/.env.example)
  * [d:\Github\marketingDigitalBackend\.env](file:///d:/Github/marketingDigitalBackend/.env) (local)
* **Variables a agregar:**
  ```env
  ZERNIO_API_KEY=sk_tu_api_key_de_zernio
  ZERNIO_WEBHOOK_SECRET=whsec_tu_secreto_de_webhooks_de_zernio
  ```

---

### 2. Nuevo Servicio: `zernioService.js`
Crear el archivo `d:\Github\marketingDigitalBackend\src\services\zernioService.js` que encapsule todas las interacciones HTTP con la API de Zernio utilizando `axios`.

#### Configuración de cabeceras HTTP:
* **Base URL:** `https://zernio.com/api/v1`
* **Cabecera de autenticación:** `Authorization: Bearer <ZERNIO_API_KEY>`
* **Cabecera de contenido:** `Content-Type: application/json`

> #### ⚠️ Convenciones internas obligatorias (validado en `loggerService.js`)
> 1. **Logger:** el `loggerService.js` actual (winston) **solo** exporta `error / warn / info / debug / perf / apiCall / aiCost`. **No existe `logger.log(level, …)`** ni el nivel `'success'`. Usar siempre `logger.error('mensaje', { meta })` / `logger.info(...)`. *(Nota: hay 29 llamadas legacy a `logger.log()` rotas en `uploadPostService.js`, `vidalisService.js` y `analyticsService.js` que lanzan `TypeError` en runtime — no copiar ese patrón; idealmente corregirlas en un fix aparte.)*
> 2. **Cliente axios con retry:** `axios-retry` **no está instalado** (`package.json` solo trae `axios`). Opciones: (a) `npm i axios-retry`, o (b) —recomendado para no sumar dependencias— una **instancia `axios.create()`** propia en `zernioService` con un interceptor de respuesta que reintente 3 veces solo en `5xx`/timeout con backoff exponencial + jitter, y respete `Retry-After` en `429` (espejo del manejo de 429 ya presente en `uploadPostService.js:408-426`).

#### Métodos del Servicio:

##### A. Perfiles y Conexión OAuth
* **`createProfile(name, artistId)`**
  * **Endpoint:** `POST /profiles`
  * **Payload:** `{ "name": name, "description": "Vidalis.AI Artist ID: " + artistId }`
  * **Retorno:** El `_id` del perfil creado (ej. `prof_12345`).

* **`generateConnectUrl(profileId, platform)`**
  * **Endpoint:** `GET /connect/:platform?profileId=:profileId`
  * **Ejemplo:** `GET /connect/instagram?profileId=prof_123`
  * **Retorno:** El objeto de respuesta que contiene la propiedad `authUrl` para redirigir al usuario.

* **`getActivePlatforms(profileId)`**
  * **Endpoint:** `GET /accounts`
  * **Detalle:** Consulta las cuentas conectadas y filtra aquellas pertenecientes al `profileId`. Filtra y mapea únicamente las 4 plataformas deseadas: `instagram`, `tiktok`, `facebook` y `youtube`.
  * **Retorno:** Un array de objetos con las cuentas activas (ej: `[{ platform: 'instagram', username: '...', accountId: 'acc_ig_123' }]`).
  * **Mapeo en Base de Datos (Persistencia):** Al sincronizar el estado social del artista (`vidalisService.getSocialStatus`), en lugar de guardar el string genérico `'linked'` en el objeto JSON de la columna `social_keys`, guardaremos el `accountId` real devuelto por Zernio para esa plataforma.
    * Ejemplo de `social_keys` en la DB:
      ```json
      {
        "instagram": "acc_ig_123",
        "tiktok": "acc_tk_456",
        "facebook": "acc_fb_789",
        "youtube": "acc_yt_999"
      }
      ```
    * Esto nos permite conocer el ID exacto de la cuenta conectada sin agregar columnas o migraciones a Supabase.
  * **⚠️ Compatibilidad (validado en `vidalisService.js:1088-1120`):** Hoy `getSocialStatus` escribe `social_keys[p] = 'linked'` para **todos** los modos, y `socialPublisher.getActivePlatforms` devuelve un **array de strings** en `upload-post`/`direct`. Por tanto, guardar `accountId` debe hacerse en un **code-path exclusivo de `publish_mode === 'zernio'`** dentro del branch de *refresh* de `getSocialStatus`; los modos existentes conservan su comportamiento actual (`'linked'`). El `accountId` persistido aquí es la fuente de verdad que consumirá `publishPost` (ver Sección 2.B).

##### B. Publicación y Programación de Contenido
* **`publishPost(text, platforms, mediaUrls, profileId, options = {})`**
  * **Endpoint:** `POST /posts`
  * **Payload:**
    ```json
    {
      "content": "Texto del post",
      "publishNow": true,
      "platforms": [
        { "platform": "instagram", "accountId": "acc_123" }
      ],
      "mediaUrls": ["url_de_cloudinary"]
    }
    ```
  * **🔑 Resolución del `accountId` (vacío crítico que el plan debe cerrar):** El payload de Zernio exige `{ platform, accountId }` por canal, pero el `accountId` **no** está en la firma. Vive en `social_keys` (persistido por `getActivePlatforms`, ver Sección 2.A). Como `socialPublisher.publishPost(artist, …)` ya tiene el objeto `artist` completo, **pasará el mapa de cuentas dentro de `options`** sin cambiar la firma posicional:
    * En `socialPublisher`: `zernioService.publishPost(text, platforms, mediaUrls, artist.ayrshare_profile_key, { ...options, accounts: artist.social_keys || {} })`.
    * En `zernioService`: construir el array filtrando plataformas sin cuenta conectada:
      ```javascript
      const accounts = options.accounts || {};
      const resolved = platforms
        .filter(p => accounts[p])                       // descarta canales sin accountId
        .map(p => ({ platform: p, accountId: accounts[p] }));
      if (resolved.length === 0) {
        throw new Error('Ninguna de las plataformas solicitadas tiene una cuenta de Zernio conectada (social_keys vacío o desactualizado).');
      }
      ```
    * Si `social_keys` viniera vacío o con el valor legacy `'linked'` (artista sincronizado antes de Zernio), forzar un `getActivePlatforms(profileId)` para refrescar antes de publicar.
  * **Retorno:** `{ id: post._id, status: post.status }`
  * **Reglas Específicas por Plataforma (Construidas dinámicamente en el servicio):**
    * **YouTube:** Si `platforms` contiene `youtube`, se debe enviar el campo `title` a nivel de raíz. Si no viene en `options.title`, se usará el título del video en Supabase o los primeros 100 caracteres del texto limpio del post (sin hashtags).
    * **TikTok:** Si se publica en TikTok, se agregará `platformSpecificData: { tiktok: { privacyLevel: 'PUBLIC', allowComment: true, allowDuet: true, allowStitch: true } }` en el cuerpo.
    * **Facebook & Instagram Reels:** Si la publicación es un video corto y vertical (tipo reel), se especificará `platformSpecificData: { facebook: { contentType: 'reel', title: options.title || 'Nuevo Reel' } }` para asegurar que se procese como Reel y no como post de feed tradicional.

* **`schedulePost(text, platforms, mediaUrls, scheduleDate, profileId, options = {})`**
  * **Endpoint:** `POST /posts`
  * **Payload:** Igual a `publishPost` pero quitando `publishNow: true` y añadiendo:
    ```json
    {
      "scheduledFor": "2026-06-14T12:00:00.000Z",
      "timezone": "UTC"
    }
    ```

* **`getPostStatus(postId)`**
  * **Endpoint:** `GET /posts/:postId`
  * **Retorno:** Estado del post (ej. `published`, `scheduled`, `failed`).

* **`getPostAnalytics(postId)`**
  * **Endpoint:** `GET /posts/:postId` o `GET /analytics/posts?postId=:postId`
  * **Retorno:** Métricas del post (likes, comments, shares, views, etc.).

##### C. Bandeja de Entrada y Comentarios
* **`getProfileComments(profileId, limit = 20, cursor = null, platform = null)`**
  * **Endpoint:** `GET /inbox/comments`
  * **Query Params:** `?profileId=:profileId&limit=:limit` (añadir `cursor` y `platform` si existen).
  * **Retorno:** Array de posts comentados (`data`) y datos de paginación (`pagination`).

* **`getPostComments(postId, accountId, limit = 50, cursor = null)`**
  * **Endpoint:** `GET /inbox/comments/:postId`
  * **Query Params:** `?accountId=:accountId&limit=:limit` (añadir `cursor` si existe).

* **`postCommentReply(postId, accountId, message, commentId = null)`**
  * **Endpoint:** `POST /inbox/comments/:postId`
  * **Payload:** `{ "accountId": accountId, "message": message, "commentId": commentId }` (si `commentId` se pasa, se responde al hilo del comentario, si no, se comenta el post).

* **`sendPrivateReply(postId, commentId, accountId, message, buttons = [], quickReplies = [])`**
  * **Endpoint:** `POST /inbox/comments/:postId/:commentId/private-reply`
  * **Payload:** 
    ```json
    {
      "accountId": "acc_...",
      "message": "...",
      "buttons": buttons, // Opcional (1-3)
      "quickReplies": quickReplies // Opcional (hasta 13)
    }
    ```

* **`hideComment(postId, commentId, accountId, hide = true)`**
  * **Endpoints:**
    * Ocultar: `POST /inbox/comments/:postId/:commentId/hide` con cuerpo `{ "accountId": accountId }`
    * Desocultar: `DELETE /inbox/comments/:postId/:commentId/hide?accountId=:accountId`

* **`likeComment(postId, commentId, accountId, like = true, cid = null)`**
  * **Endpoints:**
    * Dar Like: `POST /inbox/comments/:postId/:commentId/like` con cuerpo `{ "accountId": accountId, "cid": cid }`
    * Quitar Like: `DELETE /inbox/comments/:postId/:commentId/like?accountId=:accountId`

* **`deleteComment(postId, commentId, accountId)`**
  * **Endpoint:** `DELETE /inbox/comments/:postId?accountId=:accountId&commentId=:commentId`

##### D. Automatizaciones Comment-to-DM
* **`createCommentAutomation(profileId, accountId, autoData)`**
  * **Endpoint:** `POST /comment-automations`
  * **Payload:**
    ```json
    {
      "profileId": "prof_...",
      "accountId": "acc_...",
      "trigger": "comment",
      "platformPostId": "media_id_opcional",
      "postId": "zernio_post_id_opcional",
      "name": "Lead Magnet Preventa",
      "keywords": ["show", "entradas"],
      "matchMode": "contains",
      "dmMessage": "¡Hola! Aquí tienes tus entradas: https://link.com",
      "commentReply": "¡Revisa tu inbox, te envié los detalles!",
      "buttons": [],
      "linkTracking": true
    }
    ```

* **`listCommentAutomations(profileId)`**
  * **Endpoint:** `GET /comment-automations?profileId=:profileId`

* **`getCommentAutomationDetails(automationId)`**
  * **Endpoint:** `GET /comment-automations/:automationId`

* **`updateCommentAutomation(automationId, updateData)`**
  * **Endpoint:** `PATCH /comment-automations/:automationId`
  * **Payload:** Campos a actualizar (ej. `{ "isActive": false }` o `{ "keywords": ["nuevo"] }`).

* **`deleteCommentAutomation(automationId)`**
  * **Endpoint:** `DELETE /comment-automations/:automationId`

##### E. Manejo Automático de Tamaños y Relación de Aspecto (Cloudinary)
El backend de Vidalis.AI ya cuenta con una lógica centralizada en `vidalisService.js` (a través de la función `buildCloudinaryUrl`) para adaptar automáticamente el tamaño y formato del video/imagen original a los requisitos técnicos de cada red social antes de entregárselo a Zernio:

* **Videos Cortos / Verticales (TikTok, Instagram Reels, YouTube Shorts):**
  * **Transformación:** `w_1080,h_1920,c_fill,vc_h264,ac_aac,f_mp4`
  * **Acción:** Recorta y escala el video original a formato vertical **9:16 (1080x1920)** con códec de video H.264, audio AAC, y fuerza la extensión final a `.mp4` para garantizar máxima compatibilidad con las APIs de publicación de Zernio.
* **Imágenes en Feeds Orgánicos (Instagram & Facebook):**
  * **Transformación:** `w_1080,h_1080,c_pad,ar_1:1,b_black,f_jpg`
  * **Acción:** Genera una imagen cuadrada **1:1 (1080x1080)** añadiendo márgenes (*padding*) negros si la imagen original no es cuadrada, forzando formato JPG.
* **Imágenes Verticales (General / Historias):**
  * **Transformación:** `w_1080,h_1920,c_pad,ar_9:16,b_black,f_jpg`
  * **Acción:** Adapta la imagen a formato vertical **9:16 (1080x1920)** con padding negro.

**Estrategia de Entrega a Zernio:**
1. **Publicación Unificada (Mismo Aspect Ratio):** Para la gran mayoría de casos (videos en formato 9:16 para Reels, TikTok y Shorts), todos comparten la misma relación de aspecto. Vidalis generará una única URL de Cloudinary optimizada en formato vertical 9:16 y la enviará a Zernio en la llamada de publicación.
2. **Publicaciones Mixtas Diferenciadas:** Si un mismo post contiene plataformas que requieren formatos incompatibles en simultáneo (ej: publicar como imagen de feed 1:1 en Instagram pero formato vertical 9:16 en otras), el backend de Vidalis descompondrá la petición en llamadas de API individuales a Zernio por red social, inyectando en cada una la URL de Cloudinary transformada específicamente para ese canal.

---

### 3. Integración en `socialPublisher.js`
Modificar el archivo `d:\Github\marketingDigitalBackend\src\services\socialPublisher.js` para bifurcar las peticiones al servicio de Zernio si el artista está configurado en ese modo.

> **Nota de ubicación (validado en `socialPublisher.js:21-79`):** cada función actual empieza con un `if (artist.publish_mode === 'direct')`. El branch de Zernio se coloca **justo después** de ese chequeo de `'direct'` y **antes** del fallback a Upload-Post. La firma real es `publishPost(artist, text, platforms, mediaUrls = [], options = {})` y `getConnectUrl(artist, allowedPlatforms = [], supabase)`.

```javascript
const zernioService = require('./zernioService'); // Agregar import

// Helper compartido (ver Estrategia de DB)
const isZernioProfile = (key) => typeof key === 'string' && key.startsWith('prof_');

// En exports.publishPost — tras el chequeo de 'direct'
if (artist.publish_mode === 'zernio') {
  // `accounts` lleva el mapa { plataforma: accountId } persistido en social_keys
  return zernioService.publishPost(
    text, platforms, mediaUrls, artist.ayrshare_profile_key,
    { ...options, accounts: artist.social_keys || {} }
  );
}

// En exports.schedulePost — tras el chequeo de 'direct'
if (artist.publish_mode === 'zernio') {
  return zernioService.schedulePost(
    text, platforms, mediaUrls, scheduleDate, artist.ayrshare_profile_key,
    { ...options, accounts: artist.social_keys || {} }
  );
}

// En exports.getConnectUrl — tras el chequeo de 'direct'
if (artist.publish_mode === 'zernio') {
  let profileId = artist.ayrshare_profile_key;
  // Si está vacío o contiene una clave de OTRO proveedor (p.ej. Upload-Post), crear perfil Zernio
  if (!isZernioProfile(profileId)) {
    profileId = await zernioService.createProfile(artist.name, artist.id);
    try {
      await supabase.from('artists')
        .update({ ayrshare_profile_key: profileId, publish_mode: 'zernio' })
        .eq('id', artist.id);
    } catch (e) {
      console.warn('⚠️ No se pudo actualizar DB (Zernio profile):', e.message);
    }
  }
  const platform = allowedPlatforms[0] || 'instagram'; // Zernio conecta una plataforma por URL
  const res = await zernioService.generateConnectUrl(profileId, platform);
  return { url: res.authUrl, mode: 'zernio', profileKey: profileId };
}

// En exports.getActivePlatforms — tras el chequeo de 'direct'
if (artist.publish_mode === 'zernio') {
  if (!isZernioProfile(artist.ayrshare_profile_key)) return [];
  return zernioService.getActivePlatforms(artist.ayrshare_profile_key);
}
```

---

### 4. Nuevas Rutas y Controladores

#### Rutas en `src/routes/vidalisRoutes.js`
Añadir soporte para las interacciones de comentarios y automatizaciones.

```javascript
// Rutas de Comentarios & Inbox
router.get('/comments/:artistId', authenticateToken, authorizeArtist, vidalisController.getArtistComments);
router.get('/comments/:postId/replies', authenticateToken, vidalisController.getPostComments);
router.post('/comments/:postId/reply', authenticateToken, vidalisController.replyToComment);
router.post('/comments/:postId/:commentId/hide', authenticateToken, vidalisController.hideCommentToggle);
router.post('/comments/:postId/:commentId/like', authenticateToken, vidalisController.likeCommentToggle);
router.delete('/comments/:postId', authenticateToken, vidalisController.deleteComment);

// Rutas de Automatizaciones (Comment-to-DM)
router.get('/automations/:artistId', authenticateToken, authorizeArtist, vidalisController.getAutomations);
router.post('/automations/:artistId', authenticateToken, authorizeArtist, vidalisController.createAutomation);
router.get('/automations/details/:automationId', authenticateToken, vidalisController.getAutomationDetails);
router.patch('/automations/:automationId', authenticateToken, vidalisController.updateAutomation);
router.delete('/automations/:automationId', authenticateToken, vidalisController.deleteAutomation);

// Webhook Receptor de Zernio (Sincronización Asíncrona)
router.post('/webhooks/zernio', vidalisController.zernioWebhook);
```

#### Controladores en `src/controllers/vidalisController.js`

1. **`setPublishMode`**: Permitir `'zernio'` en el validador **y actualizar el string del mensaje de error** (hoy en `vidalisController.js:401-402` dice literalmente "debe ser 'direct' o 'upload-post'"):
   ```javascript
   if (!['direct', 'upload-post', 'zernio'].includes(publish_mode)) {
     return res.status(400).json({ error: "publish_mode debe ser 'direct', 'upload-post' o 'zernio'" });
   }
   ```
2. **`getArtistComments`**:
   * Buscar el artista y obtener su `ayrshare_profile_key`.
   * Invocar `zernioService.getProfileComments(profileId, req.query.limit, req.query.cursor, req.query.platform)`.
3. **`getPostComments`**:
   * Invocar `zernioService.getPostComments(req.params.postId, req.query.accountId, req.query.limit, req.query.cursor)`.
4. **`replyToComment`**:
   * Esperar body: `{ accountId, message, commentId, isPrivate, buttons, quickReplies }`.
   * Si `isPrivate` es `true`, llamar a `zernioService.sendPrivateReply(postId, commentId, accountId, message, buttons, quickReplies)`.
   * Si es `false`, llamar a `zernioService.postCommentReply(postId, accountId, message, commentId)`.
5. **`hideCommentToggle`**:
   * Esperar body: `{ accountId, hide }`.
   * Llamar a `zernioService.hideComment(postId, commentId, accountId, hide)`.
6. **`likeCommentToggle`**:
   * Esperar body: `{ accountId, like, cid }`.
   * Llamar a `zernioService.likeComment(postId, commentId, accountId, like, cid)`.
7. **`deleteComment`**:
   * Esperar query parameters: `accountId` y `commentId`.
   * Llamar a `zernioService.deleteComment(postId, commentId, accountId)`.
8. **`getAutomations`**:
   * Obtener `ayrshare_profile_key` del artista y llamar a `zernioService.listCommentAutomations(profileId)`.
9. **`createAutomation`**:
   * Obtener `ayrshare_profile_key` del artista y llamar a `zernioService.createCommentAutomation(profileId, accountId, req.body)`.
10. **`getAutomationDetails`**:
    * Llamar a `zernioService.getCommentAutomationDetails(req.params.automationId)`.
11. **`updateAutomation`**:
    * Llamar a `zernioService.updateCommentAutomation(req.params.automationId, req.body)`.
12. **`deleteAutomation`**:
    * Llamar a `zernioService.deleteCommentAutomation(req.params.automationId)`.
13. **`zernioWebhook`**:
    * **⚠️ Verificación de firma sobre body CRUDO (footgun habitual):** la firma HMAC-SHA256 se calcula sobre el **cuerpo sin parsear**. Si `app.js` ya aplica `express.json()` globalmente, el `req.body` llega como objeto y el HMAC **no coincidirá**. Soluciones: montar esta ruta con `express.raw({ type: 'application/json' })` **antes** del JSON parser global, o capturar `rawBody` con la opción `verify` de `express.json`. Comparar con `crypto.timingSafeEqual` (no `===`) usando `ZERNIO_WEBHOOK_SECRET`. Devolver `401` si no coincide y `200` rápido si coincide (procesar async para no bloquear el reintento de Zernio).
    * **⚠️ Nombres de evento/campos por confirmar contra la doc real de Zernio:** `post.published` / `post.failed`, el header de firma (`x-zernio-signature`) y `platformPostUrl` están **asumidos**. Confirmarlos antes de codificar (idealmente capturando un webhook real en el script de verificación).
    * Procesa el evento de Zernio:
      * Si es `post.published`, busca el video por el ID de post (`ayrshare_post_id`, columna ya usada en `vidalisService.js:1192` y `:1360`) y actualiza su estado en Supabase a `'published'`. Extrae y guarda la URL pública (`platformPostUrl`) de la plataforma origen (filtrando que sea una de las 4 permitidas: **tiktok, instagram, facebook o youtube**).
      * Si es `post.failed`, actualiza el estado del video a `'failed'` y guarda la descripción del error devuelto por Zernio en `error_log` (columna ya existente en la tabla `videos`, ver `vidalisController.js:288`).

---

## 🔒 Seguridad y Mecanismos de Reintento

Para garantizar la seguridad de los datos de los creadores y hacer frente a fallos de red temporales (errores transitorios) al comunicarnos con la API externa de Zernio, implementaremos las siguientes directrices:

### 1. Control de Acceso y Aislamiento de Datos (Seguridad)
* **Validación de Identidad (JWT):** Todas las rutas nuevas que exponga el backend de Vidalis deben estar protegidas con el middleware `authenticateToken` para garantizar que la solicitud provenga de un usuario autenticado.
* **Autorización Estricta (`authorizeArtist`):** Para cualquier consulta de comentarios o configuración de automatizaciones de un artista específico (`:artistId`), se ejecutará obligatoriamente el middleware `authorizeArtist`. Esto impide que un usuario de la agencia A intente leer comentarios o crear automatizaciones del artista de la agencia B, validando la pertenencia en la base de datos de Supabase antes de realizar llamadas a Zernio.
* **Manejo de Credenciales:** La `ZERNIO_API_KEY` se almacenará de manera segura en las variables de entorno del servidor. Bajo ninguna circunstancia se expondrá esta clave al frontend o en respuestas de error de la API.
* **Sanitización de Datos (alcance realista):** Los textos (`message`, `keywords`, `dmMessage`) **no se renderizan como HTML en nuestra app**, por lo que el riesgo no es XSS propio sino enviar datos malformados a Zernio. La "sanitización" aquí = `trim`, **límites de longitud por plataforma** (p.ej. 640 chars si hay botones, ver Sección Frontend), y eliminación de caracteres de control. No se requiere lib de XSS en el backend (no hay `dompurify`/`xss` instalada); si en el futuro estos textos se muestran en el dashboard, sanear en el **frontend** al renderizar.

### 2. Tolerancia a Fallos y Reintentos Automáticos (Resiliencia)
Para evitar que las caídas temporales de red o la saturación de los servidores de Zernio arruinen la experiencia de usuario o interrumpan las publicaciones/respuestas:
* **Mecanismo de Reintento con Exponencial Backoff:** Implementado en una instancia `axios.create()` propia dentro de `zernioService.js` (ver Sección 2 — `axios-retry` **no** está en `package.json`; o se instala o se usa interceptor manual).
  * **Número de intentos:** 3 reintentos máximo.
  * **Filtro de errores:** Solo se reintentarán los fallos de red o errores HTTP transitorios en el rango de `5xx` (500, 502, 503, 504) y errores de timeout.
  * **Exclusión:** Las respuestas con estados `4xx` (401 Unauthorized, 403 Forbidden, 404 Not Found, 400 Bad Request) **no** se reintentarán ya que representan fallos de configuración del usuario o datos erróneos permanentes.
  * **Tiempo de espera:** Incremento exponencial con factor aleatorio (*exponential backoff with jitter*) iniciando en 1000ms (1s, 2s, 4s...) para evitar sobrecargar la API en caso de congestión.
* **Manejo del Límite de Peticiones (Rate Limits - HTTP 429):**
  * Zernio puede responder con código `429 Too Many Requests`.
  * El interceptor leerá la cabecera `Retry-After` (si está presente) para suspender temporalmente los envíos a esa cuenta o perfil específico durante el tiempo indicado por Zernio, retornando una cola o un error amigable al usuario que le pida esperar.
* **Registros de Error (Logging):** Todos los fallos de conexión o de reintento con la API de Zernio se registrarán con **`logger.error('ZERNIO_…', { endpoint, artistId, postId, status })`** (winston escribe a `error.log`). Recordar: usar `logger.error/info`, **nunca** `logger.log()` (no existe — ver convenciones de la Sección 2).

---

## 🧪 Plan de Pruebas y Script de Verificación

Crearemos el script `d:\Github\marketingDigitalBackend\verify_zernio.js` para validar de forma aislada la API. El script debe realizar las siguientes peticiones secuenciales:

1. **Crear Perfil de Prueba**: Intentar llamar a `createProfile("Artista Test", "test-id")`.
2. **Generar URL de Autenticación**: Intentar llamar a `generateConnectUrl(profileId, 'instagram')`.
3. **Listar Cuentas**: Llamar a `getActivePlatforms(profileId)` (debe devolver un array, probablemente vacío al inicio).
4. **Crear Regla de Automatización**: Llamar a `createCommentAutomation` con una regla simulada en el perfil recién creado.
5. **Listar Automatizaciones**: Llamar a `listCommentAutomations(profileId)` y comprobar que la regla creada aparece en el listado.
6. **Eliminar Automatización**: Llamar a `deleteCommentAutomation` para limpiar la regla.
7. **Eliminar Perfil de Prueba (cleanup):** Llamar a `DELETE /profiles/:id` (si Zernio lo soporta) sobre el perfil creado en el paso 1. **Sin esto, cada corrida crea un perfil huérfano** y puede agotar el límite del plan (mismo síntoma que `PROFILE_LIMIT_REACHED` ya manejado en `uploadPostService.js:176`). Envolver en `try/finally` para que se ejecute aunque fallen pasos previos.

Este script se ejecutará de forma local mediante:
```bash
node verify_zernio.js
```

---

## 🖥️ Arquitectura de Diseño y UI/UX para el Frontend (`marketingDigitalFrontend`)

Para asegurar una experiencia premium, interactiva y de alto impacto visual (acorde a la estética moderna de Vidalis.AI), el equipo de frontend implementará el siguiente diseño para la sección de **Comunidad (Inbox)** y el **Gestor de Automatizaciones**:

### 1. Pantalla de Inbox de Comunidad (Split-Pane Dashboard)
Se utilizará un layout de panel dividido en dos columnas principales con efecto de desenfoque de fondo (*glassmorphic style*), bordes redondeados sutiles y transiciones fluidas.

```
+------------------------------------------------------------------------------------+
|  COMUNIDAD / INBOX                                                                 |
+--------------------------------------+---------------------------------------------+
| BUSCADOR / PLATAFORMAS               | POST SELECCIONADO (Detalle & Hilo)          |
| [ IG ] [ FB ] [ YT ] [ TK ]          | [Thumbnail] "Snippet del post..." (Link)    |
+--------------------------------------+---------------------------------------------+
| Tarjeta Post 1 (Instagram)           |  ┌─ Comentario de @fan1 [Me gusta] [Ocultar]|
| [Thumb] Snippet...         (2) Hace 1h|  │  "¡Increíble tema! ¿Cuándo sale?" [Resp] |
|                                      |  │  └─ [Reply box activa]                   |
| Tarjeta Post 2 (YouTube)             |  │                                          |
| [Thumb] Snippet...         (0) Hace 2h|  ├─ Comentario de @fan2 (Oculto)            |
|                                      |  │  "Link de compra por favor"              |
| Tarjeta Post 3 (TikTok)              |  |                                          |
+--------------------------------------+--+------------------------------------------+
|                                      | CAJA DE RESPUESTA                           |
|                                      | ( ) Pública (Instagram/FB/YT/TK)            |
|                                      | ( ) Mensaje Privado DM (Instagram/FB)       |
|                                      | [ Escribe respuesta...             ] [AI ✨] |
|                                      |                                  [ ENVIAR ]|
+--------------------------------------+---------------------------------------------+
```

#### A. Columna Izquierda: Listado de Posts Comentados (Ancho: ~35%)
* **Filtros rápidos:** Barra superior con botones tipo pill para filtrar por plataforma (Iconos coloreados de Instagram, Facebook, YouTube, TikTok) y un checkbox de "Solo no leídos" o "Requiere respuesta".
* **Tarjetas de Post (`PostCommentCard`):**
  * **Miniatura:** Imagen o frame del video recortado en miniatura (48x48px) con esquinas redondeadas.
  * **Cuerpo:** Breve descripción recortada del post.
  * **Badge de Plataforma:** Pequeño badge flotante en la esquina de la miniatura que indica la red social origen del post.
  * **Indicadores:** Contador circular con el número total de comentarios activos y un punto verde/azul brillante si hay comentarios nuevos no respondidos.
  * **Interacciones:** Hover states limpios que cambian levemente la opacidad del fondo y muestran un sombreado suave.

#### B. Columna Derecha: Hilo de Comentarios Activo (Ancho: ~65%)
* **Cabecera del Post:** Muestra la miniatura ampliada del post, la fecha original de publicación, el texto completo y un enlace directo para abrir el post en la red social nativa.
* **Lista de Comentarios (`CommentThread`):**
  * Renderizado en burbujas con avatars de los usuarios, nombres reales, usernames y tiempos relativos (ej. "hace 45 min").
  * **Badges especiales:** Badge dorado "Owner" si el comentario pertenece al artista, o badge verificado si el usuario de la red social tiene cuenta verificada.
  * **Barra de Acciones rápidas (visibles al hacer Hover sobre el comentario):**
    * **Botón Corazón (Like):** Color gris por defecto; al dar click se torna rojo/rosa vibrante y aumenta el contador de likes mediante llamada a `POST /comments/:postId/:commentId/like`.
    * **Botón Ojo (Hide):** Alterna el estado de visibilidad. Si el comentario está oculto, la tarjeta se renderiza con opacidad reducida (50%) y un texto aclaratorio "Oculto para el público". Llama a `POST /comments/:postId/:commentId/hide`.
    * **Botón Papelera (Delete):** Solicita confirmación y llama a `DELETE /comments/:postId?commentId=...` para eliminar el comentario de forma permanente.
    * **Botón Responder:** Abre un input de respuesta anidado justo debajo de ese comentario para crear una respuesta en hilo.
  * **Comentarios Anidados (Sub-respuestas):** Renderizados con sangría izquierda (indentación) y una línea conectora sutil para denotar el hilo de conversación.

#### C. Caja de Respuesta Inteligente (Bottom Input Panel)
* **Selectores de Modo (Pills/Tabs):**
  * **Pública:** Opción estándar para que la respuesta sea un comentario público en el post.
  * **Privada (DM):** Habilitada únicamente para Instagram y Facebook. Permite responder al comentario enviando un mensaje directo privado al usuario (ideal para ofrecer links de compras o códigos).
* **Campo de texto enriquecido:** Entrada con contador de caracteres dinámico (con alerta visual si excede los límites de la plataforma, por ejemplo los 300 caracteres de Bluesky o los límites de Zernio).
* **Botón AI Smart Reply (`AI ✨`):**
  * Al hacer click, abre un menú desplegable de carga rápida.
  * Vidalis consulta al backend una sugerencia de respuesta redactada con IA (Gemini/Claude) adaptada al estilo del artista.
  * Muestra 3 opciones sugeridas: *"Agradecido"*, *"Divertido/Fan"*, *"Informativo"*. Al seleccionar una, el texto se escribe automáticamente en la caja de respuesta listo para editar o enviar.

---

### 2. Panel de Gestión de Automatizaciones (Lead Magnets Builder)
El gestor de Comment-to-DM se diseñará como una cuadrícula de tarjetas minimalistas interactivas con estados de encendido/apagado claros.

#### A. Tarjetas de Automatización (`AutomationCard`)
Cada regla de auto-respuesta se renderiza en una tarjeta con la siguiente información:
* **Interruptor (Toggle Switch):** Activa (`isActive: true`) o pausa (`isActive: false`) la regla de inmediato mediante llamada a `PATCH /automations/:automationId`.
* **Título / Objetivo:** Ej. "Lanzamiento Single Preventa".
* **Palabras Clave (Keywords):** Chips/Pills coloreados que listan los triggers (ej. `[info]` `[entradas]`).
* **Mensaje de DM (Preview):** Pequeño bloque de texto que previsualiza el mensaje enviado.
* **Badge de Canal:** Icono de Instagram o Facebook según a qué cuenta aplique la automatización.
* **Módulo de Analíticas Micro (Mini Dashboard en la base de la tarjeta):**
  * **Disparos:** Número de veces ejecutado.
  * **CTR (Click Through Rate):** Si la automatización contenía enlaces con tracking habilitado.
  * **Conversiones:** Leads generados o clicks totales.

#### B. Formulario de Creación / Edición (Modal Deslizable)
Un formulario limpio con validaciones en tiempo real:
1. **Nombre de la Regla:** Identificador interno de campaña.
2. **Cuenta Destino:** Selector dropdown de las redes sociales conectadas de ese artista.
3. **Trigger de Post:** Selector para aplicar la regla a "Cualquier post de la cuenta" (account-wide) o a un "Post específico" (permite seleccionar uno de sus videos publicados recientemente).
4. **Palabras Clave:** Input que crea pills automáticamente al presionar *Enter* o coma.
5. **Mensaje de Auto-DM:** Área de texto con soporte para insertar variables dinámicas (como `{username}` o `{firstname}`) y limitador a 640 caracteres si se añaden botones.
6. **Configurador de Botones DM (Opcional):** Permite añadir hasta 3 botones inline (títulos de hasta 20 caracteres y URLs de destino) que Zernio registrará para click tracking automático.
7. **Respuesta pública:** Textarea opcional para redactar lo que se comentará automáticamente en el post público (ej. "¡Revisa tu inbox!").

