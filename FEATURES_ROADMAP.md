# 🚀 VIDALIS FEATURES ROADMAP

**Última actualización:** 2026-06-12  
**Estado actual:** SEO 100/100 | A11y 95/100 | Performance 81/100  
**Proyecto:** Plataforma IA de gestión de contenido para creadores y agencias

---

## 📋 TABLA DE CONTENIDOS

1. [Features Críticos](#-features-críticos)
2. [Features Importantes](#-features-importantes)
3. [Features Nice-to-Have](#-features-nice-to-have)
4. [Arquitectura Técnica](#-arquitectura-técnica)
5. [Stack Actual](#-stack-actual)

---

## 🔴 FEATURES CRÍTICOS

### 1. TESTING AUTOMATIZADO

**Prioridad:** 🔴 CRÍTICO  
**Esfuerzo:** 40-60 horas  
**ROI:** Muy Alto (reduce bugs en producción)  
**Estado:** ❌ No implementado

#### Descripción
El proyecto actual no tiene tests automatizados. Esto es un riesgo importante en producción.

#### Componentes a Testear

**Backend:**
- ✅ Auth middleware (JWT validation, Google OAuth)
- ✅ Video processing pipeline (Groq → Gemini → Claude)
- ✅ Database queries (Supabase)
- ✅ API routes (todos los endpoints)
- ✅ Error handling

**Frontend:**
- ✅ Componentes React (Hero, Navbar, Dashboard)
- ✅ Flujos de usuario (login, upload, publish)
- ✅ Integración de APIs

#### Stack Recomendado

```json
{
  "backend": {
    "unit": "Jest 29+",
    "api": "SuperTest 6+",
    "coverage": "60% mínimo"
  },
  "frontend": {
    "unit": "Vitest 0.34+",
    "component": "React Testing Library 14+",
    "e2e": "Playwright 1.40+ o Cypress 13+"
  }
}
```

#### Pasos de Implementación

**Fase 1: Setup (2 horas)**
```bash
# Backend
npm install --save-dev jest supertest @types/jest ts-jest

# Frontend
npm install --save-dev vitest @testing-library/react @testing-library/jest-dom

# E2E
npm install --save-dev @playwright/test
```

**Fase 2: Tests Unitarios (20 horas)**
```
Backend:
- src/middleware/authMiddleware.test.js
- src/services/aiService.test.js
- src/services/uploadPostService.test.js
- src/controllers/vidalisController.test.js

Frontend:
- src/components/Hero.test.jsx
- src/components/VideoGallery.test.jsx
- src/pages/Dashboard.test.jsx
```

**Fase 3: Tests de Integración (15 horas)**
```bash
# Rutas API
- POST /api/vidalis/login
- POST /api/vidalis/upload
- POST /api/vidalis/publish
- GET /api/vidalis/gallery/:artistId
```

**Fase 4: E2E Tests (15 horas)**
```
- Flujo de registro y login
- Upload y procesamiento de video
- Publicación en redes sociales
- Visualización de analytics
```

#### Estructura de Carpetas
```
backend/
├── src/
│   ├── __tests__/
│   │   ├── middleware.test.js
│   │   ├── services.test.js
│   │   └── routes.test.js
│   └── ...
└── jest.config.js

frontend/
├── src/
│   ├── __tests__/
│   │   ├── components/
│   │   └── pages/
│   └── ...
├── e2e/
│   └── tests/
└── playwright.config.js
```

#### Checklist de Implementación
- [ ] Setup Jest/Vitest en ambos proyectos
- [ ] Crear fixtures y mocks
- [ ] Escribir tests de auth (middleware)
- [ ] Escribir tests de AI service
- [ ] Tests de componentes React principales
- [ ] Tests E2E del flujo crítico
- [ ] Configurar CI/CD (GitHub Actions)
- [ ] Configurar coverage reporting
- [ ] Documentar convenciones de tests

#### Referencias
- Jest Docs: https://jestjs.io/
- Vitest Docs: https://vitest.dev/
- React Testing Library: https://testing-library.com/react
- Playwright: https://playwright.dev/

---

### 2. LOGGING CENTRALIZADO Y MONITOREO

**Prioridad:** 🔴 CRÍTICO  
**Esfuerzo:** 16-24 horas  
**ROI:** Alto (visibilidad en producción)  
**Estado:** ❌ Parcialmente implementado (solo console.log)

#### Descripción
Implementar sistema de logging profesional y error tracking para debugging en producción.

#### Librerías Recomendadas

```json
{
  "logging": "winston@3.11+",
  "errorTracking": "sentry/node@7.80+",
  "performance": "@sentry/profiling-node",
  "database": "@supabase/supabase-js (usar para audit logs)"
}
```

#### Configuración Winston

**Archivo: `src/services/loggerService.js`**

```javascript
const winston = require('winston');
const path = require('path');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'vidalis-backend' },
  transports: [
    // Error logs
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Combined logs
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize: 5242880,
      maxFiles: 10,
    }),
    // Console en desarrollo
    ...(process.env.NODE_ENV !== 'production' ? [
      new winston.transports.Console({
        format: winston.format.simple(),
      }),
    ] : []),
  ],
});

module.exports = logger;
```

#### Integración Sentry

**Archivo: `src/app.js` (inicio)**

```javascript
const Sentry = require("@sentry/node");
const ProfilingIntegration = require("@sentry/profiling-node");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    new ProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
});

app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.errorHandler());
```

#### Eventos a Loguear

**Críticos:**
- ❌ Errores en auth (failed login attempts)
- ❌ Errores en AI processing (fallos de Groq, Gemini, Claude)
- ❌ Errores en database queries
- ❌ Errores en publicación a redes sociales

**Importantes:**
- ℹ️ Login exitosos (sin datos sensibles)
- ℹ️ Upload de videos completado
- ℹ️ Publicación completada
- ℹ️ Cambios de configuración

**Informativos:**
- 📊 Estadísticas de uso
- 📊 Tiempo de procesamiento
- 📊 Costo de API calls

#### Estructura de Logs

```json
{
  "timestamp": "2026-06-12T10:30:00Z",
  "level": "error",
  "service": "vidalis-backend",
  "userId": "user_123",
  "agencyId": "agency_456",
  "action": "process_video",
  "videoId": "vid_789",
  "error": "Groq API timeout",
  "stack": "...",
  "duration_ms": 45000,
  "cost_usd": 0.025
}
```

#### Checklist de Implementación
- [ ] Instalar Winston y Sentry
- [ ] Crear logger service
- [ ] Integrar logger en todos los servicios
- [ ] Configurar Sentry para errores
- [ ] Crear dashboard de monitoreo
- [ ] Setup de alertas (Slack/email)
- [ ] Documentar convenciones de logs
- [ ] Pruebas en staging

#### Referencias
- Winston Docs: https://github.com/winstonjs/winston
- Sentry Docs: https://docs.sentry.io/

---

### 3. REDIS CACHE PARA OPTIMIZACIÓN

**Prioridad:** 🔴 CRÍTICO  
**Esfuerzo:** 20-28 horas  
**ROI:** Muy Alto (reduce costos de IA + latencia)  
**Estado:** ❌ No implementado

#### Descripción
Implementar caché distribuido para reducir llamadas a APIs de IA (Claude, Gemini, Groq) y mejorar velocidad de respuesta.

#### Instalación

```bash
npm install redis ioredis
# O usar Railway/Upstash (servicio manejado)
```

#### Casos de Uso para Caché

| Recurso | TTL | Beneficio |
|---------|-----|-----------|
| Análisis de video (Gemini) | 30 min | Evita re-análisis del mismo video |
| Copy generado (Claude) | 2 horas | Usuario puede regenerar, pero caché de fondo |
| Viral score | 1 hora | Cálculo expensive, reutilizable |
| Analytics data | 5 min | Reducir queries a Supabase |
| Trending hashtags | 24 horas | Actualización diaria de TikTok/Instagram |
| Config global | 24 horas | API keys, limits, settings |

#### Implementación

**Archivo: `src/services/cacheService.js`**

```javascript
const redis = require('ioredis');

const cache = new redis(process.env.REDIS_URL || 'redis://localhost:6379');

const CACHE_KEYS = {
  VIRAL_SCORE: (videoId) => `viral_score:${videoId}`,
  ANALYTICS: (videoId) => `analytics:${videoId}`,
  GEMINI_ANALYSIS: (videoId) => `gemini:${videoId}`,
  TRENDING_TAGS: 'trending:hashtags',
  SOCIAL_STATUS: (artistId) => `social:${artistId}`,
};

async function getOrCompute(key, computeFn, ttlSeconds = 3600) {
  try {
    const cached = await cache.get(key);
    if (cached) return JSON.parse(cached);

    const result = await computeFn();
    await cache.setex(key, ttlSeconds, JSON.stringify(result));
    return result;
  } catch (error) {
    console.error(`Cache error for key ${key}:`, error);
    return computeFn(); // Fallback a compute directo
  }
}

async function invalidate(pattern) {
  const keys = await cache.keys(pattern);
  if (keys.length > 0) {
    await cache.del(...keys);
  }
}

module.exports = { cache, getOrCompute, invalidate, CACHE_KEYS };
```

#### Uso en aiService.js

```javascript
const { getOrCompute, CACHE_KEYS } = require('./cacheService');

// Antes: siempre llamar a Gemini
// const analysis = await analyzeWithGemini(videoUrl);

// Después: cachear resultado
const analysis = await getOrCompute(
  CACHE_KEYS.GEMINI_ANALYSIS(videoId),
  () => analyzeWithGemini(videoUrl),
  1800 // 30 minutos
);
```

#### Estrategia de Invalidación

```javascript
// Cuando se publica un video, invalidar caches relacionados
router.post('/publish/:videoId', authenticateToken, async (req, res) => {
  // ... publish logic
  
  // Limpiar caches del video
  await invalidate(`*:${videoId}`);
  
  // Limpiar caches del artista
  await invalidate(`analytics:${artistId}:*`);
  
  res.json({ success: true });
});
```

#### Estimación de Ahorro

```
Scenario: 100 videos procesados/día

Sin cache:
- Groq: 100 calls × $0.0001 = $0.01
- Gemini: 100 calls × $0.0005 = $0.05
- Claude: 100 calls × $0.020 = $2.00
Total/día: $2.06 × 30 = $61.80/mes

Con cache (70% hit rate):
- Llamadas reducidas a 30/día
- Total/mes: $30 × 30 = $900/mes
Ahorro: ~$850/mes en IA

+ Mejor latencia (cache response: 1ms vs API: 2-5s)
```

#### Checklist de Implementación
- [ ] Provisionar Redis (Railway o Upstash)
- [ ] Crear cache service
- [ ] Integrar en aiService
- [ ] Integrar en analyticsService
- [ ] Implementar invalidación estratégica
- [ ] Monitorear hit rates
- [ ] Documentar estrategia de caché
- [ ] Pruebas de performance

#### Referencias
- Redis CLI: https://redis.io/commands/
- ioredis Docs: https://github.com/luin/ioredis
- Railway Redis: https://docs.railway.app/databases/redis

---

### 4. DOCUMENTACIÓN API (Swagger/OpenAPI)

**Prioridad:** 🔴 CRÍTICO  
**Esfuerzo:** 12-16 horas  
**ROI:** Medio-Alto (facilita integración externa)  
**Estado:** ❌ No implementado

#### Descripción
Documentar automáticamente todos los endpoints de la API para facilitar debugging y integración de terceros.

#### Instalación

```bash
npm install swagger-ui-express swagger-jsdoc
```

#### Configuración

**Archivo: `src/config/swagger.js`**

```javascript
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Vidalis API',
      version: '1.0.0',
      description: 'API para gestión de contenido IA para creadores',
      contact: {
        name: 'Vidalis Support',
        email: 'support@vidalis.ai',
      },
    },
    servers: [
      {
        url: 'https://vidalis.up.railway.app/api/vidalis',
        description: 'Production Server',
      },
      {
        url: 'http://localhost:3001/api/vidalis',
        description: 'Development Server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  apis: ['./src/routes/*.js', './src/controllers/*.js'],
};

const specs = swaggerJsdoc(options);

module.exports = (app) => {
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(specs));
};
```

#### Documentar Rutas

**Ejemplo en `src/routes/vidalisRoutes.js`**

```javascript
/**
 * @swagger
 * /login:
 *   post:
 *     summary: Login de usuario
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Login exitoso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *       401:
 *         description: Credenciales inválidas
 */
router.post('/login', vidalisController.login);

/**
 * @swagger
 * /upload:
 *   post:
 *     summary: Subir y procesar video
 *     tags: [Videos]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               artistId:
 *                 type: string
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Video procesado exitosamente
 *       401:
 *         description: No autorizado
 *       413:
 *         description: Archivo demasiado grande
 */
router.post('/upload', authenticateToken, vidalisController.processVideo);
```

#### Integración en app.js

```javascript
const setupSwagger = require('./config/swagger');

const app = express();

// ... otros middlewares ...

// Swagger UI disponible en http://localhost:3001/api/docs
setupSwagger(app);
```

#### Checklist de Implementación
- [ ] Instalar swagger-jsdoc y swagger-ui
- [ ] Crear config/swagger.js
- [ ] Documentar todos los endpoints
- [ ] Documentar schemas de request/response
- [ ] Documentar errores posibles
- [ ] Probar en navegador (/api/docs)
- [ ] Generar OpenAPI JSON
- [ ] Publicar documentación externa (Readme.so, etc)

#### Referencias
- Swagger/OpenAPI: https://swagger.io/
- swagger-jsdoc: https://github.com/Surnet/swagger-jsdoc
- OpenAPI 3.0 Spec: https://spec.openapis.org/oas/v3.0.3

---

## 🟠 FEATURES IMPORTANTES

### 5. EMAIL NOTIFICATIONS

**Prioridad:** 🟠 IMPORTANTE  
**Esfuerzo:** 8-12 horas  
**ROI:** Medio (retención de usuarios)  
**Estado:** ❌ No implementado

#### Descripción
Enviar notificaciones por email a usuarios sobre eventos importantes.

#### Servicio Recomendado

```bash
# Resend (moderno, fácil) - Recomendado
npm install resend

# O SendGrid (enterprise)
npm install @sendgrid/mail

# O Mailgun
npm install mailgun.js
```

#### Implementación con Resend

**Archivo: `src/services/emailService.js`**

```javascript
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const EMAIL_TEMPLATES = {
  WELCOME: 'welcome',
  VIDEO_PROCESSED: 'video-processed',
  VIDEO_PUBLISHED: 'video-published',
  WEEKLY_REPORT: 'weekly-report',
  ERROR_ALERT: 'error-alert',
};

async function sendEmail(email, template, data) {
  try {
    const templates = {
      welcome: {
        subject: '¡Bienvenido a Vidalis! 🚀',
        html: `<h1>Hola ${data.name}</h1><p>Tu cuenta está lista.</p>`,
      },
      'video-processed': {
        subject: `✅ Tu video "${data.title}" está listo`,
        html: `<h1>Video procesado</h1>
               <p>Título: ${data.title}</p>
               <p>Copy generado: ${data.copy}</p>
               <a href="https://vidalis.up.railway.app/dashboard/video/${data.videoId}">Ver en dashboard</a>`,
      },
      'video-published': {
        subject: `🎉 ¡Video publicado exitosamente!`,
        html: `<h1>Publicación completada</h1>
               <p>Publicado en: ${data.platforms.join(', ')}</p>
               <p>Views: ${data.views || 'Cargando...'}</p>`,
      },
      'weekly-report': {
        subject: `📊 Reporte semanal de Vidalis`,
        html: `<h1>Tu semana en números</h1>
               <p>Videos: ${data.videosCount}</p>
               <p>Total Views: ${data.totalViews}</p>
               <p>Engagement Rate: ${data.engagementRate}%</p>`,
      },
    };

    const template_data = templates[template];
    if (!template_data) throw new Error(`Template ${template} no existe`);

    const result = await resend.emails.send({
      from: 'Vidalis <noreply@vidalis.ai>',
      to: email,
      subject: template_data.subject,
      html: template_data.html,
    });

    return result;
  } catch (error) {
    console.error(`Error enviando email a ${email}:`, error);
    throw error;
  }
}

module.exports = { sendEmail, EMAIL_TEMPLATES };
```

#### Eventos que Generan Emails

```javascript
// En vidalisController.js

const { sendEmail } = require('../services/emailService');

// 1. Bienvenida (signup)
router.post('/onboarding', authenticateToken, async (req, res) => {
  const user = req.user;
  // ... onboarding logic
  await sendEmail(user.email, 'welcome', { name: user.name });
});

// 2. Video procesado
async function processVideoComplete(videoId, user) {
  const video = await supabase
    .from('videos')
    .select('*')
    .eq('id', videoId)
    .single();
  
  await sendEmail(user.email, 'video-processed', {
    title: video.title,
    copy: video.ai_copy_short,
    videoId: videoId,
  });
}

// 3. Video publicado
async function onVideoPublished(videoId, user, platforms) {
  await sendEmail(user.email, 'video-published', {
    platforms: platforms,
    videoId: videoId,
  });
}

// 4. Reporte semanal (cron job)
async function sendWeeklyReport(userId) {
  const stats = await getWeeklyStats(userId);
  await sendEmail(user.email, 'weekly-report', {
    videosCount: stats.videos,
    totalViews: stats.views,
    engagementRate: stats.engagement,
  });
}
```

#### Plantillas HTML

**Archivo: `src/templates/emails/video-processed.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .button { 
      background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%);
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      text-decoration: none;
      display: inline-block;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>✅ Tu video está listo</h1>
    <p>Hola {{name}},</p>
    <p>Tu video <strong>"{{title}}"</strong> ha sido procesado exitosamente por nuestra IA.</p>
    
    <h3>Copy generado:</h3>
    <blockquote>{{copy}}</blockquote>
    
    <p>
      <a href="{{dashboardUrl}}" class="button">Ver en Dashboard</a>
    </p>
    
    <hr>
    <small>© 2026 Vidalis.AI</small>
  </div>
</body>
</html>
```

#### Variables de Entorno

```bash
# .env
RESEND_API_KEY=re_xxxxxxxxxxxxx
EMAIL_FROM=noreply@vidalis.ai
SUPPORT_EMAIL=support@vidalis.ai
```

#### Checklist de Implementación
- [ ] Elegir servicio (Resend recomendado)
- [ ] Instalar dependencia
- [ ] Crear email service
- [ ] Crear plantillas HTML
- [ ] Integrar en eventos clave
- [ ] Setup de cron jobs (weekly report)
- [ ] Testing de emails
- [ ] Documentar plantillas

#### Referencias
- Resend Docs: https://resend.com/docs
- SendGrid Docs: https://docs.sendgrid.com/
- MJML (Template Builder): https://mjml.io/

---

### 6. REAL-TIME UPDATES (WebSockets)

**Prioridad:** 🟠 IMPORTANTE  
**Esfuerzo:** 24-32 horas  
**ROI:** Medio (UX mejorada)  
**Estado:** ❌ No implementado

#### Descripción
Implementar WebSockets para actualizaciones en tiempo real del progreso de videos y notificaciones.

#### Stack Recomendado

```bash
npm install socket.io socket.io-client
```

#### Implementación Backend

**Archivo: `src/app.js`**

```javascript
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS.split(','),
    credentials: true,
  },
});

// Autenticar conexión WebSocket
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    const user = verifyToken(token);
    socket.userId = user.id;
    socket.agencyId = user.agencyId;
    next();
  } catch (error) {
    next(new Error('Autenticación fallida'));
  }
});

// Eventos de conexión
io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.userId}`);

  // Usuario se une a sala de su agencia
  socket.join(`agency:${socket.agencyId}`);

  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.userId}`);
  });
});

httpServer.listen(3001, () => {
  console.log('Server running with WebSockets support');
});

module.exports = { httpServer, io };
```

#### Eventos WebSocket

**Archivo: `src/services/websocketService.js`**

```javascript
const { io } = require('../app');

// Emitir progreso de procesamiento de video
function emitVideoProgress(agencyId, videoId, progress) {
  io.to(`agency:${agencyId}`).emit('video:progress', {
    videoId,
    progress, // 0-100
    status: 'processing',
  });
}

// Emitir video completado
function emitVideoComplete(agencyId, videoId, data) {
  io.to(`agency:${agencyId}`).emit('video:complete', {
    videoId,
    copy: data.copy,
    viralScore: data.viralScore,
    thumbnail: data.thumbnail,
  });
}

// Emitir error en procesamiento
function emitVideoError(agencyId, videoId, error) {
  io.to(`agency:${agencyId}`).emit('video:error', {
    videoId,
    message: error.message,
    timestamp: new Date(),
  });
}

// Emitir notificación general
function notifyUser(userId, title, message) {
  io.to(`user:${userId}`).emit('notification', {
    title,
    message,
    timestamp: new Date(),
  });
}

module.exports = {
  emitVideoProgress,
  emitVideoComplete,
  emitVideoError,
  notifyUser,
};
```

#### Uso en aiService.js

```javascript
const { emitVideoProgress, emitVideoComplete, emitVideoError } = require('./websocketService');

async function processVideoAI(videoId, agencyId, videoUrl) {
  try {
    // Paso 1: Transcripción
    emitVideoProgress(agencyId, videoId, 25);
    const transcript = await transcribeWithGroq(videoUrl);

    // Paso 2: Análisis
    emitVideoProgress(agencyId, videoId, 50);
    const analysis = await analyzeWithGemini(videoUrl);

    // Paso 3: Copy
    emitVideoProgress(agencyId, videoId, 75);
    const copy = await generateCopyWithClaude(transcript, analysis);

    // Completado
    emitVideoProgress(agencyId, videoId, 100);
    emitVideoComplete(agencyId, videoId, {
      copy: copy.short,
      viralScore: analysis.viralScore,
      thumbnail: extractVideoThumbnail(videoUrl),
    });

  } catch (error) {
    emitVideoError(agencyId, videoId, error);
  }
}
```

#### Frontend (React)

**Archivo: `src/hooks/useWebSocket.js`**

```javascript
import { useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';

export function useWebSocket() {
  const [socket, setSocket] = useState(null);
  const [videoProgress, setVideoProgress] = useState({});

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('vidalis_user'));
    const newSocket = io(import.meta.env.VITE_API_URL, {
      auth: { token: user?.token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    newSocket.on('video:progress', (data) => {
      setVideoProgress(prev => ({
        ...prev,
        [data.videoId]: data.progress,
      }));
    });

    newSocket.on('video:complete', (data) => {
      console.log('Video completado:', data);
      // Refrescar galería
    });

    newSocket.on('video:error', (data) => {
      console.error('Error en video:', data);
    });

    newSocket.on('notification', (data) => {
      // Mostrar notificación al usuario
    });

    setSocket(newSocket);

    return () => newSocket.disconnect();
  }, []);

  return { socket, videoProgress };
}
```

#### Uso en Componente

```jsx
import { useWebSocket } from '../hooks/useWebSocket';

export function VideoGallery({ artistId }) {
  const { videoProgress } = useWebSocket();

  return (
    <div>
      {videos.map(video => (
        <div key={video.id}>
          <h3>{video.title}</h3>
          {videoProgress[video.id] && (
            <ProgressBar value={videoProgress[video.id]} />
          )}
        </div>
      ))}
    </div>
  );
}
```

#### Checklist de Implementación
- [ ] Instalar socket.io en backend y frontend
- [ ] Crear socket middleware de autenticación
- [ ] Crear websocket service
- [ ] Integrar en aiService
- [ ] Crear custom hook de WebSocket
- [ ] Actualizar componentes para usar WebSocket
- [ ] Testing de conexión/desconexión
- [ ] Manejo de reconexión automática
- [ ] Monitorear conexiones activas

#### Referencias
- Socket.io Docs: https://socket.io/docs/
- Socket.io Client: https://socket.io/docs/client-api/

---

### 7. ADMIN DASHBOARD

**Prioridad:** 🟠 IMPORTANTE  
**Esfuerzo:** 32-40 horas  
**ROI:** Alto (control y monitoreo)  
**Estado:** ❌ No implementado

#### Descripción
Panel administrativo para gestionar usuarios, facturación, soporte y estadísticas globales.

#### Rutas Admin

**Archivo: `src/routes/adminRoutes.js`**

```javascript
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');

// Todas las rutas requieren admin
router.use(authenticateToken, requireAdmin);

// Dashboard
router.get('/dashboard/stats', adminController.getDashboardStats);
router.get('/dashboard/revenue', adminController.getRevenueStats);
router.get('/dashboard/errors', adminController.getErrorStats);

// Usuarios
router.get('/users', adminController.listUsers);
router.get('/users/:userId', adminController.getUserDetail);
router.patch('/users/:userId/status', adminController.updateUserStatus);
router.delete('/users/:userId', adminController.deleteUser);

// Agencias
router.get('/agencies', adminController.listAgencies);
router.get('/agencies/:agencyId', adminController.getAgencyDetail);
router.patch('/agencies/:agencyId/plan', adminController.updateAgencyPlan);

// Billing
router.get('/billing/invoices', adminController.listInvoices);
router.post('/billing/refund', adminController.processRefund);

// Support
router.get('/support/tickets', adminController.listSupportTickets);
router.patch('/support/tickets/:ticketId', adminController.updateTicket);

// Logs/Monitoring
router.get('/logs/errors', adminController.getErrorLogs);
router.get('/logs/api-calls', adminController.getApiCallLogs);

// Moderación
router.get('/moderation/videos', adminController.getPendingVideos);
router.patch('/moderation/videos/:videoId/approve', adminController.approveVideo);
router.patch('/moderation/videos/:videoId/reject', adminController.rejectVideo);

module.exports = router;
```

#### Frontend Admin

**Archivo: `src/pages/Admin/AdminDashboard.jsx`**

```jsx
import React, { useState, useEffect } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

export function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    fetchStats();
  }, []);

  async function fetchStats() {
    const user = JSON.parse(localStorage.getItem('vidalis_user'));
    const response = await fetch(
      `${import.meta.env.VITE_API_URL}/api/admin/dashboard/stats`,
      { headers: { Authorization: `Bearer ${user.token}` } }
    );
    setStats(await response.json());
  }

  if (!stats) return <div>Cargando...</div>;

  return (
    <div style={{ padding: '40px' }}>
      <h1>Admin Dashboard</h1>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '20px', marginBottom: '30px', borderBottom: '1px solid #ddd' }}>
        {['overview', 'users', 'billing', 'logs'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '10px 20px',
              borderBottom: tab === t ? '2px solid blue' : 'none',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontWeight: tab === t ? 'bold' : 'normal',
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '20px' }}>
            <StatCard title="Total Users" value={stats.totalUsers} />
            <StatCard title="Total Revenue" value={`$${stats.totalRevenue}`} />
            <StatCard title="Videos Procesados" value={stats.videosProcessed} />
            <StatCard title="API Calls (hoy)" value={stats.apiCallsToday} />
          </div>

          <h2 style={{ marginTop: '40px' }}>Revenue Trend</h2>
          <LineChart width={800} height={300} data={stats.revenueData}>
            <CartesianGrid />
            <XAxis dataKey="date" />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="revenue" stroke="#8884d8" />
          </LineChart>
        </div>
      )}

      {/* Users */}
      {tab === 'users' && (
        <div>
          <h2>Users</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd' }}>
                <th style={{ padding: '10px', textAlign: 'left' }}>Email</th>
                <th>Plan</th>
                <th>Creado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {stats.users?.map(user => (
                <tr key={user.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '10px' }}>{user.email}</td>
                  <td>{user.plan}</td>
                  <td>{new Date(user.created_at).toLocaleDateString()}</td>
                  <td>
                    <button>Detalles</button>
                    <button>Suspender</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Billing */}
      {tab === 'billing' && (
        <div>
          <h2>Facturación</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd' }}>
                <th style={{ padding: '10px', textAlign: 'left' }}>Usuario</th>
                <th>Monto</th>
                <th>Fecha</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {stats.invoices?.map(invoice => (
                <tr key={invoice.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '10px' }}>{invoice.email}</td>
                  <td>${invoice.amount}</td>
                  <td>{new Date(invoice.date).toLocaleDateString()}</td>
                  <td>{invoice.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({ title, value }) {
  return (
    <div style={{ border: '1px solid #ddd', padding: '20px', borderRadius: '8px' }}>
      <p style={{ margin: '0 0 10px', color: '#666' }}>{title}</p>
      <h3 style={{ margin: 0, fontSize: '24px' }}>{value}</h3>
    </div>
  );
}
```

#### Middleware Admin

**Archivo: `src/middleware/authMiddleware.js`**

```javascript
function requireAdmin(req, res, next) {
  const user = req.user;

  // Verificar si es admin
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  next();
}

module.exports = { requireAdmin };
```

#### Checklist de Implementación
- [ ] Crear tabla de `admin_logs` en Supabase
- [ ] Crear adminController con todos los métodos
- [ ] Crear adminRoutes
- [ ] Agregar middleware requireAdmin
- [ ] Crear página Admin en frontend
- [ ] Implementar gráficos (Recharts)
- [ ] Implementar tablas de usuarios/facturas
- [ ] Crear sistema de permisos granular
- [ ] Pruebas de acceso (solo admin)

#### Referencias
- Recharts: https://recharts.org/
- React Admin: https://marmelab.com/react-admin/

---

### 8. DATA EXPORT (CSV, PDF)

**Prioridad:** 🟠 IMPORTANTE  
**Esfuerzo:** 12-16 horas  
**ROI:** Medio (GDPR + user retention)  
**Estado:** ❌ No implementado

#### Descripción
Permitir a usuarios exportar sus datos en formatos CSV, PDF y JSON para cumplir GDPR/CCPA.

#### Instalación

```bash
npm install papaparse pdfkit xlsx
```

#### Servicio de Exportación

**Archivo: `src/services/exportService.js`**

```javascript
const { parse } = require('papaparse');
const { createObjectCsvWriter } = require('csv-writer');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const fs = require('fs');

// CSV Export
async function exportToCSV(data, filename) {
  const csvWriter = createObjectCsvWriter({
    path: filename,
    header: Object.keys(data[0] || {}).map(key => ({
      id: key,
      title: key,
    })),
  });
  return csvWriter.writeRecords(data);
}

// PDF Export
async function exportToPDF(data, title) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const filename = `export_${Date.now()}.pdf`;

    doc.pipe(fs.createWriteStream(filename));

    doc.fontSize(16).text(title, 100, 100);
    doc.fontSize(10);

    // Tabla simple
    let yPosition = 150;
    const headers = Object.keys(data[0] || {});
    const columnWidth = 60;

    // Header
    headers.forEach((header, i) => {
      doc.text(header, 100 + i * columnWidth, yPosition);
    });

    yPosition += 20;

    // Rows
    data.forEach(row => {
      headers.forEach((header, i) => {
        doc.text(String(row[header] || ''), 100 + i * columnWidth, yPosition);
      });
      yPosition += 15;
    });

    doc.end();
    resolve(filename);
  });
}

// JSON Export
async function exportToJSON(data, filename) {
  return new Promise((resolve, reject) => {
    fs.writeFile(filename, JSON.stringify(data, null, 2), (err) => {
      if (err) reject(err);
      else resolve(filename);
    });
  });
}

// Excel Export
async function exportToXLSX(data, filename) {
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  XLSX.writeFile(wb, filename);
  return filename;
}

module.exports = {
  exportToCSV,
  exportToPDF,
  exportToJSON,
  exportToXLSX,
};
```

#### Routes de Exportación

**Archivo: `src/routes/vidalisRoutes.js`**

```javascript
/**
 * @swagger
 * /export/analytics/{agencyId}:
 *   get:
 *     summary: Exportar analytics
 *     tags: [Export]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agencyId
 *       - in: query
 *         name: format
 *         schema:
 *           enum: [csv, pdf, json, xlsx]
 *     responses:
 *       200:
 *         description: Archivo exportado
 *       401:
 *         description: No autorizado
 */
router.get(
  '/export/analytics/:agencyId',
  authenticateToken,
  authorizeAgency,
  vidalisController.exportAnalytics
);

router.get(
  '/export/videos/:agencyId',
  authenticateToken,
  authorizeAgency,
  vidalisController.exportVideos
);

router.get(
  '/export/personal-data/:userId',
  authenticateToken,
  vidalisController.exportPersonalData
);
```

#### Controlador

**Archivo: `src/controllers/vidalisController.js`**

```javascript
const { exportToCSV, exportToPDF, exportToJSON, exportToXLSX } = require('../services/exportService');

async function exportAnalytics(req, res) {
  try {
    const { agencyId } = req.params;
    const { format = 'csv' } = req.query;

    // Obtener datos de analytics
    const { data: analytics } = await supabase
      .from('videos')
      .select('id, title, status, created_at, views, likes, shares')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });

    const filename = `analytics_${agencyId}_${Date.now()}.${format}`;

    let filePath;
    switch (format) {
      case 'csv':
        filePath = await exportToCSV(analytics, filename);
        break;
      case 'pdf':
        filePath = await exportToPDF(analytics, 'Analytics Report');
        break;
      case 'json':
        filePath = await exportToJSON(analytics, filename);
        break;
      case 'xlsx':
        filePath = await exportToXLSX(analytics, filename);
        break;
      default:
        return res.status(400).json({ error: 'Formato no soportado' });
    }

    res.download(filePath, filename, (err) => {
      if (!err) fs.unlinkSync(filePath); // Limpiar temporal
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function exportPersonalData(req, res) {
  try {
    const userId = req.user.id;

    // GDPR: Obtener TODOS los datos del usuario
    const [users, agencies, artists, videos, analytics] = await Promise.all([
      supabase.from('users').select('*').eq('id', userId),
      supabase.from('agencies').select('*').eq('owner_id', userId),
      supabase.from('artists').select('*').eq('user_id', userId),
      supabase.from('videos').select('*').eq('user_id', userId),
      supabase.from('analytics').select('*').eq('user_id', userId),
    ]);

    const allData = {
      user: users.data,
      agencies: agencies.data,
      artists: artists.data,
      videos: videos.data,
      analytics: analytics.data,
      exportDate: new Date().toISOString(),
    };

    const filename = `personal-data-${userId}-${Date.now()}.json`;
    const filePath = await exportToJSON(allData, filename);

    res.download(filePath, filename, (err) => {
      if (!err) fs.unlinkSync(filePath);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  exportAnalytics,
  exportPersonalData,
  // ... otros
};
```

#### Frontend

**Archivo: `src/components/ExportButton.jsx`**

```jsx
import React, { useState } from 'react';
import { Download } from 'lucide-react';

export function ExportButton({ agencyId }) {
  const [format, setFormat] = useState('csv');
  const [loading, setLoading] = useState(false);

  async function handleExport() {
    setLoading(true);
    const user = JSON.parse(localStorage.getItem('vidalis_user'));
    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_URL}/api/vidalis/export/analytics/${agencyId}?format=${format}`,
        { headers: { Authorization: `Bearer ${user.token}` } }
      );
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `analytics.${format}`;
      a.click();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <select value={format} onChange={(e) => setFormat(e.target.value)}>
        <option value="csv">CSV</option>
        <option value="xlsx">Excel</option>
        <option value="json">JSON</option>
        <option value="pdf">PDF</option>
      </select>
      <button onClick={handleExport} disabled={loading}>
        <Download size={18} />
        {loading ? 'Exportando...' : 'Exportar'}
      </button>
    </div>
  );
}
```

#### Checklist de Implementación
- [ ] Instalar librerías (csv-writer, pdfkit, xlsx, papaparse)
- [ ] Crear export service
- [ ] Crear rutas de exportación
- [ ] Implementar GDPR data export
- [ ] Crear botón de export en UI
- [ ] Testing de todos los formatos
- [ ] Validar permisos (solo propios datos)
- [ ] Limpiar archivos temporales

#### Referencias
- csv-writer: https://github.com/ryu1kn/csv-writer
- PDFKit: http://pdfkit.org/
- xlsx: https://github.com/SheetJS/sheetjs

---

## 🟡 FEATURES NICE-TO-HAVE

### 9. INTEGRACIONES DE REDES SOCIALES ADICIONALES

**Prioridad:** 🟡 NICE-TO-HAVE (pero importante)  
**Esfuerzo:** 40-50 horas (por red social)  
**ROI:** Muy Alto (más valor a usuarios)  
**Estado:** ❌ Solo Instagram + upload-post

#### Red Social #1: TikTok (Enterprise API)

**Requisitos:**
```
- Solicitar acceso a TikTok Developer
- Pagar fee anual ($25k+)
- Implementar OAuth flow
```

**Endpoints Principales:**
```
POST /api/tiktok/connect       // OAuth authorize
POST /api/tiktok/publish       // Publicar video
GET /api/tiktok/analytics      // Stats del video
```

#### Red Social #2: YouTube (Google API)

**Requisitos:**
```
- Google Cloud Project
- OAuth 2.0 setup
- YouTube Data API v3
```

#### Red Social #3: LinkedIn

**Requisitos:**
```
- LinkedIn Developer App
- LinkedIn Shares API
- Para B2B creators
```

**Prioridad de Implementación:**
1. TikTok (80% de viralidad nueva)
2. YouTube (largos + shorts)
3. LinkedIn (B2B, profesionales)

---

### 10. VIDEO EDITOR INTEGRADO

**Prioridad:** 🟡 NICE-TO-HAVE  
**Esfuerzo:** 60-80 horas  
**ROI:** Alto (reduce fricción)  
**Estado:** ❌ No implementado

#### Stack Recomendado

```bash
# Server-side
npm install fluent-ffmpeg ffmpeg-static sharp

