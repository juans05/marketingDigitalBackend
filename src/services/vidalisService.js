const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const PQueue = require('p-queue').default;
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const googleClient = new OAuth2Client();

// Cola para llamadas a n8n — evita saturar el workflow con uploads simultáneos
const n8nQueue = new PQueue({ concurrency: 2 }); // máx 2 análisis en paralelo

// Cola interna para procesamiento con Gemini+Claude
const internalQueue = new PQueue({ concurrency: 2 }); // máx 2 análisis simultáneos internos

/**
 * Routing de IA:
 * - AI_MODE=internal  → siempre usa Gemini+Claude directamente
 * - AI_MODE=n8n       → siempre usa n8n (comportamiento anterior)
 * - AI_MODE=hybrid    → usa interno si la cola está libre; si está llena → n8n como overflow
 */
const AI_MODE = process.env.AI_MODE || 'internal';

/**
 * Inicia sesión o registra a un usuario mediante un ID Token de Google.
 * @param {string} idToken - Token enviado desde la app móvil.
 * @param {string} platform - 'android' | 'ios'
 */
exports.loginWithGoogle = async (idToken, platform = 'android') => {
  const clientId = platform === 'ios' 
    ? process.env.GOOGLE_CLIENT_ID_IOS 
    : process.env.GOOGLE_CLIENT_ID_ANDROID;

  try {
    logger.log('info', 'GOOGLE_LOGIN_ATTEMPT', { platform });
    
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: clientId
    });
    const payload = ticket.getPayload();
    const { email, name, sub: googleId } = payload;

    logger.log('success', 'GOOGLE_TOKEN_VERIFIED', { email });

    // 1. Buscar o crear usuario
    return await exports.loginUser(email, googleId, 'individual', name);

  } catch (error) {
    logger.log('error', 'GOOGLE_LOGIN_FAILED', { 
      error: error.message, 
      clientId: clientId ? `${clientId.substring(0, 10)}...` : 'MISSING' 
    });
    console.error('❌ Error verificando Google Token:', error.message);
    throw new Error(`Error de Google: ${error.message}`);
  }
};

const N8N_QUEUE_THRESHOLD = parseInt(process.env.N8N_QUEUE_THRESHOLD || '3', 10);
const BYPASS_PLAN_LIMITS = process.env.BYPASS_PLAN_LIMITS === 'true';

const aiService = require('./aiService');
const instagramService = require('./instagramService');
const uploadPostService = require('./uploadPostService');
const socialPublisher = require('./socialPublisher');
const cloudinary = require('cloudinary').v2;
const logger = require('./loggerService');

const PLAN_CONFIG = {
  'Mini': { videos: 5, platforms: ['instagram', 'tiktok'], calendar: false },
  'Artista': { videos: 20, platforms: ['instagram', 'facebook', 'tiktok'], calendar: true },
  'Estrella': { videos: 60, platforms: ['tiktok', 'instagram', 'facebook', 'youtube', 'linkedin'], calendar: true },
  'Agencia Pro': { videos: Infinity, platforms: ['tiktok', 'instagram', 'facebook', 'youtube', 'linkedin'], calendar: true },
};

function shouldUseInternal() {
  if (AI_MODE === 'internal') return true;
  if (AI_MODE === 'n8n') return false;
  // hybrid: usar interno si la cola interna tiene menos trabajos que el umbral
  return internalQueue.size < N8N_QUEUE_THRESHOLD;
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ ERROR: Faltan SUPABASE_URL o SUPABASE_ANON_KEY en las variables de entorno.");
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️  SUPABASE_SERVICE_ROLE_KEY no configurada — usando anon key (RLS activo, puede causar errores).");
}

// Service role key: bypassa RLS para operaciones internas del backend.
// Obtener en Supabase > Settings > API > service_role key.
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

// Cliente con anon key para operaciones que requieren contexto de usuario (uso futuro).
exports.createUserSupabase = (userJwt) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
  });

// --- AUTENTICACIÓN ---
// accountType: 'agency' | 'artist' | null (login existente)
// displayName: nombre para el registro (opcional)
exports.loginUser = async (email, password, accountType = null, displayName = null, birthDate = null) => {
  if (!email || !password) throw new Error('Se requiere email y contraseña');

  // Buscar cuenta existente por email
  const { data: users, error: searchError } = await supabase
    .from('agencies')
    .select('*')
    .eq('email', email)
    .limit(1);

  if (searchError) throw new Error('Error al buscar usuario');

  const user = users?.[0];

  if (user) {
    // 1. Validar contraseña si existe password_hash
    if (user.password_hash) {
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) throw new Error('Email o contraseña incorrectos');
    } else {
      // ⚠️ Caso borde: El usuario existe pero no tiene hash (ej: migración antigua)
      // Por seguridad en este punto, vamos a crear el hash con la password que envió
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(password, salt);
      await supabase.from('agencies').update({ password_hash: hash }).eq('id', user.id);
      console.warn(`🔐 Contraseña hasheada automáticamente para el usuario: ${email}`);
    }

    const resolvedType = user.account_type || 'agency';

    let artist_id = null;
    if (resolvedType === 'artist') {
      const { data: artists } = await supabase
        .from('artists')
        .select('id')
        .eq('agency_id', user.id)
        .limit(1);
      if (artists?.[0]) artist_id = artists[0].id;
    }

    const payload = {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan_type,
      sparks_balance: user.sparks_balance || 0,
      account_type: resolvedType,
      artist_id,
      onboarding_completed: user.onboarding_completed || false,
    };

    // Firmar Token JWT para seguridad móvil
    // sub = agency UUID (compatible con Supabase auth.uid() para RLS en acceso directo)
    const token = jwt.sign(
      { sub: user.id, id: user.id, email: user.email, account_type: resolvedType },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    logger.log('success', 'USER_LOGIN', { email: user.email, plan: user.plan_type }, user.id);
    return {
      ...payload,
      token
    };
  }

  // Si llegamos aquí, es un intento de login fallido o nuevo registro
  if (user) {
    logger.log('warn', 'LOGIN_FAILED', { email, reason: 'Password mismatch' });
    throw new Error('Email o contraseña incorrectos');
  }

  // --- REGISTRO DE NUEVO USUARIO ---
  const name = displayName || email.split('@')[0];
  const salt = await bcrypt.genSalt(10);
  const password_hash = await bcrypt.hash(password, salt);

  const { data: newAgencies, error: agencyErr } = await supabase
    .from('agencies')
    .insert([{
      name,
      email,
      password_hash,
      plan_type: 'Mini',
      account_type: accountType || 'agency',
      ...(birthDate && { birth_date: birthDate })
    }])
    .select();

  if (agencyErr) {
    logger.log('error', 'USER_REGISTER_FAILED', { email, error: agencyErr.message });
    console.error('Error insertando agencia:', agencyErr);
    throw new Error('No se pudo completar el registro. Inténtalo de nuevo.');
  }

  const newAgency = newAgencies[0];
  logger.log('success', 'USER_REGISTERED', { email, plan: 'Mini' }, newAgency.id);

  if (accountType === 'artist') {
    const { data: newArtists, error: artistErr } = await supabase
      .from('artists')
      .insert([{ agency_id: newAgency.id, name }])
      .select();
    if (artistErr) throw new Error('Error al crear perfil de artista');

    return {
      id: newAgency.id,
      email,
      name,
      plan: newAgency.plan_type,
      account_type: 'artist',
      artist_id: newArtists[0].id,
    };
  }

  return {
    id: newAgency.id,
    email,
    name,
    plan: newAgency.plan_type,
    sparks_balance: newAgency.sparks_balance || 100,
    account_type: 'agency',
    artist_id: null,
    birth_date: newAgency.birth_date,
    onboarding_completed: false,
  };
};

