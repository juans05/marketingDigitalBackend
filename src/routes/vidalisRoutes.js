const express = require('express');
const router = express.Router();
const vidalisController = require('../controllers/vidalisController');
const { authenticateToken, authorizeAgency, authorizeArtist } = require('../middleware/authMiddleware');

// Autenticación
router.post('/login', vidalisController.login);

// Agencias y Artistas (Protegidos)
router.post('/agencies', authenticateToken, vidalisController.createAgency);
router.post('/artists', authenticateToken, vidalisController.createArtist);
router.get('/artists/:agencyId', authenticateToken, authorizeAgency, vidalisController.getArtists);
router.delete('/artists/:artistId', authenticateToken, authorizeArtist, vidalisController.deleteArtist);
router.post('/artists/:artistId/sync', authenticateToken, authorizeArtist, vidalisController.syncSocialAccounts);
router.patch('/artists/:artistId/style', authenticateToken, authorizeArtist, vidalisController.updateArtistStyle);
router.post('/artists/:artistId/audit', authenticateToken, authorizeArtist, vidalisController.runDeepAudit);

// Onboarding
router.post('/onboarding', authenticateToken, vidalisController.completeOnboarding);

// Videos
router.post('/upload', authenticateToken, vidalisController.processVideo);
router.get('/gallery/:artistId', authenticateToken, authorizeArtist, vidalisController.getGallery);
router.patch('/video/:videoId', authenticateToken, vidalisController.updateVideo);
router.post('/video/:videoId/retry', authenticateToken, vidalisController.retryVideo);
router.post('/n8n-callback/:videoId', vidalisController.n8nCallback); // Callback externo no lleva token
router.patch('/n8n-callback/:videoId', vidalisController.n8nCallback);
router.post('/publish-now/:videoId', authenticateToken, vidalisController.publishNow);
router.get('/clips/:parentId', authenticateToken, vidalisController.getClips);

// Analytics
router.get('/analytics/:videoId', authenticateToken, vidalisController.getVideoAnalytics);
router.get('/stats/:agencyId', authenticateToken, authorizeAgency, vidalisController.getDashboardStats);
router.post('/viral-score', authenticateToken, vidalisController.getViralScore);
router.get('/analytics-posts/:artistId', authenticateToken, authorizeArtist, vidalisController.getPostMetrics);
router.get('/analytics-insights/:artistId', authenticateToken, authorizeArtist, vidalisController.getAnalyticsInsights);

// Cloudinary
router.get('/cloudinary-signature', authenticateToken, vidalisController.getSignature);

// Redes Sociales (por artista)
router.get('/connect-social/:artistId', authenticateToken, authorizeArtist, vidalisController.connectSocial);
router.get('/social-status/:artistId', authenticateToken, authorizeArtist, vidalisController.getSocialStatus);
router.post('/publish', authenticateToken, vidalisController.publishToSocial);

// Meta OAuth (modo directo — sin Ayrshare)
router.get('/instagram/callback', vidalisController.instagramCallback);
router.patch('/artist-publish-mode/:artistId', vidalisController.setPublishMode);

module.exports = router;