# Client-side
npm install ffmpeg.js @ffmpeg/ffmpeg (web version)
```

#### Características Mínimas

1. **Trim/Cut** - Cortar principio/final
2. **Resize** - Ajustar a formato de red social
3. **Overlay Text** - Captions automáticos
4. **Watermark** - Marca de agua
5. **Auto-Clips** - Generar shorts de video largo

#### Arquitectura

```
Frontend (React)
  ↓
Backend (ffmpeg)
  ↓
Cloudinary (almacenar resultado)
```

---

### 11. SISTEMA DE TEMPLATES

**Prioridad:** 🟡 NICE-TO-HAVE  
**Esfuerzo:** 24-32 horas  
**ROI:** Medio (UX mejorada)  
**Estado:** ❌ No implementado

#### Templates Disponibles

```javascript
const templates = [
  {
    id: 'quote',
    name: 'Quote Card',
    description: 'Cita motivacional con fondo de gradiente',
    thumbnail: 'quote.png',
    fields: ['text', 'author', 'bgColor'],
  },
  {
    id: 'testimonial',
    name: 'Testimonial',
    description: 'Testimonio de cliente',
    fields: ['text', 'author', 'rating', 'image'],
  },
  {
    id: 'announcement',
    name: 'Anuncio',
    description: 'Anuncio importante con CTA',
    fields: ['title', 'message', 'ctaText', 'ctaUrl'],
  },
];
```

---

### 12. PREDICCIÓN DE VIRALIDAD ML

**Prioridad:** 🟡 NICE-TO-HAVE  
**Esfuerzo:** 80-120 horas  
**ROI:** Muy Alto (diferenciador)  
**Estado:** ❌ Score básico implementado

#### Mejorar Viral Score

Usar machine learning para predecir views/engagement.

**Variables de entrada:**
- Hora de publicación
- Hashtags
- Descripción (análisis de sentimiento)
- Duración del video
- Formato (vertical/horizontal)
- Música (trending o no)
- Colores prominentes
- Velocidad de edición

**Herramientas:**
```bash
npm install tensorflow.js @tensorflow-models/coco-ssd
# O usar servicio externo: Hugging Face
```

---

## 🏗️ ARQUITECTURA TÉCNICA

### Base de Datos (Supabase)

```sql
-- Tablas principales
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR UNIQUE,
  password_hash VARCHAR,
  role VARCHAR (admin, user),
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

