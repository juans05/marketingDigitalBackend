require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Validación de variables de entorno críticas
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'CLOUDINARY_URL'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`\x1b[31m%s\x1b[0m`, `❌ ERROR CRÍTICO: Faltan variables de entorno: ${missing.join(', ')}`);
  console.error(`\x1b[33m%s\x1b[0m`, `   Asegúrate de configurar el archivo .env correctamente.`);
  if (process.env.NODE_ENV === 'production') process.exit(1);
}
const { jsonrepair } = require('jsonrepair');
const vidalisRoutes = require('./routes/vidalisRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

// Seguridad Base
app.use(helmet()); 
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Límite de 100 peticiones por IP por ventana
  message: { error: 'Demasiadas peticiones desde esta IP, por favor intenta más tarde.' }
});
app.use('/api/', limiter);

// CORS robusto para producción
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Permitir cualquier origen en desarrollo, o ser más restrictivos en prod si se desea
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Body parser con auto-reparación para JSON malformado (ej: n8n con newlines o comillas sin escapar)
app.use((req, res, next) => {
  if (!req.headers['content-type']?.includes('application/json')) return next();
  let raw = '';
  req.on('data', chunk => { raw += chunk.toString('utf8'); });
  req.on('end', () => {
    if (!raw) { req.body = {}; return next(); }
    try {
      req.body = JSON.parse(raw);
    } catch {
      try {
        req.body = JSON.parse(jsonrepair(raw));
        console.warn('⚠️  JSON reparado automáticamente en body parser');
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }
    next();
  });
  req.on('error', () => res.status(400).json({ error: 'Body read error' }));
});

// Rutas de la API
console.log("🛠️ Registrando rutas en /api/vidalis...");
app.use('/api/vidalis', vidalisRoutes);

app.get('/', (req, res) => {
  res.send('Vidalis API is running... 🚀');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
