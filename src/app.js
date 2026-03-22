require('dotenv').config();
const express = require('express');
const cors = require('cors');
const vidalisRoutes = require('./routes/vidalisRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

// Configuración de CORS dinámica
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:3001',
  'https://marketing-digital-frontend.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permitir peticiones sin origen (como Insomnia o Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true
}));

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