CREATE TABLE agencies (
  id UUID PRIMARY KEY,
  owner_id UUID REFERENCES users,
  name VARCHAR,
  stripe_customer_id VARCHAR,
  plan VARCHAR (free, pro, enterprise),
  created_at TIMESTAMP
);

CREATE TABLE artists (
  id UUID PRIMARY KEY,
  agency_id UUID REFERENCES agencies,
  name VARCHAR,
  socials JSONB,
  style TEXT,
  created_at TIMESTAMP
);

CREATE TABLE videos (
  id UUID PRIMARY KEY,
  agency_id UUID REFERENCES agencies,
  artist_id UUID REFERENCES artists,
  source_url VARCHAR,
  processed_url VARCHAR,
  title VARCHAR,
  ai_copy_short TEXT,
  ai_copy_long TEXT,
  viral_score DECIMAL,
  status VARCHAR (pending, processing, analyzing, ready, published, error),
  created_at TIMESTAMP
);

CREATE TABLE analytics (
  id UUID PRIMARY KEY,
  video_id UUID REFERENCES videos,
  platform VARCHAR (instagram, tiktok, youtube),
  views INTEGER,
  likes INTEGER,
  shares INTEGER,
  comments INTEGER,
  timestamp TIMESTAMP
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users,
  action VARCHAR,
  resource VARCHAR,
  details JSONB,
  created_at TIMESTAMP
);
```

### Flujo de Procesamiento

```
1. Usuario sube video
   ↓