// --- COMPRA DE SPARKS ---
// --- COMPRA DE SPARKS ---
exports.purchaseSparks = async (agencyId, amount) => {
  try {
    // 1. Obtener balance actual
    const { data: agency, error: getErr } = await supabase
      .from('agencies')
      .select('sparks_balance')
      .eq('id', agencyId)
      .single();

    if (getErr || !agency) throw new Error('Agencia no encontrada');

    const newBalance = (agency.sparks_balance || 0) + amount;

    // 2. Actualizar balance
    const { error: updErr } = await supabase
      .from('agencies')
      .update({ sparks_balance: newBalance })
      .eq('id', agencyId);

    if (updErr) throw updErr;

    // 3. Registrar transacción
    await supabase.from('sparks_transactions').insert([{
      agency_id: agencyId,
      amount: amount,
      type: 'purchase',
      description: `Compra de ${amount} Sparks`
    }]);

    logger.log('success', 'PURCHASE_SPARKS', { amount, newBalance }, agencyId);
    return { success: true, newBalance };
  } catch (error) {
    console.error('❌ purchaseSparks error:', error.message);
    throw error;
  }
};

// --- CANJEAR CUPÓN ---
exports.redeemCoupon = async (agencyId, code) => {
  try {
    // 1. Buscar cupón
    const { data: coupon, error: findErr } = await supabase
      .from('coupons')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('is_active', true)
      .single();

    if (findErr || !coupon) throw new Error('Cupón inválido o expirado');

    // 2. Verificar vencimiento y usos
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      throw new Error('El cupón ha expirado');
    }
    if (coupon.current_usages >= coupon.max_usages) {
      throw new Error('El cupón ha alcanzado su límite de uso');
    }

    // 3. Aplicar bonificación (Sparks extra)
    const extraSparks = coupon.extra_sparks || 0;
    if (extraSparks > 0) {
      const { data: agency, error: getErr } = await supabase
        .from('agencies')
        .select('sparks_balance')
        .eq('id', agencyId)
        .single();

      if (getErr || !agency) throw new Error('Agencia no encontrada');

      const newBalance = (agency.sparks_balance || 0) + extraSparks;

      await supabase.from('agencies').update({ sparks_balance: newBalance }).eq('id', agencyId);

      // Registrar transacción
      await supabase.from('sparks_transactions').insert([{
        agency_id: agencyId,
        amount: extraSparks,
        type: 'promo_code',
        description: `Cupón canjeado: ${code}`
      }]);

      // Incrementar usos del cupón
      await supabase.from('coupons')
        .update({ current_usages: (coupon.current_usages || 0) + 1 })
        .eq('id', coupon.id);

      logger.log('success', 'COUPON_REDEEMED', { code, reward: coupon.sparks_reward, newBalance }, agencyId);
      return { success: true, extraSparks, newBalance };
    }

    return { success: false, message: 'El cupón no otorga Sparks extra' };
  } catch (error) {
    logger.log('error', 'COUPON_REDEEM_FAILED', { code, error: error.message }, agencyId);
    throw error;
  }
};

// --- COMPLETAR ONBOARDING ---
exports.completeOnboarding = async (data) => {
  const { userId, persona, teamSize, goals, firstArtist } = data;

  try {
    // Actualizar tabla agencies con los campos de onboarding
    const { error: agencyErr } = await supabase
      .from('agencies')
      .update({
        onboarding_completed: true,
        account_type: persona,
        team_size: teamSize,
        goals: goals
      })
      .eq('id', userId);

    if (agencyErr) {
      console.warn('⚠️ Error al actualizar campos completos de onboarding. Si faltan columnas, actualizando lo básico...');
      // Fallback si no aplicaron el script SQL
      await supabase.from('agencies').update({ account_type: persona }).eq('id', userId);
    }

    // Si es agencia y registró una marca, insertarla o actualizarla
    if (persona === 'agency' && firstArtist && firstArtist.name) {
      // Verificar si ya existe un artista para esta agencia (para evitar duplicados si se llama dos veces)
      const { data: existing } = await supabase
        .from('artists')
        .select('id')
        .eq('agency_id', userId)
        .eq('name', firstArtist.name)
        .limit(1);

      if (existing && existing.length > 0) {
        // Ya existe, actualizar datos de branding
        const { data: updated, error: updateErr } = await supabase
          .from('artists')
          .update({
            creative_dna: {
              style_notes: firstArtist.style_notes,
              preferred_hooks: firstArtist.preferred_hooks,
              style_keywords: firstArtist.style_keywords,
              prohibited_topics: firstArtist.prohibited_topics
            },
            branding_data: { genre: firstArtist.genre, tone: firstArtist.tone } // Mantener compatibilidad legado
          })
          .eq('id', existing[0].id)
          .select();
        
        if (updateErr) throw updateErr;
        return { success: true, artist: updated[0] };
      } else {
        // No existe, insertar
        const { data: artist, error: artistErr } = await supabase
          .from('artists')
          .insert([{
            agency_id: userId,
            name: firstArtist.name,
            creative_dna: {
              style_notes: firstArtist.style_notes,
              preferred_hooks: firstArtist.preferred_hooks,
              style_keywords: firstArtist.style_keywords,
              prohibited_topics: firstArtist.prohibited_topics
            },
            branding_data: { genre: firstArtist.genre, tone: firstArtist.tone }
          }])
          .select();

        if (artistErr) throw artistErr;
        return { success: true, artist: artist[0] };
      }
    }
    // Si es cuenta individual (creador)
    else if (persona === 'individual') {
      const { data: existingArtists } = await supabase
        .from('artists')
        .select('id')
        .eq('agency_id', userId)
        .limit(1);

      if (!existingArtists || existingArtists.length === 0) {
        const { data: userAgency } = await supabase.from('agencies').select('name').eq('id', userId).single();
        const artistName = userAgency?.name || 'Creador';
        const { data: newArtist, error: artistErr } = await supabase
          .from('artists')
          .insert([{
            agency_id: userId,
            name: artistName,
            creative_dna: {
              style_notes: firstArtist?.style_notes || '',
              preferred_hooks: firstArtist?.preferred_hooks || '',
              style_keywords: firstArtist?.style_keywords || '',
              prohibited_topics: firstArtist?.prohibited_topics || ''
            },
            branding_data: { genre: firstArtist?.genre, tone: firstArtist?.tone }
          }])
          .select();
        if (!artistErr && newArtist) return { success: true, artist: newArtist[0] };
      }
    }

    return { success: true };
  } catch (error) {
    throw new Error('Error al completar onboarding: ' + error.message);
  }
};

