require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./services/loggerService');

// Validación de variables de entorno críticas
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'CLOUDINARY_URL'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
  logger.error('CRITICAL: Missing environment variables', { missing });
  logger.warn('Asegúrate de configurar el archivo .env correctamente');
  if (process.env.NODE_ENV === 'production') process.exit(1);
}
const { jsonrepair } = require('jsonrepair');
const vidalisRoutes = require('./routes/vidalisRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway/Vercel proxy para que rate-limit identifique IPs reales
app.set('trust proxy', 1);

// CORS - Configuración fija de URLs y Métodos
// Debe ir antes del rate limiter: si el límite corta la respuesta primero,
// esa respuesta (429) sale sin cabeceras CORS y el navegador lo reporta
// como error de CORS en vez de "demasiadas peticiones".
const ALLOWED_ORIGINS = [
  'https://vidalis.up.railway.app',
  'https://vidalis-frontend-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:5173',
  'http://localhost:5174',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else if (origin) {
    // Si hay un origin pero no está en la lista blanca, bloqueamos por seguridad
    return res.status(403).json({ error: 'Origen no autorizado' });
  }

  // Pasamos al siguiente middleware (necesario para que la app no se trabe)
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

// Middleware de logging para API calls
app.use((req, res, next) => {
  const startTime = Date.now();
  const originalSend = res.send;

  res.send = function(data) {
    const duration = Date.now() - startTime;
    logger.apiCall(req.method, req.path, res.statusCode, duration, {
      ip: req.ip,
      userId: req.user?.id || 'anonymous',
    });
    return originalSend.call(this, data);
  };

  next();
});

// Seguridad Base
app.use(helmet());
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Límite de 100 peticiones por IP por ventana
  message: { error: 'Demasiadas peticiones desde esta IP, por favor intenta más tarde.' }
});
app.use('/api/', limiter);

// Body parser con auto-reparación para JSON malformado (ej: n8n con newlines o comillas sin escapar)
app.use((req, res, next) => {
  if (!req.headers['content-type']?.includes('application/json')) return next();
  let raw = '';
  req.on('data', chunk => { raw += chunk.toString('utf8'); });
  req.on('end', () => {
    if (!raw) { req.body = {}; return next(); }
    req.rawBody = raw; // preservar para verificación HMAC en webhooks
    try {
      req.body = JSON.parse(raw);
    } catch {
      try {
        req.body = JSON.parse(jsonrepair(raw));
        logger.debug('JSON repaired automatically', { bodySize: raw.length });
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }
    next();
  });
  req.on('error', () => res.status(400).json({ error: 'Body read error' }));
});

// Rutas de la API
logger.info('Registering routes', { path: '/api/vidalis' });
app.use('/api/vidalis', vidalisRoutes);

app.get('/', (req, res) => {
  res.send('Vidalis API is running... 🚀');
});

app.listen(PORT, () => {
  logger.info('Server started', { port: PORT, env: process.env.NODE_ENV || 'development' });
});
