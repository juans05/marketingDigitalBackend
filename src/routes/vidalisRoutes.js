const express = require('express');
const router = express.Router();
const vidalisController = require('../controllers/vidalisController');
const {
  authenticateToken,
  authorizeAgency,
  authorizeArtist,
  authorizeVideo,
  verifyWebhookSecret,
} = require('../middleware/authMiddleware');

// ── Autenticación (pública) ───────────────────────────────────────────────────
router.post('/login', vidalisController.login);
router.post('/google-login', vidalisController.googleLogin);
router.post('/refine-copy', authenticateToken, vidalisController.refineCopy);

// ── Agencias y Artistas ───────────────────────────────────────────────────────
router.post('/agencies', authenticateToken, vidalisController.createAgency);
router.post('/artists', authenticateToken, vidalisController.createArtist);
router.get('/artists/:agencyId', authenticateToken, authorizeAgency, vidalisController.getArtists);
router.delete('/artists/:artistId', authenticateToken, authorizeArtist, vidalisController.deleteArtist);
router.post('/artists/:artistId/sync', authenticateToken, authorizeArtist, vidalisController.syncSocialAccounts);
router.patch('/artists/:artistId/style', authenticateToken, authorizeArtist, vidalisController.updateArtistStyle);
router.post('/artists/:artistId/audit', authenticateToken, authorizeArtist, vidalisController.runDeepAudit);

// Requería auth — añadida
router.patch('/artist-publish-mode/:artistId', authenticateToken, authorizeArtist, vidalisController.setPublishMode);

// ── Onboarding ────────────────────────────────────────────────────────────────
router.post('/onboarding', authenticateToken, vidalisController.completeOnboarding);

// ── Videos ────────────────────────────────────────────────────────────────────
router.post('/upload', authenticateToken, vidalisController.processVideo);
router.post('/videos/from-url', authenticateToken, vidalisController.uploadFromUrl);
router.get('/gallery/:artistId', authenticateToken, authorizeArtist, vidalisController.getGallery);

// authorizeVideo verifica que el video pertenezca al agency del token
router.patch('/video/:videoId', authenticateToken, authorizeVideo, vidalisController.updateVideo);
router.post('/video/:videoId/retry', authenticateToken, authorizeVideo, vidalisController.retryVideo);
router.post('/publish-now/:videoId', authenticateToken, authorizeVideo, vidalisController.publishNow);
router.post('/schedule/:videoId', authenticateToken, authorizeVideo, vidalisController.scheduleVideo);
router.get('/clips/:parentId', authenticateToken, authorizeVideo, vidalisController.getClips);

// Webhook externo de n8n — protegido con secreto compartido (no JWT de usuario)
router.post('/n8n-callback/:videoId', verifyWebhookSecret, vidalisController.n8nCallback);
router.patch('/n8n-callback/:videoId', verifyWebhookSecret, vidalisController.n8nCallback);

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics/:videoId', authenticateToken, authorizeVideo, vidalisController.getVideoAnalytics);
router.get('/stats/:agencyId', authenticateToken, authorizeAgency, vidalisController.getDashboardStats);
router.post('/purchase-sparks', authenticateToken, vidalisController.purchaseSparks);
router.post('/redeem-coupon', authenticateToken, vidalisController.redeemCoupon);
router.post('/viral-score', authenticateToken, vidalisController.getViralScore);
router.get('/analytics-posts/:artistId', authenticateToken, authorizeArtist, vidalisController.getPostMetrics);
router.get('/analytics-insights/:artistId', authenticateToken, authorizeArtist, vidalisController.getAnalyticsInsights);

// ── Cloudinary ────────────────────────────────────────────────────────────────
router.get('/cloudinary-signature', authenticateToken, vidalisController.getSignature);

// ── Redes Sociales ────────────────────────────────────────────────────────────
router.get('/connect-social/:artistId', authenticateToken, authorizeArtist, vidalisController.connectSocial);
router.get('/social-status/:artistId', authenticateToken, authorizeArtist, vidalisController.getSocialStatus);
// publish recibe artistId en el body → authorizeArtist lo lee de req.body.artistId
router.post('/publish', authenticateToken, authorizeArtist, vidalisController.publishToSocial);

// ── Meta OAuth (callback público — inicia desde navegador del usuario) ────────
router.get('/instagram/callback', vidalisController.instagramCallback);

module.exports = router;
