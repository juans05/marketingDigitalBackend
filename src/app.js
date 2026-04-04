require('dotenv').config();
const express = require('express');

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

// CORS manual — primer middleware, antes de todo, incluso si hay errores posteriores
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
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