// --- GESTIÓN DE AGENCIAS ---
exports.createAgency = async (agencyData) => {
  const { data, error } = await supabase
    .from('agencies')
    .insert([agencyData])
    .select();
  if (error) throw error;
  return data[0];
};

// --- GESTIÓN DE ARTISTAS ---
exports.createArtist = async (artistData) => {
  // Map only the columns that exist in the artists table.
  // The mobile sends `genre` as a convenience field but the DB uses `ai_genre`.
  const { genre, agency_id, name, ai_genre, ai_audience, ai_tone, image_url, tiktok_url, instagram_url, youtube_url } = artistData;
  const row = {
    agency_id,
    name,
    ai_genre: ai_genre ?? genre ?? null,
    ai_audience: ai_audience ?? null,
    ai_tone: ai_tone ?? null,
    ...(image_url && { image_url }),
    ...(tiktok_url && { tiktok_url }),
    ...(instagram_url && { instagram_url }),
    ...(youtube_url && { youtube_url }),
  };
  const { data, error } = await supabase
    .from('artists')
    .insert([row])
    .select();
  if (error) throw error;
  return data[0];
};

exports.getArtistsByAgency = async (agencyId) => {
  const { data, error } = await supabase
    .from('artists')
    .select('id, name, agency_id, active_platforms, ayrshare_profile_key, image_url, tiktok_url, instagram_url, youtube_url, ai_genre, ai_audience, ai_tone, created_at')
    .eq('agency_id', agencyId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
};

// --- SUBIR VIDEO ---
exports.registerVideo = async (videoData) => {
  // Verificar límites del plan antes de proceder
  if (!BYPASS_PLAN_LIMITS) {
    const { data: agency } = await supabase
      .from('artists')
      .select('agencies(id, plan_type)')
      .eq('id', videoData.artist_id)
      .single();

    const planType = agency?.agencies?.plan_type || 'Free';
    const config = PLAN_CONFIG[planType] || PLAN_CONFIG['Free'];

    // Contar videos creados este mes
    const firstDayOfMonth = new Date();
    firstDayOfMonth.setDate(1);
    firstDayOfMonth.setHours(0, 0, 0, 0);

    const { count, error: countErr } = await supabase
      .from('videos')
      .select('id', { count: 'exact', head: true })
      .eq('artist_id', videoData.artist_id)
      .gte('created_at', firstDayOfMonth.toISOString());

    if (!countErr && count >= config.videos) {
      throw new Error(`Has alcanzado el límite de tu plan ${planType} (${config.videos} videos/mes). Por favor, sube de nivel para continuar.`);
    }
  }

  // --- CONTROL DE SPARKS ---
  const SPARK_COST = 10;
  const { data: agencyData } = await supabase
    .from('artists')
    .select('agencies(id, sparks_balance)')
    .eq('id', videoData.artist_id)
    .single();

  const agencyId = agencyData?.agencies?.id;
  const balance = agencyData?.agencies?.sparks_balance ?? 0;

  if (balance < SPARK_COST) {
    throw new Error('No tienes suficientes Sparks (Energía) para procesar este video. Recarga tus Sparks para continuar.');
  }

  // Descontar usando la función RPC (atómica)
  const { data: deductOk } = await supabase.rpc('deduct_sparks', { 
    target_agency_id: agencyId, 
    cost: SPARK_COST 
  });

  if (!deductOk) {
    throw new Error('Error al procesar el gasto de Sparks.');
  }

  // Sanitizar URL — eliminar espacios que rompen Cloudinary
  if (videoData.source_url) {
    videoData.source_url = videoData.source_url.replace(/\s+/g, '');
  }

  const isCloudinary = videoData.source_url?.includes('cloudinary.com');
  const looksLikeVideo = videoData.source_url?.includes('/video/') || videoData.source_url?.match(/\.(mp4|mov|webm|ogv)$/i);

  if (isCloudinary) {
    // Generar URLs optimizadas para cada plataforma
    videoData.platform_urls = getPlatformUrls(videoData.source_url);
    // processed_url sirve como el valor "por defecto" (9:16 vertical)
    videoData.processed_url = buildCloudinaryUrl(videoData.source_url);
    // Inicializar post_type por defecto
    videoData.post_type = looksLikeVideo ? 'reel' : 'feed';
    
    // Generar thumbnail para el dashboard
    if (looksLikeVideo) {
      const parts = videoData.source_url.split('/upload/');
      if (parts.length === 2) {
        const basePath = parts[1].replace(/\.[^/.]+$/, '.jpg');
        videoData.thumbnail_url = `${parts[0]}/upload/so_1.0,w_300,c_limit/${basePath}`;
      }
    } else {
      videoData.thumbnail_url = videoData.processed_url;
    }
  }

  // Verificar que el artist_id es válido
  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('id, ayrshare_profile_key, active_platforms, name, ai_genre, ai_audience, ai_tone')
    .eq('id', videoData.artist_id)
    .single();

  if (artistErr || !artist) throw new Error(`Artista no encontrado: ${videoData.artist_id}`);

  // Guardar en Supabase
  const { data, error } = await supabase
    .from('videos')
    .insert([videoData])
    .select();

  if (error) {
    logger.log('error', 'VIDEO_REGISTRATION_FAILED', { error: error.message, artist_id: videoData.artist_id });
    throw error;
  }
  const video = data[0];
  logger.log('success', 'VIDEO_REGISTERED', { video_id: video.id, title: video.title }, null, 'backend');
  console.log(`✅ Video registrado: ${video.id}`);

  // Disparar procesamiento IA (interno o n8n según AI_MODE)
  try {
    const hasActivePlatforms = artist.active_platforms?.length > 0;
    let targetPlatforms = (video.platforms?.length ? video.platforms : null) ||
      (hasActivePlatforms ? artist.active_platforms : null) ||
      ['tiktok', 'instagram', 'facebook', 'youtube'];

    let platformWarning = null;

    if (!looksLikeVideo) {
      const imageCompatible = targetPlatforms.filter(p => !['tiktok', 'youtube'].includes(p.toLowerCase()));
      if (imageCompatible.length === 0 && hasActivePlatforms) {
        platformWarning = 'Tu cuenta solo tiene conectadas TikTok y/o YouTube, que no aceptan imágenes. Conecta Instagram o Facebook para publicar imágenes.';
        targetPlatforms = [];
      } else {
        targetPlatforms = imageCompatible.length > 0 ? imageCompatible : ['instagram', 'facebook'];
      }
    }

    if (targetPlatforms.length > 0) {
      const useInternal = shouldUseInternal();
      const mediaType = looksLikeVideo ? 'video' : 'image';

      if (useInternal) {
        // --- Procesamiento interno: Gemini + Claude ---
        const aiService = require('./aiService');
        const artistContext = (artist.ai_genre || artist.ai_audience || artist.ai_tone) ? {
          nombre: artist.name,
          genero: artist.ai_genre || null,
          audiencia: artist.ai_audience || null,
          tono: artist.ai_tone || null,
        } : null;

        internalQueue.add(() => aiService.processVideoAI(
          video.id,
          video.processed_url || video.source_url,
          video.source_url,
          mediaType,
          targetPlatforms,
          video.title || '',
          artistContext,
          artist.id
        )).catch(err => console.error(`❌ [AI interno] Cola error video ${video.id}:`, err.message));
        console.log(`🤖 [AI interno] Encolado video ${video.id} (cola: ${internalQueue.size + 1})`);
      } else if (process.env.N8N_WEBHOOK_URL) {
        // --- Fallback: n8n ---
        n8nQueue.add(() => axios.post(process.env.N8N_WEBHOOK_URL, {
          videoUrl: video.processed_url || video.source_url,
          sourceUrl: video.source_url,
          videoId: video.id,
          title: video.title,
          mediaType,
          profileKey: artist.ayrshare_profile_key || null,
          platforms: targetPlatforms,
        })).catch(err => console.error(`❌ [n8n] Error video ${video.id}:`, err.response?.data || err.message));
        console.log(`📤 [n8n] Encolado video ${video.id} (cola interna llena: ${internalQueue.size})`);
      } else {
        console.warn(`⚠️ Video ${video.id}: sin AI_MODE interno ni N8N_WEBHOOK_URL configurado`);
      }
    } else {
      console.warn(`⚠️ Video ${video.id} no procesado: ${platformWarning}`);
    }

    if (platformWarning) video._platformWarning = platformWarning;
  } catch (err) {
    console.error('❌ Error al disparar procesamiento IA:', err.message);
  }

  return video;
};

// --- REINTENTAR PROCESAMIENTO ---
exports.retryVideoProcessing = async (videoId) => {
  // 1. Obtener datos del video
  const { data: video, error: videoErr } = await supabase
    .from('videos')
    .select('*')
    .eq('id', videoId)
    .single();

  if (videoErr || !video) throw new Error('Video no encontrado');

  // 2. Obtener datos del artista para el contexto
  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('id, name, active_platforms, ai_genre, ai_audience, ai_tone')
    .eq('id', video.artist_id)
    .single();

  if (artistErr || !artist) throw new Error('Artista no encontrado');

  // 3. Resetear el estado del video de vuelta a la cola
  const { error: updateErr } = await supabase
    .from('videos')
    .update({
      status: 'analyzing',
      ai_copy_short: null,
      ai_copy_long: null,
      error_log: null
    })
    .eq('id', videoId);

  if (updateErr) throw new Error('Error al reiniciar el estado: ' + updateErr.message);

  // 4. Encolar nuevamente al proceso de IA interno directamente
  const aiService = require('./aiService');
  const artistContext = (artist.ai_genre || artist.ai_audience || artist.ai_tone) ? {
    nombre: artist.name,
    genero: artist.ai_genre || null,
    audiencia: artist.ai_audience || null,
    tono: artist.ai_tone || null,
  } : null;

  const targetPlatforms = video.platforms?.length ? video.platforms : ['tiktok', 'instagram', 'facebook', 'youtube'];
  const mediaType = video.source_url.match(/\.(mp4|mov|webm|ogv)(\?|$)/i) || video.source_url.includes('/video/') ? 'video' : 'image';

  internalQueue.add(() => aiService.processVideoAI(
    video.id,
    video.processed_url || video.source_url,
    video.source_url,
    mediaType,
    targetPlatforms,
    video.title || '',
    artistContext,
    artist.id
  )).catch(err => console.error(`❌ [AI interno] Cola error reintento video ${video.id}:`, err.message));
  console.log(`🤖 [AI interno] RE-Encolado manual video ${video.id} (cola: ${internalQueue.size + 1})`);

  return { success: true, message: 'Procesamiento reiniciado exitosamente' };
};

// --- ELIMINAR VIDEO ---
exports.deleteVideo = async (videoId) => {
  const { error } = await supabase
    .from('videos')
    .delete()
    .eq('id', videoId);

  if (error) throw new Error('Error al eliminar video: ' + error.message);
  return { success: true };
};

// --- GALERÍA ---
exports.fetchArtistGallery = async (artistId, options = {}) => {
  const { limit = 20, page = 1 } = options;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw error;
  return data;
};

// --- ANALYTICS DE UN VIDEO ---
exports.getVideoAnalytics = async (videoId) => {
  const uploadPostService = require('./uploadPostService');

  // 1. Obtener bases del video
  const { data: video, error } = await supabase
    .from('videos')
    .select('id, artist_id, title, status, viral_score, viral_score_real, ai_copy_short, ai_copy_long, hashtags, platforms, post_type, ayrshare_post_id, scheduled_for, published_at, analytics_4h, source_url, processed_url, error_log, created_at, thumbnail_url')
    .eq('id', videoId)
    .single();

  if (error || !video) throw new Error('Video no encontrado');

  // 2. Si tiene post id, intentar actualizar métricas reales
  let realTimeMetrics = null;
  if (video.ayrshare_post_id && video.status === 'published') {
    try {
      realTimeMetrics = await uploadPostService.getPostAnalytics(video.ayrshare_post_id);
      if (realTimeMetrics) {
        // Actualizar snapshot en background para el historial
        const platform = Array.isArray(video.platforms) ? video.platforms[0] : 'unknown';
        uploadPostService.saveMetricsSnapshot(video.id, video.artist_id, platform, realTimeMetrics)
          .catch(e => console.warn('⚠️ Error guardando snapshot automático:', e.message));
      }
    } catch (e) {
      console.warn('⚠️ No se pudieron obtener analytics de Upload-Post:', e.message);
    }
  }

  // 3. Obtener snapshots históricos (para la gráfica de rendimiento)
  const { data: snapshots } = await supabase
    .from('post_metrics_snapshots')
    .select('snapshot_at, views, likes')
    .eq('video_id', videoId)
    .order('snapshot_at', { ascending: true })
    .limit(24);

  // Normalizar métricas usando los datos más frescos (tiempo real o caché 4h)
  const finalMetricsSource = (realTimeMetrics && Object.keys(realTimeMetrics).length > 2)
    ? realTimeMetrics
    : (video.analytics_4h || {});
    
  const metrics = uploadPostService.normalizeMetrics(finalMetricsSource);
  
  console.log(`[Analytics] Info enviada al frontend para video ${videoId}:`, {
    hasAyrshareId: !!video.ayrshare_post_id,
    hasRealTime: !!realTimeMetrics,
    metricsFound: metrics.views > 0
  });

  return {
    ...video,
    real_metrics: metrics,
    history: snapshots || []
  };
};


// --- ESTADÍSTICAS DEL DASHBOARD ---
// Funciona tanto para agencias (todos sus artistas) como para un artista específico
exports.getDashboardStats = async (agencyId, artistId = null) => {
  const uploadPostService = require('./uploadPostService');

  // Plataformas soportadas para intentar si active_platforms está vacío
  const ALL_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'facebook'];

  let artistQuery = supabase
    .from('artists')
    .select('id, ayrshare_profile_key, active_platforms, facebook_page_id, instagram_user_id, agency_id');

  if (artistId) {
    artistQuery = artistQuery.eq('id', artistId);
  } else {
    artistQuery = artistQuery.eq('agency_id', agencyId);
  }

  const { data: artistsData, error: artistsErr } = await artistQuery;
  if (artistsErr) throw artistsErr;

  const targetArtistIds = (artistsData || []).map(a => a.id);
  const emptyStats = {
    total: 0, published: 0, avgScore: 0, totalReach: 0, history: [], postList: [],
    followersTotal: 0, followersDaily: 0, followersPerPost: 0, postsDaily: 0, trend: '0%',
    total_followers: 0, followers_growth: 0, total_views: 0, views_growth: 0,
    published_videos: 0, avg_viral_score: 0, growth_data: [],
    monthly_usage: 0, monthly_limit: 9999, plan_name: 'Pro',
  };

  if (targetArtistIds.length === 0) return emptyStats;

  // Obtener plan de la agencia para monthly_usage / monthly_limit
  const agencyRefId = artistsData[0]?.agency_id || agencyId;
  const { data: agencyData } = await supabase
    .from('agencies')
    .select('plan_type')
    .eq('id', agencyRefId)
    .single();
  const planType = agencyData?.plan_type || 'Pro';
  const planConfig = PLAN_CONFIG[planType] || { videos: 9999 };
  const monthlyLimit = planConfig.videos === Infinity ? 9999 : (planConfig.videos || 9999);

  // Contar videos creados este mes
  const firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  firstOfMonth.setHours(0, 0, 0, 0);
  const { count: monthlyUsage } = await supabase
    .from('videos')
    .select('id', { count: 'exact', head: true })
    .in('artist_id', targetArtistIds)
    .gte('created_at', firstOfMonth.toISOString());

  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, viral_score, status, hashtags, published_at, created_at, platforms, title')
    .in('artist_id', targetArtistIds);

  if (error) throw error;

  const total = videos.length;
  const published = videos.filter(v => v.status === 'published' || v.status === 'scheduled').length;
  const scores = videos.filter(v => v.viral_score).map(v => v.viral_score);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
    : 0;

  let followersTotal = 0;
  let totalReach = 0;
  let totalViews = 0;
  let totalLikes = 0;
  let totalComments = 0;
  let totalShares = 0;
  let totalSaves = 0;
  let totalPostsSocial = 0;
  const historyMap = {};
  const platformBreakdown = {};

  // Recolectar estadísticas reales de Upload-Post en paralelo
  const analyticsPromises = artistsData.map(async (artist) => {
    if (!artist.ayrshare_profile_key) {
      console.warn(`⚠️ getDashboardStats: artista ${artist.id} sin ayrshare_profile_key, saltando analytics`);
      return null;
    }
    const platforms = (artist.active_platforms && artist.active_platforms.length > 0)
      ? artist.active_platforms
      : ALL_PLATFORMS;
    try {
      const options = {};
      if (artist.facebook_page_id) options.facebookPageId = artist.facebook_page_id;
      
      // Lanzamos ambas peticiones en paralelo para cada artista
      const [analytics, profile] = await Promise.all([
        uploadPostService.getAnalytics(artist.ayrshare_profile_key, platforms, options).catch(e => {
          console.warn(`⚠️ Error fetching analytics for ${artist.ayrshare_profile_key}:`, e.message);
          return {};
        }),
        uploadPostService.getProfile(artist.ayrshare_profile_key).catch(e => {
          console.warn(`⚠️ Error fetching profile for ${artist.ayrshare_profile_key}:`, e.message);
          return {};
        })
      ]);

      console.log(`📊 [getDashboardStats] Raw Data for ${artist.ayrshare_profile_key}:`, {
        analytics: JSON.stringify(analytics),
        profile: JSON.stringify(profile)
      });
      
      return { analytics, profile };
    } catch (e) {
      console.warn(`⚠️ Error fetching data for ${artist.ayrshare_profile_key}:`, e.message);
      return null;
    }
  });

  const results = await Promise.all(analyticsPromises);

  results.forEach(item => {
    if (!item) return;
    const { analytics, profile } = item;
    
    // 1. Procesar Analiticas (Reach, Views, Timeseries)
    if (analytics) {
      Object.keys(analytics).forEach(platform => {
        const pData = analytics[platform];
        if (pData && pData.success !== false) {
          const followers = pData.followers || pData.subscribers || pData.subscriber_count || pData.follower_count || pData.fans || 0;
          const pViews = pData.views || pData.video_views || 0;
          const pReach = pData.reach || pData.impressions || 0;
          const pPosts = pData.post_count || pData.media_count || pData.posts || 0;
          
          followersTotal += followers;
          totalReach += pReach;
          totalViews += pViews;
          totalPostsSocial += pPosts;

          // Engagement
          totalLikes += (pData.likes || pData.like_count || pData.heart || 0);
          totalComments += (pData.comments || pData.comment_count || 0);
          totalShares += (pData.shares || pData.share_count || pData.retweets || 0);
          totalSaves += (pData.saves || pData.save_count || pData.bookmarks || 0);

          const metricValue = pViews > 0 ? pViews : pReach;
          platformBreakdown[platform] = (platformBreakdown[platform] || 0) + metricValue;

          if (Array.isArray(pData.reach_timeseries)) {
            pData.reach_timeseries.forEach(item => {
              if (item.date) {
                historyMap[item.date] = (historyMap[item.date] || 0) + (item.value || 0);
              }
            });
          }
        }
      });
    }

    // 2. Procesar Perfil (Seguidores actuales si no vinieron en analytics)
    // Upload-Post suele retornar profile.social_accounts[platform].follower_count
    if (profile && profile.success && profile.profile && profile.profile.social_accounts) {
      const accounts = profile.profile.social_accounts;
      Object.keys(accounts).forEach(p => {
        const acc = accounts[p];
        if (acc && typeof acc === 'object') {
          const followers = acc.followers || acc.follower_count || acc.subscribers || 0;
          const posts = acc.post_count || acc.media_count || 0;
          
          // Solo sumamos si no teníamos datos de esta plataforma desde analytics para evitar duplicar
          // O si el valor del perfil es significativamente más alto/actual
          if (followers > 0 && (!analytics[p] || (analytics[p].followers || 0) === 0)) {
            followersTotal += followers;
          }
          if (posts > totalPostsSocial) {
             totalPostsSocial = posts;
          }
        }
      });
    }
  });

  // Si la red social reporta más videos que nuestra DB local, usamos esa cifra
  const finalTotalVideos = Math.max(total, totalPostsSocial);

  // Generar historial de 7 días ordenado
  const history = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    history.push({ date: dateStr, value: historyMap[dateStr] || 0 });
  }

  const postsDaily = (published / 7).toFixed(2);
  const followersPerPost = finalTotalVideos > 0 ? Math.round(followersTotal / finalTotalVideos) : 0;
  const trend = totalReach > 0 ? '+inc' : '0%';

  const postList = videos.slice(0, 10).map(v => ({
    id: v.id,
    title: v.title,
    date: v.published_at || v.created_at,
    platforms: v.platforms || [],
    viral_score: v.viral_score || 0,
    hashtags: v.hashtags || [],
    status: v.status
  }));

  // Distribuir followersTotal en el historial (último día = total, días anteriores proporcional)
  const growthData = history.map((h, idx) => ({
    date: h.date,
    // Aproximación: mostrar crecimiento lineal hacia followersTotal en el último día
    followers: idx === history.length - 1
      ? followersTotal
      : Math.round(followersTotal * (idx / (history.length - 1 || 1))),
    views: h.value,
  }));

  return {
    total: finalTotalVideos,
    published,
    avgScore,
    totalReach,
    history,
    postList,
    followersTotal,
    followersDaily: 0,
    followersPerPost,
    postsDaily,
    trend,
    // Campos para la App Móvil
    total_followers: followersTotal,
    followers_growth: 0,
    total_views: totalViews,
    views_growth: 0,
    total_likes: totalLikes,
    total_comments: totalComments,
    total_shares: totalShares,
    total_saves: totalSaves,
    published_videos: finalTotalVideos,
    avg_viral_score: avgScore,
    growth_data: growthData,
    platform_breakdown: platformBreakdown,
    monthly_usage: monthlyUsage || 0,
    monthly_limit: monthlyLimit,
    plan_name: planType,
  };
};

