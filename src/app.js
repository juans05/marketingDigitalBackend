require('dotenv').config();
const express = require('express');
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

app.use(express.json());

// Rutas de la API
console.log("🛠️ Registrando rutas en /api/vidalis...");
app.use('/api/vidalis', vidalisRoutes);

app.get('/', (req, res) => {
  res.send('Vidalis API is running... 🚀');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
