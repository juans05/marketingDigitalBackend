const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Cliente admin: usa service role key para verificaciones de ownership sin que RLS interfiera.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

/**
 * Valida el JWT y almacena req.user = { id, email, account_type }.
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Acceso denegado. Se requiere token de autenticación.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido o expirado.' });
    }
    req.user = user;
    // Guardar el token raw para poder crear clientes Supabase con contexto de usuario
    req.rawToken = token;
    next();
  });
};

/**
 * Verifica que el usuario autenticado sea dueño del agencyId solicitado.
 */
const authorizeAgency = (req, res, next) => {
  const agencyId = req.params.agencyId || req.body.agencyId;
  if (!agencyId) return next();

  if (req.user.id !== agencyId && req.user.account_type !== 'admin') {
    return res.status(403).json({ error: 'No tienes permiso para acceder a los recursos de esta agencia.' });
  }
  next();
};

/**
 * Verifica que el artistId del parámetro pertenezca al agency del token.
 */
const authorizeArtist = async (req, res, next) => {
  const artistId = req.params.artistId || req.body.artistId;
  if (!artistId) return next();

  try {
    const { data: artist, error } = await supabaseAdmin
      .from('artists')
      .select('agency_id')
      .eq('id', artistId)
      .single();

    if (error || !artist) return res.status(404).json({ error: 'Artista no encontrado.' });

    if (artist.agency_id !== req.user.id && req.user.account_type !== 'admin') {
      return res.status(403).json({ error: 'No tienes permiso para gestionar este artista.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error de autorización.' });
  }
};

/**
 * Verifica que el videoId (o parentId) pertenezca a un artista del agency del token.
 * También acepta req.params.parentId para el endpoint /clips/:parentId.
 */
const authorizeVideo = async (req, res, next) => {
  const videoId = req.params.videoId || req.params.parentId;
  if (!videoId) return next();

  try {
    const { data: video, error } = await supabaseAdmin
      .from('videos')
      .select('id, artist_id, artists!inner(agency_id)')
      .eq('id', videoId)
      .single();

    if (error || !video) return res.status(404).json({ error: 'Video no encontrado.' });

    if (video.artists.agency_id !== req.user.id && req.user.account_type !== 'admin') {
      return res.status(403).json({ error: 'No tienes permiso para acceder a este video.' });
    }

    req.video = video; // disponible para el controller si lo necesita
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error de autorización.' });
  }
};

/**
 * Protege webhooks externos (n8n, etc.).
 * Requiere el header x-webhook-secret con el valor de WEBHOOK_SECRET.
 * Si WEBHOOK_SECRET no está configurado, permite pasar (compatibilidad hacia atrás).
 */
const verifyWebhookSecret = (req, res, next) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return next();

  const provided = req.headers['x-webhook-secret'];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Webhook secret inválido o ausente.' });
  }
  next();
};

module.exports = {
  authenticateToken,
  authorizeAgency,
  authorizeArtist,
  authorizeVideo,
  verifyWebhookSecret,
};
