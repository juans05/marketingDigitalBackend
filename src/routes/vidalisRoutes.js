const express = require('express');
const router = express.Router();
const vidalisController = require('../controllers/vidalisController');

// Autenticación
router.post('/login', vidalisController.login);

// Agencias y Artistas
router.post('/agencies', vidalisController.createAgency);
router.post('/artists', vidalisController.createArtist);
router.get('/artists/:agencyId', vidalisController.getArtists);

// Videos
router.post('/upload', vidalisController.processVideo);
router.get('/gallery/:artistId', vidalisController.getGallery);
router.patch('/video/:videoId', vidalisController.updateVideo);
router.post('/n8n-callback/:videoId', vidalisController.n8nCallback);
router.post('/publish-now/:videoId', vidalisController.publishNow);
router.get('/clips/:parentId', vidalisController.getClips);

// Analytics
router.get('/analytics/:videoId', vidalisController.getVideoAnalytics);
router.get('/stats/:agencyId', vidalisController.getDashboardStats);
router.post('/viral-score', vidalisController.getViralScore);

// Cloudinary
router.get('/cloudinary-signature', vidalisController.getSignature);

// Redes Sociales (por artista)
router.get('/connect-social/:artistId', vidalisController.connectSocial);
router.get('/social-status/:artistId', vidalisController.getSocialStatus);
router.post('/publish', vidalisController.publishToSocial);

module.exports = router;
