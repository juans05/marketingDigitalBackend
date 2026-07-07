const express = require('express');
const router = express.Router();
const vidalisController = require('../controllers/vidalisController');
const {
  authenticateToken,
  authorizeAgency,
  authorizeArtist,
  authorizeVideo,
  verifyWebhookSecret,
  requireFeature,
} = require('../middleware/authMiddleware');

// ── Config pública (sin auth) ─────────────────────────────────────────────────
router.get('/config/:key', vidalisController.getConfig);

// ── Autenticación (pública) ───────────────────────────────────────────────────
router.post('/login', vidalisController.login);
router.post('/google-login', vidalisController.googleLogin);
router.get('/me', authenticateToken, vidalisController.getMe);
router.post('/refine-copy', authenticateToken, vidalisController.refineCopy);
router.post('/analyze-content', authenticateToken, requireFeature('analytics_sync'), vidalisController.analyzeContentStrategy);
router.post('/visual-score', authenticateToken, vidalisController.scoreVisualVirality);

// ── Agencias y Artistas ───────────────────────────────────────────────────────
router.post('/agencies', authenticateToken, vidalisController.createAgency);
router.post('/artists', authenticateToken, vidalisController.createArtist);
router.get('/artists/:agencyId', authenticateToken, authorizeAgency, vidalisController.getArtists);
router.delete('/artists/:artistId', authenticateToken, authorizeArtist, vidalisController.deleteArtist);
router.post('/artists/:artistId/sync', authenticateToken, authorizeArtist, vidalisController.syncSocialAccounts);
router.post('/artists/:artistId/sync-analytics', authenticateToken, authorizeArtist, vidalisController.syncZernioAnalytics);
router.patch('/artists/:artistId/style', authenticateToken, authorizeArtist, vidalisController.updateArtistStyle);
router.patch('/profile', authenticateToken, requireFeature('profile_update'), vidalisController.updateProfile);
router.post('/artists/:artistId/audit', authenticateToken, authorizeArtist, vidalisController.runDeepAudit);

// Requería auth — añadida
router.patch('/artist-publish-mode/:artistId', authenticateToken, authorizeArtist, vidalisController.setPublishMode);

// ── Onboarding ────────────────────────────────────────────────────────────────
router.post('/onboarding', authenticateToken, vidalisController.completeOnboarding);
router.post('/complete-tour', authenticateToken, vidalisController.completeTour);

// ── Videos ────────────────────────────────────────────────────────────────────
router.post('/upload', authenticateToken, vidalisController.processVideo);
router.post('/videos/from-url', authenticateToken, vidalisController.uploadFromUrl);
router.post('/repurpose/upload', authenticateToken, authorizeArtist, vidalisController.createRepurposeVideo);
router.get('/gallery/:artistId', authenticateToken, authorizeArtist, vidalisController.getGallery);

// authorizeVideo verifica que el video pertenezca al agency del token
router.get('/video/:videoId', authenticateToken, authorizeVideo, vidalisController.getVideoById);
router.get('/video/:videoId/publish-status', authenticateToken, authorizeVideo, vidalisController.getPublishStatus);
router.patch('/video/:videoId', authenticateToken, authorizeVideo, vidalisController.updateVideo);
router.post('/video/:videoId/retry', authenticateToken, authorizeVideo, vidalisController.retryVideo);
router.delete('/video/:videoId', authenticateToken, authorizeVideo, vidalisController.deleteVideo);
router.post('/publish-now/:videoId', authenticateToken, authorizeVideo, vidalisController.publishNow);
router.post('/check-hashtags', authenticateToken, vidalisController.checkHashtags);
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
router.get('/platform-analytics/:artistId', authenticateToken, authorizeArtist, vidalisController.getPlatformAnalytics);
router.get('/content-learnings/:artistId', authenticateToken, authorizeArtist, vidalisController.getContentLearnings);

// ── Cloudinary ────────────────────────────────────────────────────────────────
router.get('/cloudinary-signature', authenticateToken, vidalisController.getSignature);

// ── Redes Sociales ────────────────────────────────────────────────────────────
router.get('/connect-social/:artistId', authenticateToken, authorizeArtist, vidalisController.connectSocial);
router.get('/social-status/:artistId', authenticateToken, authorizeArtist, vidalisController.getSocialStatus);
// publish recibe artistId en el body → authorizeArtist lo lee de req.body.artistId
router.post('/publish', authenticateToken, authorizeArtist, vidalisController.publishToSocial);

// ── Meta OAuth (callback público — inicia desde navegador del usuario) ────────
router.get('/instagram/callback', vidalisController.instagramCallback);

// ── Growth Pro ────────────────────────────────────────────────────────────────
router.get('/artists/:artistId/growth/insights', authenticateToken, authorizeArtist, vidalisController.getGrowthInsights);
router.get('/artists/:artistId/growth/best-time', authenticateToken, authorizeArtist, vidalisController.getGrowthBestTime);
router.get('/artists/:artistId/growth/strategy', authenticateToken, authorizeArtist, vidalisController.getGrowthStrategy);
router.get('/artists/:artistId/growth/viral-history', authenticateToken, authorizeArtist, vidalisController.getViralHistory);
router.post('/videos/:videoId/ab-variants', authenticateToken, authorizeVideo, vidalisController.generateABVariants);
router.get('/videos/:videoId/ab-result', authenticateToken, authorizeVideo, vidalisController.getABResult);
router.post('/videos/:videoId/ad-copy', authenticateToken, authorizeVideo, vidalisController.generateAdCopy);

