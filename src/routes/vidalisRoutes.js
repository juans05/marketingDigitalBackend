const express = require('express');
const router = express.Router();
const vidalisController = require('../controllers/vidalisController');

// Autenticación
router.post('/login', vidalisController.login);

// Rutas para procesar videos
router.post('/upload', vidalisController.processVideo);

// Rutas para Gestión Multi-tenant
router.post('/agencies', vidalisController.createAgency);
router.post('/artists', vidalisController.createArtist);

// Ruta para obtener galería de un artista
router.get('/gallery/:artistId', vidalisController.getGallery);

// Analytics de un video específico
router.get('/analytics/:videoId', vidalisController.getVideoAnalytics);

// Estadísticas globales del dashboard
router.get('/stats/:agencyId', vidalisController.getDashboardStats);

// Ruta para obtener firma de Cloudinary
router.get('/cloudinary-signature', vidalisController.getSignature);

// Programación y edición de videos
router.patch('/video/:videoId', vidalisController.updateVideo);

// Obtener clips relacionados
router.get('/clips/:parentId', vidalisController.getClips);

// Conectar redes sociales de una agencia via Ayrshare
router.get('/connect-social/:agencyId', vidalisController.connectSocial);

// Publicación en redes sociales via Ayrshare
router.post('/publish', vidalisController.publishToSocial);

module.exports = router;
