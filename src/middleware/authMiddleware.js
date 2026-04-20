const jwt = require('jsonwebtoken');

/**
 * Middleware para validar el Token JWT en las peticiones.
 * El token debe venir en el header: Authorization: Bearer <token>
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
    
    // Guardamos los datos del usuario en el objeto request para uso posterior
    req.user = user;
    next();
  });
};

/**
 * Middleware para verificar que el usuario tenga acceso a un recurso de agencia específico.
 * Compara el id del usuario autenticado con el id solicitado.
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
 * Middleware para verificar acceso a un Artista.
 * Verifica en la DB que el artist_id pertenezca a la agency_id del token.
 */
const authorizeArtist = async (req, res, next) => {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  
  const artistId = req.params.artistId || req.body.artistId;
  if (!artistId) return next();

  try {
    const { data: artist, error } = await supabase
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

module.exports = { authenticateToken, authorizeAgency, authorizeArtist };