// ── Zernio: Comentarios & Inbox ──────────────────────────────────────────────
router.get('/comments/:artistId', authenticateToken, authorizeArtist, vidalisController.getArtistComments);
router.get('/comments/:postId/replies', authenticateToken, vidalisController.getPostComments);
router.post('/comments/:postId/reply', authenticateToken, vidalisController.replyToComment);
router.post('/comments/:postId/:commentId/hide', authenticateToken, vidalisController.hideCommentToggle);
router.post('/comments/:postId/:commentId/like', authenticateToken, vidalisController.likeCommentToggle);
router.delete('/comments/:postId', authenticateToken, vidalisController.deleteComment);

// ── Zernio: Automatizaciones (Comment-to-DM) ─────────────────────────────────
router.get('/automations/:artistId', authenticateToken, authorizeArtist, vidalisController.getAutomations);
router.post('/automations/:artistId', authenticateToken, authorizeArtist, vidalisController.createAutomation);
router.get('/automations/details/:automationId', authenticateToken, vidalisController.getAutomationDetails);
router.patch('/automations/:automationId', authenticateToken, vidalisController.updateAutomation);
router.delete('/automations/:automationId', authenticateToken, vidalisController.deleteAutomation);

// ── Zernio: Webhook Receptor (raw body — protegido con HMAC en controller) ──
router.post('/webhooks/zernio', vidalisController.zernioWebhook);

// ── IdeaBank ─────────────────────────────────────────────────────────────────
router.get('/ideas/:artistId', authenticateToken, authorizeArtist, vidalisController.getIdeas);
router.post('/ideas/:artistId/generate', authenticateToken, authorizeArtist, vidalisController.generateIdeas);
router.post('/ideas/:ideaId/swipe', authenticateToken, vidalisController.swipeIdea);
router.put('/ideas/:ideaId/rate', authenticateToken, vidalisController.rateIdea);
router.get('/ideas/:artistId/saved', authenticateToken, authorizeArtist, vidalisController.getSavedIdeas);
router.post('/ideas/:ideaId/expand', authenticateToken, vidalisController.expandIdea);
router.get('/style-profile/:artistId', authenticateToken, authorizeArtist, vidalisController.getStyleProfile);
router.post('/style-profile/:artistId/analyze', authenticateToken, authorizeArtist, vidalisController.analyzeStyle);

// ── Trends ───────────────────────────────────────────────────────────────────
router.get('/trends/:artistId', authenticateToken, authorizeArtist, vidalisController.getTrends);
router.get('/trends/:artistId/references', authenticateToken, authorizeArtist, vidalisController.getTrendReferences);
router.post('/trends/:artistId/references', authenticateToken, authorizeArtist, vidalisController.addTrendReference);
router.delete('/trends/references/:refId', authenticateToken, vidalisController.removeTrendReference);

// ── Notifications ────────────────────────────────────────────────────────────
router.get('/notifications/:artistId', authenticateToken, authorizeArtist, vidalisController.getNotifications);
router.patch('/notifications/:notifId/read', authenticateToken, vidalisController.markNotificationRead);
router.post('/notifications/:artistId/read-all', authenticateToken, authorizeArtist, vidalisController.markAllNotificationsRead);

// ── Growth History ───────────────────────────────────────────────────────────
router.get('/growth/:artistId', authenticateToken, authorizeArtist, vidalisController.getGrowthHistory);

// ── Media Kit ────────────────────────────────────────────────────────────────
router.get('/media-kit/:artistId', authenticateToken, authorizeArtist, vidalisController.getMediaKit);
router.put('/media-kit/:artistId', authenticateToken, authorizeArtist, vidalisController.updateMediaKit);
router.get('/media-kit/public/:slug', vidalisController.getPublicMediaKit);

// ── Collaborations ───────────────────────────────────────────────────────────
router.get('/collabs/:artistId', authenticateToken, authorizeArtist, vidalisController.getCollaborations);
router.post('/collabs/:artistId', authenticateToken, authorizeArtist, vidalisController.createCollaboration);
router.put('/collabs/:collabId', authenticateToken, vidalisController.updateCollaboration);
router.delete('/collabs/:collabId', authenticateToken, vidalisController.deleteCollaboration);
router.get('/collabs/:artistId/stats', authenticateToken, authorizeArtist, vidalisController.getCollabStats);

// ── Rate Calculator ──────────────────────────────────────────────────────────
router.get('/rate-calculator/:artistId', authenticateToken, authorizeArtist, vidalisController.calculateRates);

// ── Competitor Spy ──────────────────────────────────────────────────────────
const competitorController = require('../controllers/competitorController');
router.get('/competitors/:artistId', authenticateToken, authorizeArtist, competitorController.getCompetitors);
router.post('/competitors/:artistId', authenticateToken, authorizeArtist, competitorController.addCompetitor);
router.put('/competitors/edit/:competitorId', authenticateToken, competitorController.updateCompetitor);
router.delete('/competitors/edit/:competitorId', authenticateToken, competitorController.deleteCompetitor);
router.post('/competitors/analyze/:competitorId', authenticateToken, competitorController.analyzeCompetitor);
router.get('/competitors/analysis/:competitorId', authenticateToken, competitorController.getLastAnalysis);
router.get('/competitors/history/:competitorId', authenticateToken, competitorController.getCompetitorHistory);
router.post('/competitors/content/:competitorId', authenticateToken, competitorController.analyzeCompetitorContent);
router.post('/competitors/steal-ideas/:competitorId', authenticateToken, competitorController.stealIdeas);
router.get('/artists/:artistId/snapshot-tracking', authenticateToken, authorizeArtist, competitorController.getSnapshotStatus);
router.put('/artists/:artistId/snapshot-tracking', authenticateToken, authorizeArtist, competitorController.toggleSnapshotTracking);

module.exports = router;
