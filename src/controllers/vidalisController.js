const vidalisService = require('../services/vidalisService');
const cloudinaryService = require('../services/cloudinaryService');
const ayrshareService = require('../services/ayrshareService');

// --- LOGIN ---
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Se requiere email y contraseña' });
    }

    const userData = await vidalisService.loginUser(email, password);
    res.status(200).json(userData);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
};

exports.createAgency = async (req, res) => {
  try {
    const agencyData = req.body;
    const result = await vidalisService.createAgency(agencyData);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createArtist = async (req, res) => {
  try {
    const artistData = req.body;
    const result = await vidalisService.createArtist(artistData);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getSignature = (req, res) => {
  try {
    const { folder } = req.query; // Leemos la carpeta de la query param
    const signatureData = cloudinaryService.generateUploadSignature(folder);
    res.status(200).json(signatureData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.processVideo = async (req, res) => {
  try {
    const { videoData } = req.body;
    // Validaciones de negocio adicionales aquí
    const result = await vidalisService.registerVideo(videoData);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getGallery = async (req, res) => {
  try {
    const { artistId } = req.params;
    const gallery = await vidalisService.fetchArtistGallery(artistId);
    res.status(200).json(gallery);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getVideoAnalytics = async (req, res) => {
  try {
    const { videoId } = req.params;
    const data = await vidalisService.getVideoAnalytics(videoId);
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    const { agencyId } = req.params;
    const stats = await vidalisService.getDashboardStats(agencyId);
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getViralScore = async (req, res) => {
  try {
    const { videoUrl } = req.body;
    const score = await vidalisService.analyzeViralPotential(videoUrl);
    res.status(200).json(score);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.connectSocial = async (req, res) => {
  try {
    const { agencyId } = req.params;
    const result = await vidalisService.connectSocialAccounts(agencyId);
    res.status(200).json(result);
  } catch (error) {
    const ayrshareError = error.response?.data;
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message, details: ayrshareError });
  }
};

/**
 * POST /api/publish
 * Publica un video con hashtags en las redes sociales via Ayrshare.
 *
 * Body esperado:
 * {
 *   "text": "Nuevo video de Juan 🎵 #música #viral #latino",
 *   "platforms": ["facebook", "instagram", "tiktok"],
 *   "mediaUrls": ["https://res.cloudinary.com/.../video.mp4"],
 *   "profileKey": "ak-xxxx",   ← opcional, de la agencia
 *   "isPreview": false,        ← opcional, true para simular sin publicar
 *   "facebookOptions": { "title": "Título del video" },
 *   "instagramOptions": { "reels": true },
 *   "tiktokOptions": { "videoTitle": "Título TikTok" },
 *   "youtubeOptions": { "title": "Título YouTube", "visibility": "public", "youtubeShortsPost": true }
 * }
 */
exports.publishToSocial = async (req, res) => {
  try {
    const {
      text,
      platforms,
      mediaUrls,
      profileKey,
      isPreview,
      facebookOptions,
      instagramOptions,
      tiktokOptions,
      youtubeOptions,
      linkedinOptions,
      twitterOptions
    } = req.body;

    if (!text || !platforms || platforms.length === 0) {
      return res.status(400).json({ error: 'Se requiere text y al menos una plataforma' });
    }

    const options = { facebookOptions, instagramOptions, tiktokOptions, youtubeOptions, linkedinOptions, twitterOptions };

    const result = await ayrshareService.publishPost(
      text,
      platforms,
      mediaUrls || [],
      profileKey || null,
      options,
      isPreview || false
    );

    res.status(200).json(result);
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;
    res.status(status).json({ error: message });
  }
};
exports.updateVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const updateData = req.body;
    const result = await vidalisService.updateVideoSettings(videoId, updateData);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getClips = async (req, res) => {
  try {
    const { parentId } = req.params;
    const clips = await vidalisService.getClipsByParent(parentId);
    res.status(200).json(clips);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