2. Validar (tamaño, formato)
   ↓
3. Subir a Cloudinary
   ↓
4. Extraer audio → Groq Whisper (transcripción)
   ↓
5. Analizar thumbnail → Gemini Vision (análisis visual)
   ↓
6. Generar copy → Claude Sonnet (escritura)
   ↓
7. Calcular viral score → ML model
   ↓
8. Guardar en BD + notificar usuario via WebSocket
   ↓
9. Usuario puede publicar en redes
```

---

## 📚 STACK ACTUAL

| Capa | Tecnología | Versión |
|------|-----------|---------|
| **Frontend** | React | 19.2 |
| | Vite | 8.0 |
| | React Router | 7.13 |
| | Lucide Icons | 0.577 |
| | Framer Motion | 12.38 |
| **Backend** | Express.js | 4.22 |
| | Node.js | 18+ |
| **BD** | Supabase | 2.99 |
| | PostgreSQL | 14+ |
| **Almacenamiento** | Cloudinary | 2.9 |
| **IA** | Claude API | 0.80 |
| | Gemini API | 0.24 |
| | Groq Whisper | (HTTP) |
| **Auth** | JWT | jsonwebtoken 9.0 |
| | Google OAuth | google-auth-library 10.6 |
| | Instagram OAuth | Meta API |
| **Seguridad** | Helmet | 8.1 |
| | bcryptjs | 3.0 |
| | Rate Limiting | express-rate-limit 8.3 |
| **Hosting** | Railway | (Cloud) |
| **SEO/Performance** | Lighthouse | 100/100 |
| | Accessibility | 95/100 |

---

## 🎯 PRÓXIMOS PASOS

### Semana 1-2: CRÍTICOS
- [ ] Implementar Testing (Jest + Vitest)
- [ ] Setup Logging (Winston + Sentry)
- [ ] Configurar Redis cache

### Semana 3-4: IMPORTANTES
- [ ] Email notifications (Resend)
- [ ] WebSockets (Socket.io)
- [ ] Admin Dashboard

### Mes 2: EXPANSIÓN
- [ ] Más redes sociales (TikTok, YouTube)
- [ ] Video editor básico
- [ ] System de templates

### Mes 3+: DIFERENCIACIÓN
- [ ] ML para viralidad
- [ ] Mobile app (React Native)
- [ ] Marketplace de plugins

---

## 📞 CONTACTO Y SOPORTE

**Proyecto:** Vidalis  
**Desarrollado por:** Juan Saavedra  
**Stack:** Node.js + React + Supabase + IA  
**Última actualización:** 2026-06-12

Para preguntas o sugerencias, crear issue en GitHub.

---

**Happy Coding! 🚀**