// --- CONECTAR REDES SOCIALES (por ARTISTA) ---
exports.connectSocialAccounts = async (artistId) => {
  const socialPublisher = require('./socialPublisher');

  // Obtener artista y el plan de su agencia vinculada
  const { data: artist, error } = await supabase
    .from('artists')
    .select('*, agencies(plan_type)')
    .eq('id', artistId)
    .single();

  if (error) {
    console.error('🎯 Supabase Error (connectSocialAccounts):', error);
    throw new Error('Error al buscar artista en BD: ' + error.message);
  }

  if (!artist) {
    throw new Error(`Artista no existe en la base de datos: ${artistId}`);
  }

  // Determinar plataformas permitidas según el plan
  const planType = artist.agencies?.plan_type || 'Mini';
  const allowedPlatforms = PLAN_CONFIG[planType]?.platforms || ['instagram', 'tiktok'];

  return socialPublisher.getConnectUrl(artist, allowedPlatforms, supabase);
};

// --- VERIFICAR PLATAFORMAS CONECTADAS (por ARTISTA) ---
// refresh=false → lee de DB (carga rápida)
// refresh=true  → consulta Ayrshare API y actualiza DB
exports.getSocialStatus = async (artistId, refresh = false) => {
  const { data: artist, error } = await supabase
    .from('artists')
    .select('id, ayrshare_profile_key, active_platforms')
    .eq('id', artistId)
    .single();

  if (error || !artist) throw new Error(`Artista no encontrado: ${artistId}`);

  // Sin refresh: devolver lo que ya está guardado en DB
  if (!refresh) {
    return { platforms: artist.active_platforms || [] };
  }

  // Con refresh: consultar según publish_mode y actualizar DB
  const socialPublisher = require('./socialPublisher');
  const { data: artistFull } = await supabase
    .from('artists')
    .select('id, publish_mode, ayrshare_profile_key, instagram_user_id, instagram_access_token, facebook_page_id, facebook_access_token')
    .eq('id', artistId)
    .single();
  const platforms = await socialPublisher.getActivePlatforms(artistFull || artist);

  const socialKeys = {};
  platforms.forEach(p => { socialKeys[p] = 'linked'; });

  await supabase
    .from('artists')
    .update({ active_platforms: platforms, social_keys: socialKeys })
    .eq('id', artistId);

  return { platforms };
};

