require('dotenv').config();
const express = require('express');
const cors = require('cors');
const vidalisRoutes = require('./routes/vidalisRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

// Configuración de CORS — responde a todos los orígenes con sus propios headers
const corsOptions = {
  origin: (origin, callback) => callback(null, origin || '*'),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
// Responder preflight OPTIONS explícitamente en todas las rutas
app.options('*', cors(corsOptions));

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