// --- ACTUALIZACIÓN DIRECTA (para callbacks de n8n) ---
exports.updateVideoRaw = async (videoId, updates) => {
  const { error } = await supabase.from('videos').update(updates).eq('id', videoId);
  if (error) throw new Error(error.message);
};

// --- VIRAL SCORE (n8n) ---
exports.analyzeViralPotential = async (videoUrl) => {
  if (process.env.N8N_VIRAL_SCORE_URL) {
    try {
      const response = await axios.post(process.env.N8N_VIRAL_SCORE_URL, { videoUrl });
      return response.data;
    } catch (err) {
      console.error('⚠️ Error en Viral Score n8n:', err.message);
    }
  }
  return { score: 0, feedback: "n8n no configurado aún." };
};

// --- ACTUALIZAR CONFIGURACIÓN DE VIDEO ---
// Si viene scheduled_at, programa el post en Ayrshare y guarda el post_id
exports.updateVideoSettings = async (videoId, updateData) => {
  // 1. Obtener datos actuales del video y del artista
  console.log("updateData.data", updateData);
  const { data: video, error: videoErr } = await supabase
    .from('videos')
    .select('id, title, source_url, processed_url, artist_id')
    .eq('id', videoId)
    .single();

  if (videoErr || !video) throw new Error('Video no encontrado');

  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('id, publish_mode, ayrshare_profile_key, instagram_user_id, instagram_access_token, facebook_page_id, facebook_access_token, active_platforms')
    .eq('id', video.artist_id)
    .single();

  // Leer fecha programada — puede venir como scheduled_at (frontend) o scheduled_for (DB)
  const scheduledAt = updateData.scheduled_at || updateData.scheduled_for || null;
  const hasConnection = artist?.ayrshare_profile_key || artist?.instagram_user_id;
  console.log('📅 scheduledAt recibido:', scheduledAt, '| modo:', artist?.publish_mode, '| conectado:', !!hasConnection);

  // 2. Si hay fecha programada y el artista tiene redes conectadas → programar
  let scheduleStatus = 'no_profile';
  let scheduleErrorMsg = null;

  if (scheduledAt && hasConnection) {
    try {
      const socialPublisher = require('./socialPublisher');
      const postText = updateData.hashtags || video.title || 'Nuevo contenido';
      const platforms = updateData.platforms || video.platforms || ['tiktok', 'instagram', 'youtube'];

      const targetPlatform = platforms[0];
      const cloudinaryUrl = video.platform_urls?.[targetPlatform]
        || buildCloudinaryUrl(video.source_url, targetPlatform);

      const postType = updateData.post_type || video.post_type || (video.source_url.includes('/video/') ? 'reel' : 'feed');
      const options = exports.buildPlatformOptions(video.source_url, platforms, postText, postType);

      const result = await socialPublisher.schedulePost(
        artist,
        postText,
        platforms,
        [cloudinaryUrl],
        new Date(scheduledAt).toISOString(),
        options
      );

      if (result.id || result.postIds) {
        updateData.ayrshare_post_id = result.id || result.postIds?.[0] || null;
        scheduleStatus = 'success';
      }
      console.log(`✅ Post programado (modo: ${artist.publish_mode}) para video: ${videoId}`);
    } catch (err) {
      scheduleStatus = 'error';
      const errData = err.response?.data;
      scheduleErrorMsg = errData?.message || errData?.error
        || (typeof errData === 'object' ? JSON.stringify(errData) : null)
        || err.message;
      console.error('❌ Error schedulePost:', errData || err.message);
    }
  } else if (scheduledAt) {
    console.warn(`⚠️ Video ${videoId} programado pero artista sin redes conectadas`);
  }

  // Mapear scheduled_at → scheduled_for (nombre real de la columna en Supabase)
  if ('scheduled_at' in updateData) {
    updateData.scheduled_for = updateData.scheduled_at || null;
    delete updateData.scheduled_at;
  }

  // 3. Guardar en DB
  const { data, error } = await supabase
    .from('videos')
    .update(updateData)
    .eq('id', videoId)
    .select();
  if (error) throw error;
  return { ...data[0], _scheduleStatus: scheduleStatus, _scheduleError: scheduleErrorMsg };
};

/**
 * HELPER: Construye URL de Cloudinary con transformaciones limpias.
 * @param {string} sourceUrl - URL original de Cloudinary.
 * @param {string} targetPlatform - 'instagram', 'tiktok', 'youtube', 'facebook', o null (general).
 */
function buildCloudinaryUrl(sourceUrl, targetPlatform = null) {
  if (!sourceUrl || !sourceUrl.includes('cloudinary.com') || !sourceUrl.includes('/upload/')) {
    return sourceUrl;
  }

  // Sanitización profunda: eliminar espacios y parámetros de cache/query innecesarios
  const cleanUrl = sourceUrl.replace(/\s+/g, '').split('?')[0];

  // Regex robusto para separar: Base + Subida + [Transformaciones Existentes] + Versión/PublicID
  // Captura: 1: (https://.../upload/)  2: (v12345/path/to/video.mp4)
  const regex = /^(https:\/\/res\.cloudinary\.com\/[^\/]+\/(?:video|image)\/upload\/)(?:[^\/]+\/)*(v\d+\/.*)$/;
  const match = cleanUrl.match(regex);

  if (!match) {
    console.warn("⚠️ URL de Cloudinary no estándar, devolviendo original:", cleanUrl);
    return cleanUrl;
  }

  const baseUrl = match[1];
  const publicId = match[2];
  const isVideo = cleanUrl.includes('/video/') || cleanUrl.match(/\.(mp4|mov|webm|ogv)$/i);

  if (isVideo) {
    // REELS / TIKTOK / SHORTS: 1080x1920 (9:16), H.264, AAC Audio
    // Forzamos mp4 al final para asegurar compatibilidad con Instagram API
    const trans = 'w_1080,h_1920,c_fill,vc_h264,ac_aac,f_mp4';
    return `${baseUrl}${trans}/${publicId}`.replace(/\.[a-z0-7]+$/i, '.mp4');
  } else {
    // IMÁGENES:
    if (targetPlatform === 'instagram' || targetPlatform === 'facebook') {
      // Instagram Feed: 1080x1080 (1:1) con fondo negro si no es cuadrado
      const trans = 'w_1080,h_1080,c_pad,ar_1:1,b_black,f_jpg';
      return `${baseUrl}${trans}/${publicId}`.replace(/\.[a-z0-7]+$/i, '.jpg');
    } else {
      // General Portrait: 1080x1920 (9:16)
      const trans = 'w_1080,h_1920,c_pad,ar_9:16,b_black,f_jpg';
      return `${baseUrl}${trans}/${publicId}`.replace(/\.[a-z0-7]+$/i, '.jpg');
    }
  }
}

/**
 * HELPER: Genera un objeto con las URLs optimizadas para cada plataforma.
 */
function getPlatformUrls(sourceUrl) {
  return {
    instagram: buildCloudinaryUrl(sourceUrl, 'instagram'),
    facebook: buildCloudinaryUrl(sourceUrl, 'facebook'),
    tiktok: buildCloudinaryUrl(sourceUrl, 'tiktok'),
    youtube: buildCloudinaryUrl(sourceUrl, 'youtube')
  };
}

// --- HELPER: Opciones por plataforma según tipo de contenido ---
exports.buildPlatformOptions = (sourceUrl, platforms, postText = '', postType = null) => {
  const isVideo = sourceUrl && (sourceUrl.includes('/video/') || sourceUrl.match(/\.(mp4|mov|webm|ogv)(\?|$)/i));

  // postType normalizado a mayúsculas para Upload-Post
  const finalType = (postType || (isVideo ? 'reel' : 'feed')).toUpperCase();
  // Mapeo: 'REEL' → 'REELS', 'STORY'→'STORIES', 'FEED'→'FEED'
  const upPostType = finalType === 'REEL' ? 'REELS' : finalType === 'STORY' ? 'STORIES' : finalType;

  return {
    postType: upPostType,                        // Instagram + Facebook + TikTok
    description: postText,                          // YouTube, Facebook, LinkedIn
    // TikTok
    tiktokPrivacy: 'PUBLIC',
    // YouTube
    youtubePrivacy: 'PUBLIC',
    youtubeCategoryId: 22,                             // People & Blogs
    youtubeTags: postText ? postText.match(/#\w+/g)?.map(t => t.slice(1)) || [] : [],
    // No pasamos facebookPageId aquí — si el artista tiene uno se toma del artist.facebook_page_id
  };
}

// --- PUBLICAR VIDEO AHORA ---
exports.publishVideoNow = async (videoId, frontendOptions = {}) => {
  const socialPublisher = require('./socialPublisher');

  const { data: video, error: videoErr } = await supabase
    .from('videos')
    .select('id, title, source_url, processed_url, hashtags, platforms, artist_id')
    .eq('id', videoId)
    .single();

  if (videoErr || !video) throw new Error('Video no encontrado');
  console.log('video', video.artist_id);
  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('*')
    .eq('id', video.artist_id)
    .single();
  console.log('artist found:', artist?.id, artist?.name);

  if (artistErr || !artist) throw new Error('Artista no encontrado');
  const hasConnection = artist.ayrshare_profile_key || artist.instagram_user_id;
  if (!hasConnection) throw new Error('El artista no tiene redes sociales conectadas. Conéctalas primero.');

  const postText = video.hashtags || video.title || 'Nuevo contenido';

  // Usar plataformas del frontend si las mandó, sino las del video/artista
  const platforms = frontendOptions.platforms?.length ? frontendOptions.platforms
    : video.platforms?.length ? video.platforms
      : artist.active_platforms?.length ? artist.active_platforms
        : ['instagram'];

  const targetPlatform = platforms[0];
  const cloudinaryUrl = video.platform_urls?.[targetPlatform]
    || video.processed_url
    || buildCloudinaryUrl(video.source_url, targetPlatform);
  console.log('🔗 Usando Cloudinary URL:', cloudinaryUrl, '| modo:', artist.publish_mode);

  // Usar postType del frontend (reel/story), sino inferir
  const postType = frontendOptions.postType || video.post_type || (video.source_url.includes('/video/') ? 'reel' : 'feed');
  const options = exports.buildPlatformOptions(video.source_url, platforms, postText, postType);

  // Agregar postType a las opciones para que uploadPostService lo use
  options.postType = postType === 'story' ? 'STORIES' : 'REELS';

  const result = await socialPublisher.publishPost(
    artist, postText, platforms, [cloudinaryUrl], options
  );

  const postId = result.id || result.postIds?.[0] || null;
  const { data: updated, error: updateErr } = await supabase
    .from('videos')
    .update({ status: 'published', ayrshare_post_id: postId, published_at: new Date().toISOString() })
    .eq('id', videoId)
    .select();

  if (updateErr) throw updateErr;
  console.log(`✅ Video ${videoId} publicado ahora. Post ID: ${postId}`);
  return updated[0];
};

// --- OBTENER CLIPS DE UN VIDEO PADRE ---
exports.getClipsByParent = async (parentId) => {
  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .eq('parent_video_id', parentId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};
// --- ELIMINAR ARTISTA Y SUS VIDEOS ---
exports.deleteArtist = async (artistId) => {
  // 1. Eliminar todos los videos del artista (por seguridad, aunque haya cascade)
  const { error: videosError } = await supabase
    .from('videos')
    .delete()
    .eq('artist_id', artistId);

  if (videosError) throw videosError;

  // 2. Eliminar el artista
  const { error: artistError } = await supabase
    .from('artists')
    .delete()
    .eq('id', artistId);

  if (artistError) throw artistError;

  return { ok: true, message: 'Artista y videos eliminados correctamente' };
};
exports.updateArtistStyle = async (artistId, creativeDna) => {
  const { data, error } = await supabase
    .from('artists')
    .update({ creative_dna: creativeDna })
    .eq('id', artistId)
    .select();
  
  if (error) {
    console.warn('⚠️ Error actualizando creative_dna. Reintentando con branding_data...');
    // Fallback por si no existe la columna creative_dna aún
    const { data: fallbackData, error: fallbackError } = await supabase
      .from('artists')
      .update({ branding_data: { creative_dna: creativeDna } })
      .eq('id', artistId)
      .select();
    if (fallbackError) throw fallbackError;
    return fallbackData[0];
  }
  return data[0];
};

/**
 * Realiza una Auditoría Profunda (Deep Audit) del artista.
 * Solo disponible para planes Pro (Artista, Estrella, Agencia Pro).
 */
exports.runArtistDeepAudit = async (artistId, allowFullAudit = false) => {
  // 1. Obtener datos del artista
  const { data: artist, error: artistErr } = await supabase
    .from('artists')
    .select('*, agencies(plan_type)')
    .eq('id', artistId)
    .single();

  if (artistErr || !artist) throw new Error('Artista no encontrado');

  const planType = (artist.agencies?.plan_type || artist.plan_type || 'Mini').trim();
  const isPro = ['Artista', 'Estrella', 'Agencia Pro'].includes(planType);

  if (!isPro) {
    const err = new Error('La Auditoría Profunda es una función Pro. Por favor, sube de nivel tu plan.');
    err.status = 403;
    err.code = 'PLAN_LIMIT_REACHED';
    throw err;
  }

  console.log(`🧠 Iniciando Auditoría Profunda para ${artist.name} (Plan: ${planType})`);

  let finalPosts = [];

  // 2. Si se permite Auditoría Completa, leer historial de Instagram
  if (allowFullAudit && artist.instagram_user_id) {
    try {
      console.log('📡 Fetching historial externo de Instagram...');
      const externalMedia = await instagramService.getMediaHistory(artist, 20);
      
      // Guardar posts externos en la base de datos (con categoría 'audit')
      if (externalMedia.length > 0) {
        const auditRecords = externalMedia.map(m => ({
          artist_id: artistId,
          source: 'instagram',
          external_id: m.id,
          caption: m.caption,
          media_url: m.media_url,
          metrics: { 
            likes: m.like_count || 0, 
            comments: m.comments_count || 0,
            timestamp: m.timestamp 
          },
          category: 'audit_deep'
        }));

        const { error: insErr } = await supabase
          .from('external_posts_audit') // Asumimos que esta tabla existe o se crea vía migración
          .insert(auditRecords);
        
        if (insErr) {
          console.warn('⚠️ No se pudo guardar historial externo en DB:', insErr.message);
          // Si la tabla no existe, fallbback a analytics_insights_log como raw_data
        }

        finalPosts = externalMedia.map(m => ({
          title: m.caption || 'Publicación externa',
          likes: m.like_count || 0,
          comments: m.comments_count || 0,
          type: m.media_type
        }));
      }
    } catch (e) {
      console.warn('⚠️ Falló la lectura de historial externo:', e.message);
    }
  }

  // 3. Añadir historial interno de Vidalis
  const { data: internalVideos } = await supabase
    .from('videos')
    .select('title, analytics_4h, viral_score_real')
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false })
    .limit(10);

  (internalVideos || []).forEach(v => {
    finalPosts.push({
      title: v.title,
      likes: v.analytics_4h?.likes || 0,
      comments: v.analytics_4h?.comments || 0,
      viral_score: v.viral_score_real
    });
  });

  // 4. Ejecutar Análisis de IA
  const auditReport = await aiService.runDeepAuditAnalysis(artist, finalPosts);

  // 5. Si tiene auto-ajuste activo, actualizar el ADN Creativo
  if (artist.auto_style_adjustment && auditReport.suggested_dna) {
    await exports.updateArtistStyle(artistId, auditReport.suggested_dna);
    auditReport.applied = true;
  }

  // 6. Registrar en el log de insights
  await supabase.from('analytics_insights_log').insert({
    artist_id: artistId,
    insights: auditReport.insights || [],
    decisions: auditReport.peticiones || auditReport.decisions || [],
    category: 'deep_audit'
  });

  return auditReport;
};

exports.uploadFromUrl = async (artistId, remoteUrl, title, _userId) => {
  // Verificar que el artista existe
  const { data: artist, error: artistError } = await supabase
    .from('artists')
    .select('id, agency_id')
    .eq('id', artistId)
    .single();

  if (artistError || !artist) throw new Error('Artista no encontrado');

  // Subir a Cloudinary desde URL remota — Cloudinary hace el fetch directamente
  const folder = `vidalis/${artistId}`;
  const result = await cloudinary.uploader.upload(remoteUrl, {
    resource_type: 'video',
    folder,
    eager: 'sp_hd',
    eager_async: true,
  });

  if (!result.secure_url) throw new Error('Cloudinary no retornó URL');

  // Registrar en Supabase
  const { data: video, error: videoError } = await supabase
    .from('videos')
    .insert({
      artist_id: artistId,
      cloudinary_url: result.secure_url,
      title: title || 'Video desde URL',
      status: 'analyzing',
    })
    .select()
    .single();

  if (videoError) throw new Error('Error registrando video: ' + videoError.message);

  // Disparar análisis de IA en background — mismo patrón que processVideo existente
  if (shouldUseInternal()) {
    internalQueue.add(() => aiService.processVideoAI(
      video.id,
      result.secure_url,
      result.secure_url,
      'video',
      ['tiktok', 'instagram', 'facebook', 'youtube'],
      title || '',
      null,
      artistId
    )).catch(err => console.error(`❌ [AI interno] uploadFromUrl error video ${video.id}:`, err.message));
  } else {
    n8nQueue.add(() => axios.post(process.env.N8N_WEBHOOK_URL, {
      videoId: video.id,
      videoUrl: result.secure_url,
    })).catch(err => console.error(`❌ [n8n] uploadFromUrl error video ${video.id}:`, err.message));
  }

  return video;
};
