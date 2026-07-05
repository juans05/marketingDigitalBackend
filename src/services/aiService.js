/**
 * aiService.js — Procesamiento de IA interno (sin n8n)
 * Gemini 2.0 Flash (análisis visual) + Groq Whisper (transcripción) → Claude (copy)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);

const { jsonrepair } = require('jsonrepair');
const { checkHashtags } = require('../config/bannedHashtags');

const fs = require('fs');
const path = require('path');
const debugLogPath = path.join(process.cwd(), 'debug_ai.log');
const logger = require('./loggerService');

function logDebug(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${message}\n`;
  console.log(message);
  try {
    fs.appendFileSync(debugLogPath, logMsg);
  } catch (e) {
    console.error('Failed to write to debug_ai.log', e.message);
  }
}

let gemini = null;
let anthropic = null;
let fileManager = null;

function getGemini() {
  if (!gemini) {
    logDebug('🧪 [Gemini] Verificando API Key: ' + (process.env.GEMINI_API_KEY ? 'Presente' : '⚠️ FALTANTE'));
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurado');
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return gemini;
}

function getFileManager() {
  if (!fileManager) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurado');
    fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
  }
  return fileManager;
}

function getAnthropic() {
  if (!anthropic) {
    logDebug('🧪 [Anthropic] Verificando API Key: ' + (process.env.ANTHROPIC_API_KEY ? 'Presente' : '⚠️ FALTANTE'));
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurado');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// ---------------------------------------------------------------------------
// HELPERS DE URL CLOUDINARY
// ---------------------------------------------------------------------------

/**
 * Extrae múltiples frames de un video Cloudinary como JPEGs.
 * so_0 = inicio, so_3 = segundo 3 (gancho), so_auto = frame más representativo.
 * Retorna un array de URLs para darle a Gemini más contexto visual.
 */
function extractVideoThumbnails(videoUrl) {
  if (!videoUrl.includes('cloudinary.com') || !videoUrl.includes('/upload/')) return [videoUrl];
  const uploadIdx = videoUrl.indexOf('/upload/');
  const cleanBase = videoUrl.slice(0, uploadIdx + 8);
  const afterUpload = videoUrl.slice(uploadIdx + 8);
  const publicPart = afterUpload.replace(/^(?:[^/]+\/)*?(v\d+\/.*)$/, '$1');
  const toJpg = (transforms) =>
    `${cleanBase}${transforms}/${publicPart}`.replace(/\.(mp4|mov|webm)(\?|$)/i, '.jpg');
  return [
    toJpg('f_jpg,so_0'),
    toJpg('f_jpg,so_3'),
    toJpg('f_jpg,so_auto'),
  ];
}

function extractVideoThumbnail(videoUrl) {
  return extractVideoThumbnails(videoUrl)[1];
}

/**
 * Extrae solo el audio de un video Cloudinary como MP3 (mucho más liviano que el video).
 */
function extractAudioUrl(videoUrl) {
  if (!videoUrl.includes('cloudinary.com') || !videoUrl.includes('/upload/')) return null;
  const uploadIdx = videoUrl.indexOf('/upload/');
  const cleanBase = videoUrl.slice(0, uploadIdx + 8);
  const afterUpload = videoUrl.slice(uploadIdx + 8);
  const publicPart = afterUpload.replace(/^(?:[^/]+\/)*?(v\d+\/.*)$/, '$1');
  // q_30 baja calidad de audio — reduce tamaño para el límite de 25MB de Groq
  return `${cleanBase}f_mp3,q_30/${publicPart}`.replace(/\.(mp4|mov|webm)(\?|$)/i, '.mp3');
}

// ---------------------------------------------------------------------------
// APRENDIZAJE: Lee historial de la BD para mejorar predicciones
// ---------------------------------------------------------------------------

/**
 * Consulta la BD y extrae el contexto de aprendizaje del artista:
 * - Hashtags que históricamente generaron más engagement
 * - Plataformas con mejor performance
 * - Calibración: diferencia promedio entre viral_score predicho vs real
 * - Patrones de copy que funcionaron
 *
 * @param {string} artistId
 * @returns {object|null} learningContext
 */
async function fetchArtistLearningContext(artistId) {
  if (!artistId) return null;

  const cached = _artistLearningCache.get(artistId);
  if (cached && Date.now() < cached.expiry) return cached.data;

  try {
    const [
      { data: artistProfile },
      { data: topPosts },
      { data: snapshots },
      { data: insightsLog },
    ] = await Promise.all([
      supabase
        .from('artists')
        .select('name, ai_genre, ai_audience, ai_tone, creative_dna, branding_data')
        .eq('id', artistId)
        .single(),
      supabase
        .from('videos')
        .select('title, hashtags, platforms, viral_score, viral_score_real, ai_copy_short, analytics_4h')
        .eq('artist_id', artistId)
        .not('viral_score_real', 'is', null)
        .order('viral_score_real', { ascending: false })
        .limit(10),
      supabase
        .from('post_metrics_snapshots')
        .select('platform, likes, comments, views, shares, engagement_rate, viral_score_real')
        .eq('artist_id', artistId)
        .order('snapshot_at', { ascending: false })
        .limit(100),
      supabase
        .from('analytics_insights_log')
        .select('generated_at, insights, decisions, engagement_rate, best_platform')
        .eq('artist_id', artistId)
        .order('generated_at', { ascending: false })
        .limit(3),
    ]);

    if (!topPosts?.length && !snapshots?.length) return null;

    // --- Calcular performance por plataforma ---
    const platformStats = {};
    (snapshots || []).forEach(s => {
      if (!s.platform) return;
      if (!platformStats[s.platform]) {
        platformStats[s.platform] = { totalEngagement: 0, totalViews: 0, count: 0, totalScore: 0 };
      }
      platformStats[s.platform].totalEngagement += s.engagement_rate || 0;
      platformStats[s.platform].totalViews     += s.views || 0;
      platformStats[s.platform].totalScore     += s.viral_score_real || 0;
      platformStats[s.platform].count++;
    });

    const platformPerformance = Object.entries(platformStats)
      .map(([platform, stats]) => ({
        platform,
        avgEngagement: parseFloat((stats.totalEngagement / stats.count).toFixed(2)),
        avgViews:      Math.round(stats.totalViews / stats.count),
        avgScore:      parseFloat((stats.totalScore / stats.count).toFixed(1)),
      }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);

    // --- Extraer y rankear hashtags por engagement ---
    const hashtagEngagement = {};
    (topPosts || []).forEach(post => {
      if (!post.hashtags) return;
      const score = post.viral_score_real || post.viral_score || 5;
      const tags = post.hashtags.match(/#\w+/g) || [];
      tags.forEach(tag => {
        const t = tag.toLowerCase();
        if (!hashtagEngagement[t]) hashtagEngagement[t] = { totalScore: 0, count: 0 };
        hashtagEngagement[t].totalScore += score;
        hashtagEngagement[t].count++;
      });
    });

    const topHashtags = Object.entries(hashtagEngagement)
      .map(([tag, data]) => ({ tag, avgScore: data.totalScore / data.count, count: data.count }))
      .sort((a, b) => b.avgScore - a.avgScore)
      .slice(0, 25)
      .map(h => h.tag);

    // --- Calibración avanzada: sesgo global + por plataforma + desviación estándar ---
    const calibrationPosts = (topPosts || []).filter(p => p.viral_score && p.viral_score_real);
    let scoreBias = 0;
    let biasStdDev = 0;
    const platformBias = {};
    const allRealScores = calibrationPosts.map(p => p.viral_score_real);
    const historicalAvg = allRealScores.length > 0
      ? parseFloat((allRealScores.reduce((a, b) => a + b, 0) / allRealScores.length).toFixed(1))
      : 5;

    if (calibrationPosts.length > 0) {
      const errors = calibrationPosts.map(p => p.viral_score - p.viral_score_real);
      scoreBias = parseFloat((errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(2));
      const variance = errors.reduce((acc, e) => acc + Math.pow(e - scoreBias, 2), 0) / errors.length;
      biasStdDev = parseFloat(Math.sqrt(variance).toFixed(2));

      calibrationPosts.forEach(p => {
        const plats = Array.isArray(p.platforms) ? p.platforms : (p.platforms || '').split(',').map(s => s.trim()).filter(Boolean);
        plats.forEach(pl => {
          if (!platformBias[pl]) platformBias[pl] = { errors: [], realScores: [] };
          platformBias[pl].errors.push(p.viral_score - p.viral_score_real);
          platformBias[pl].realScores.push(p.viral_score_real);
        });
      });
    }

    const platformCalibration = {};
    Object.entries(platformBias).forEach(([pl, data]) => {
      const avg = data.errors.reduce((a, b) => a + b, 0) / data.errors.length;
      const realAvg = data.realScores.reduce((a, b) => a + b, 0) / data.realScores.length;
      platformCalibration[pl] = {
        bias: parseFloat(avg.toFixed(2)),
        avgRealScore: parseFloat(realAvg.toFixed(1)),
        sampleSize: data.errors.length,
      };
    });

    // --- Top copies que funcionaron (score real >= 6) ---
    const topCopies = (topPosts || [])
      .filter(p => (p.viral_score_real || 0) >= 6 && p.ai_copy_short)
      .slice(0, 3)
      .map(p => ({ copy: p.ai_copy_short, score: p.viral_score_real, platforms: p.platforms }));

    logDebug(`📚 [Learning] Artista ${artistId}: ${topHashtags.length} hashtags, bias=${scoreBias}±${biasStdDev}, avg_real=${historicalAvg}, best=${platformPerformance[0]?.platform || 'N/A'}`);

    const result = {
      topHashtags,
      platformPerformance,
      bestPlatform: platformPerformance[0]?.platform || null,
      scoreBias,
      biasStdDev,
      historicalAvg,
      platformCalibration,
      topCopies,
      totalPostsAnalyzed: calibrationPosts.length,
      recentInsights: (insightsLog || []).flatMap(i => i.decisions || []).slice(0, 3),
      creativeDNA: artistProfile?.creative_dna || artistProfile?.branding_data?.creative_dna || null,
      brandingData: artistProfile?.branding_data || null,
    };
    _artistLearningCache.set(artistId, { data: result, expiry: Date.now() + ARTIST_LEARNING_CACHE_TTL_MS });
    return result;
  } catch (err) {
    logDebug(`⚠️ [Learning] No se pudo obtener contexto de aprendizaje: ${err.message}`);
    return null;
  }
}

const _artistLearningCache = new Map();
const ARTIST_LEARNING_CACHE_TTL_MS = 5 * 60 * 1000;

let _globalCalibrationCache = null;
let _globalCalibrationExpiry = 0;

async function fetchGlobalCalibration() {
  if (_globalCalibrationCache && Date.now() < _globalCalibrationExpiry) return _globalCalibrationCache;

  try {
    const { data: allPosts } = await supabase
      .from('videos')
      .select('viral_score, viral_score_real, platforms')
      .not('viral_score', 'is', null)
      .not('viral_score_real', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200);

    if (!allPosts?.length || allPosts.length < 3) {
      _globalCalibrationCache = null;
      _globalCalibrationExpiry = Date.now() + 5 * 60 * 1000;
      return null;
    }

    const errors = allPosts.map(p => p.viral_score - p.viral_score_real);
    const bias = errors.reduce((a, b) => a + b, 0) / errors.length;
    const variance = errors.reduce((acc, e) => acc + Math.pow(e - bias, 2), 0) / errors.length;
    const stdDev = Math.sqrt(variance);
    const realScores = allPosts.map(p => p.viral_score_real);
    const avg = realScores.reduce((a, b) => a + b, 0) / realScores.length;

    const platformBias = {};
    allPosts.forEach(p => {
      const plats = Array.isArray(p.platforms) ? p.platforms : (p.platforms || '').split(',').map(s => s.trim()).filter(Boolean);
      plats.forEach(pl => {
        if (!platformBias[pl]) platformBias[pl] = [];
        platformBias[pl].push(p.viral_score - p.viral_score_real);
      });
    });

    const platformCalibration = {};
    Object.entries(platformBias).forEach(([pl, errs]) => {
      if (errs.length >= 3) {
        platformCalibration[pl] = {
          bias: parseFloat((errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2)),
          sampleSize: errs.length,
        };
      }
    });

    _globalCalibrationCache = {
      scoreBias: parseFloat(bias.toFixed(2)),
      biasStdDev: parseFloat(stdDev.toFixed(2)),
      historicalAvg: parseFloat(avg.toFixed(1)),
      platformCalibration,
      totalPostsAnalyzed: allPosts.length,
    };
    _globalCalibrationExpiry = Date.now() + 10 * 60 * 1000;

    logDebug(`🌍 [Global Calibration] ${allPosts.length} posts, bias=${_globalCalibrationCache.scoreBias}, avg=${_globalCalibrationCache.historicalAvg}`);
    return _globalCalibrationCache;
  } catch (err) {
    logDebug(`⚠️ [Global Calibration] Error: ${err.message}`);
    return null;
  }
}

// Cuántos posts reales hacen falta para dejar de tirar el score hacia el
// promedio histórico del artista. Unificado entre calibrateScore (1-10, el
// pipeline principal de video) y calibrateScore100 (0-100, Content Copilot y
// Visual Score) — es una pregunta de "cuánto confiar en N muestras", no algo
// que dependa de la escala del score.
const REGRESSION_WINDOW = 10;

/**
 * Núcleo de corrección compartido entre calibrateScore (1-10) y
 * calibrateScore100 (0-100). Opera en la escala del rawScore que reciba —
 * el caller es responsable de que scoreBias/historicalAvg/platformCalibration
 * ya vengan en esa misma escala. `scale` reescala los umbrales fijos (pensados
 * originalmente para 1-10) y `regressionWindow` controla qué tan rápido deja
 * de tirar hacia la media a medida que hay más posts analizados.
 */
function calibrateCore(rawScore, learningContext, platform, scale, regressionWindow) {
  const adjustments = [];
  let adjusted = rawScore;
  const biasThreshold = 0.3 * scale;
  const deltaMessageThreshold = 0.2 * scale;

  // 1. Corrección por sesgo global
  const { scoreBias, biasStdDev, historicalAvg, platformCalibration, totalPostsAnalyzed } = learningContext;
  if (Math.abs(scoreBias) > biasThreshold) {
    adjusted -= scoreBias;
    adjustments.push(`Bias global: ${scoreBias > 0 ? '-' : '+'}${Math.abs(scoreBias).toFixed(1)} (modelo ${scoreBias > 0 ? 'sobreestimaba' : 'subestimaba'})`);
  }

  // 2. Corrección por plataforma específica
  const platCal = platformCalibration[platform];
  if (platCal && platCal.sampleSize >= 2 && Math.abs(platCal.bias - scoreBias) > biasThreshold) {
    const platDelta = platCal.bias - scoreBias;
    adjusted -= platDelta;
    adjustments.push(`Ajuste ${platform}: ${platDelta > 0 ? '-' : '+'}${Math.abs(platDelta).toFixed(1)} (${platform} ${platDelta > 0 ? 'rinde menos' : 'rinde más'} que el promedio)`);
  }

  // 3. Regresión a la media del artista (cuantos menos datos, más tira hacia la media)
  const regressionWeight = Math.min(totalPostsAnalyzed / regressionWindow, 1);
  const priorWeight = 1 - regressionWeight;
  if (priorWeight > 0.1) {
    const beforeRegression = adjusted;
    adjusted = (adjusted * regressionWeight) + (historicalAvg * priorWeight);
    if (Math.abs(adjusted - beforeRegression) > deltaMessageThreshold) {
      adjustments.push(`Regresión a media (${historicalAvg}): peso ${(priorWeight * 100).toFixed(0)}% por ${totalPostsAnalyzed} posts analizados`);
    }
  }

  // 4. Confidence basada en cantidad de datos + consistencia
  let confidence;
  const isGlobal = !!learningContext._globalFallback;
  if (isGlobal) {
    confidence = totalPostsAnalyzed >= 20 ? 'medium' : 'low';
    adjustments.push(`Calibrado con datos globales (${totalPostsAnalyzed} videos de toda la plataforma)`);
  } else if (totalPostsAnalyzed >= 10 && biasStdDev < 1.5) {
    confidence = 'high';
  } else if (totalPostsAnalyzed >= 5) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return { adjusted, confidence, adjustments };
}

/**
 * Post-procesa el score crudo del LLM con corrección matemática real.
 * Si el artista no tiene datos, usa la calibración global de toda la plataforma.
 *
 * @param {number} rawScore - Score 1-10 que devolvió el LLM
 * @param {object|null} learningContext - Contexto de fetchArtistLearningContext
 * @param {string} platform - Plataforma principal del contenido
 * @returns {{ score: number, raw: number, confidence: string, adjustments: string[] }}
 */
function calibrateScore(rawScore, learningContext, platform) {
  if (!rawScore) {
    return { score: rawScore, raw: rawScore, confidence: 'none', adjustments: [] };
  }

  if (!learningContext || learningContext.totalPostsAnalyzed < 2) {
    if (!learningContext?._globalFallback) {
      return { score: Math.round(rawScore), raw: rawScore, confidence: 'low', adjustments: ['Sin datos históricos — se usará calibración global en próximo análisis'] };
    }
  }

  const { adjusted, confidence, adjustments } = calibrateCore(rawScore, learningContext, platform, 1, REGRESSION_WINDOW);
  const score = Math.max(1, Math.min(10, Math.round(adjusted)));

  if (score !== rawScore) {
    logDebug(`🎯 [Calibration] raw=${rawScore} → calibrated=${score} (bias=${learningContext.scoreBias}, stddev=${learningContext.biasStdDev}, confidence=${confidence})`);
  }

  return { score, raw: rawScore, confidence, adjustments };
}

/**
 * Versión de calibrateScore para escala 0-100 (usado en analyzeContentStrategy
 * y scoreVisualVirality). Calibra DIRECTAMENTE en escala 0-100 — antes convertía
 * a 1-10, redondeaba a entero, y volvía a multiplicar por 10, lo que colapsaba
 * cualquier score a uno de solo 11 valores posibles (múltiplos de 10). Los datos
 * de aprendizaje (scoreBias, historicalAvg, platformCalibration.bias) se calculan
 * en escala 1-10 en fetchArtistLearningContext/fetchGlobalCalibration, así que se
 * escalan ×10 antes de aplicar la corrección.
 */
function calibrateScore100(rawScore100, learningContext, platform) {
  if (!rawScore100) {
    return { score: rawScore100, raw: rawScore100, confidence: 'none', adjustments: [] };
  }

  let ctx100 = learningContext;
  if (learningContext) {
    ctx100 = {
      ...learningContext,
      scoreBias: (learningContext.scoreBias || 0) * 10,
      historicalAvg: (learningContext.historicalAvg || 0) * 10,
      platformCalibration: Object.fromEntries(
        Object.entries(learningContext.platformCalibration || {})
          .map(([plat, cal]) => [plat, { ...cal, bias: cal.bias * 10 }])
      ),
    };
  }

  if (!ctx100 || ctx100.totalPostsAnalyzed < 2) {
    if (!ctx100?._globalFallback) {
      return { score: Math.round(rawScore100), raw: rawScore100, confidence: 'low', adjustments: ['Sin datos históricos — se usará calibración global en próximo análisis'] };
    }
  }

  const { adjusted, confidence, adjustments } = calibrateCore(rawScore100, ctx100, platform, 10, REGRESSION_WINDOW);
  const score = Math.max(0, Math.min(100, Math.round(adjusted)));

  if (score !== rawScore100) {
    logDebug(`🎯 [Calibration 0-100] raw=${rawScore100} → calibrated=${score} (confidence=${confidence})`);
  }

  return { score, raw: rawScore100, confidence, adjustments };
}

// ---------------------------------------------------------------------------
// PASO 0 (opcional): Transcripción de audio con Groq Whisper
// ---------------------------------------------------------------------------

/**
 * Descarga el audio del video y lo transcribe con Groq Whisper.
 * Requiere GROQ_API_KEY. Si no está configurado, devuelve null sin error.
 * @param {string} videoUrl - URL del video en Cloudinary
 * @returns {string|null}
 */
async function transcribeWithGroq(videoUrl) {
  if (!process.env.GROQ_API_KEY) {
    console.warn('⚠️ GROQ_API_KEY no configurado — saltando transcripción');
    return null;
  }

  const audioUrl = extractAudioUrl(videoUrl);
  if (!audioUrl) {
    console.warn('⚠️ No se pudo extraer URL de audio del video');
    return null;
  }

  try {
    console.log('🎙️ [Groq] Descargando audio...');
    const audioResp = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { 'User-Agent': 'vidalis-ai/1.0' }
    });

    const audioBuffer = Buffer.from(audioResp.data);

    // Límite de Groq Whisper: 25MB
    if (audioBuffer.length > 24 * 1024 * 1024) {
      console.warn('⚠️ Audio demasiado grande para Groq (>24MB) — saltando transcripción');
      return null;
    }

    console.log(`🎙️ [Groq] Transcribiendo ${Math.round(audioBuffer.length / 1024)}KB de audio...`);

    // Usar fetch nativo (Node.js 18+) con FormData nativo
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/mp3' });
    formData.append('file', blob, 'audio.mp3');
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'text');

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Groq API ${resp.status}: ${errText}`);
    }

    const transcript = await resp.text();
    console.log(`✅ [Groq] Transcripción: "${transcript.slice(0, 80)}..."`);
    return transcript || null;
  } catch (err) {
    // La transcripción es opcional — no bloquear el flujo si falla
    console.warn(`⚠️ [Groq] Error en transcripción (no crítico): ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// PASO 1: Análisis visual con Gemini 2.0 Flash
// ---------------------------------------------------------------------------

/**
 * Descarga una imagen/thumbnail y la convierte a base64.
 */
async function fetchAsBase64(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'vidalis-ai/1.0' }
  });
  const mimeType = response.headers['content-type']?.split(';')[0] || 'image/jpeg';
  const base64 = Buffer.from(response.data).toString('base64');
  return { base64, mimeType };
}

const VISUAL_ANALYSIS_PROMPT = (title, isFullVideo = false) => {
  const mediaDesc = isFullVideo
    ? `Mirá este VIDEO completo${title ? ` titulado "${title}"` : ''}`
    : `Analizá este contenido visual${title ? ` titulado "${title}"` : ''}`;

  return `${mediaDesc} de una publicación para redes sociales (TikTok/Instagram/YouTube).

═══ FRAMEWORK HOOK-RETAIN-REWARD ═══
Analizá el contenido usando esta estructura de retención profesional:

🎣 HOOK (0-3 segundos):
- ¿Qué elemento visual/auditivo aparece primero? ¿Genera curiosidad inmediata?
- ¿Hay un "pattern interrupt" (algo inesperado que frena el scroll)?
- ¿El primer frame comunica de qué va el video o genera misterio?
- Puntuá la fuerza del hook: débil / medio / fuerte / irresistible

⏳ RETAIN (3-15 segundos — zona crítica de retención):
- ¿Qué mantiene al espectador? ¿Hay progresión narrativa, tensión, o revelación gradual?
- ¿Hay cortes/transiciones que mantienen el ritmo? ¿O el video se estanca?
- ¿El espectador quiere saber "qué pasa después"?
- ¿Hay un "open loop" (pregunta sin responder que obliga a quedarse)?

🎁 REWARD (final — lo que se lleva el espectador):
- ¿Hay payoff emocional? (sorpresa, risa, satisfacción, inspiración, plot twist)
- ¿El final motiva a compartir, comentar o ver de nuevo?
- ¿Hay call-to-action implícito o explícito?
- ¿El video funciona en loop (el final conecta con el inicio)?

═══ ANÁLISIS DETALLADO ═══
1. NARRACIÓN COMPLETA: Describí qué pasa de principio a fin — acciones, movimientos, expresiones, evolución del contenido
2. FORMATO EXACTO: imitación/parodia, lip sync, baile/coreografía, tutorial, antes/después, reacción, storytelling, comedia, trend, dueto, POV, GRWM, storytime, unboxing, challenge, transición creativa
3. REFERENCIAS CULTURALES: Si imita/referencia a un artista (Shakira, Becky G, Bad Bunny, Karol G, Rosalía, Taylor Swift, etc.), canción, película, serie o trend viral — NOMBRE EXACTO. Fijate en vestuario, gestos, coreografías, lip sync
4. TONO Y MOOD: energético, sensual, dramático, cómico, motivacional, nostálgico, vulnerable, empoderado, etc.
5. ELEMENTOS VIRALES: transiciones, cambios de outfit, efectos visuales, sorpresas, humor, relatabilidad, controversia sana, duet-bait, stitch-bait, comment-bait

═══ PSICOLOGÍA DE ENGAGEMENT ═══
Identificá qué gatillos psicológicos activa el contenido:
- FOMO (Fear of Missing Out): ¿el espectador siente que se pierde algo?
- SOCIAL PROOF: ¿muestra resultados, transformaciones o validación?
- RECIPROCIDAD: ¿ofrece valor (tips, info, entretenimiento) que genera ganas de interactuar?
- IDENTIFICACIÓN: ¿el espectador se ve reflejado? ¿dice "esto me pasa a mí"?
- CURIOSIDAD GAP: ¿abre una brecha entre lo que sabés y lo que querés saber?
- CONTROVERSIA SANA: ¿genera opiniones divididas que provocan comentarios?

═══ EVALUACIÓN POR PLATAFORMA ═══
- TIKTOK: ¿optimizado para watch time completo + replays? ¿funciona en loop? ¿genera duets/stitches?
- INSTAGRAM REELS: ¿tiene calidad visual alta? ¿genera saves? ¿el caption puede complementar?
- YOUTUBE SHORTS: ¿el thumbnail (primer frame) es potente? ¿retiene los primeros 3 segundos?

═══ PÚBLICO OBJETIVO ═══
- Rango de edad, género predominante, intereses, comunidades que conectarían
- ¿En qué momento del día este contenido rendiría mejor?

IMPORTANTE: Las imitaciones de artistas famosos, parodias y recreaciones de trends tienen ALTO potencial viral — siempre identificalas con nombre.
Sé específico y detallado. Esta información se usará para generar copy profesional y calcular el potencial viral con frameworks de marketing digital.`;
};

const isGeminiUnavailable = (err) =>
  err.status === 429 || err.status === 503 || err.status === 404 ||
  (err.message && (err.message.includes('429') || err.message.includes('503') ||
    err.message.includes('404') || err.message.includes('not found') ||
    err.message.includes('alta demanda') || err.message.includes('high demand') ||
    err.message.includes('quota') || err.message.includes('cuota')));

/**
 * Fallback: analiza la imagen usando Claude Vision cuando Gemini no está disponible.
 */
async function analyzeWithClaudeVision(base64, mimeType, title = '') {
  logDebug('🔄 [Claude Vision] Gemini no disponible — usando Claude como fallback visual...');
  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: VISUAL_ANALYSIS_PROMPT(title, false) }
      ]
    }]
  });
  return msg.content[0].text;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout (${ms / 1000}s): ${label}`)), ms)
    ),
  ]);
}

async function uploadVideoToGemini(buffer, mimeType) {
  const tmpDir = require('os').tmpdir();
  const tmpPath = path.join(tmpDir, `vidalis_${Date.now()}.mp4`);

  try {
    fs.writeFileSync(tmpPath, buffer);
    const uploadResult = await getFileManager().uploadFile(tmpPath, {
      mimeType,
      displayName: `vidalis_analysis_${Date.now()}`,
    });
    logDebug(`☁️ [File API] Video subido a Google: ${uploadResult.file.name} (${uploadResult.file.sizeBytes} bytes)`);

    // Esperar a que Google termine de procesar el video
    let file = uploadResult.file;
    let attempts = 0;
    while (file.state === 'PROCESSING' && attempts < 30) {
      await new Promise(r => setTimeout(r, 2000));
      const check = await getFileManager().getFile(file.name);
      file = check;
      attempts++;
    }

    if (file.state === 'FAILED') {
      throw new Error(`Google rechazó el video: ${file.error?.message || 'estado FAILED'}`);
    }

    return file;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

async function buildVideoContentParts(mediaUrl, title) {
  const INLINE_LIMIT = 18 * 1024 * 1024;

  try {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'vidalis-ai/1.0' },
    });
    const buffer = Buffer.from(response.data);
    const videoMime = response.headers['content-type']?.split(';')[0] || 'video/mp4';
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);

    // Videos chicos: inline directo (más rápido)
    if (buffer.length <= INLINE_LIMIT) {
      logDebug(`🎬 [Gemini] Video inline: ${sizeMB}MB (${videoMime})`);
      return {
        parts: [
          { inlineData: { data: buffer.toString('base64'), mimeType: videoMime } },
          VISUAL_ANALYSIS_PROMPT(title, true),
        ],
        mode: 'full_video',
      };
    }

    // Videos grandes: File API (sin límite práctico)
    logDebug(`🎬 [Gemini] Video grande (${sizeMB}MB) — usando File API...`);
    const file = await uploadVideoToGemini(buffer, videoMime);
    return {
      parts: [
        { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
        VISUAL_ANALYSIS_PROMPT(title, true),
      ],
      mode: 'full_video_fileapi',
    };
  } catch (err) {
    logDebug(`⚠️ [Gemini] Error con video completo (${err.message}) — fallback a frames`);
  }

  // Fallback: 3 frames
  const thumbUrls = extractVideoThumbnails(mediaUrl);
  const frames = await Promise.allSettled(thumbUrls.map(url => fetchAsBase64(url)));
  const validFrames = frames
    .filter(r => r.status === 'fulfilled')
    .map(r => ({ inlineData: { data: r.value.base64, mimeType: r.value.mimeType } }));

  if (validFrames.length === 0) {
    const fb = await fetchAsBase64(extractVideoThumbnail(mediaUrl));
    validFrames.push({ inlineData: { data: fb.base64, mimeType: fb.mimeType } });
  }

  const extra = validFrames.length > 1
    ? `\n\nEstás viendo ${validFrames.length} frames del video: inicio (0s), gancho (3s) y frame representativo. Analizá el video como un todo.`
    : '';
  return {
    parts: [...validFrames, VISUAL_ANALYSIS_PROMPT(title, false) + extra],
    mode: 'frames',
  };
}

async function analyzeWithGemini(mediaUrl, mediaType, title = '') {
  let contentParts;
  let analysisMode = 'image';

  if (mediaType === 'video') {
    const built = await buildVideoContentParts(mediaUrl, title);
    contentParts = built.parts;
    analysisMode = built.mode;
  } else {
    const { base64, mimeType } = await fetchAsBase64(mediaUrl);
    contentParts = [{ inlineData: { data: base64, mimeType } }, VISUAL_ANALYSIS_PROMPT(title, false)];
  }

  const timeout = analysisMode.startsWith('full_video') ? 90000 : 45000;

  // 1. Intento principal: Gemini 2.5 Flash
  try {
    const model = getGemini().getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await withTimeout(
      model.generateContent(contentParts),
      timeout, 'Gemini 2.5 Flash'
    );
    logDebug(`✅ [Gemini 2.5] Análisis completado (modo: ${analysisMode})`);
    return result.response.text();
  } catch (error) {
    if (!isGeminiUnavailable(error) && !error.message?.includes('Timeout')) throw error;
    logDebug(`⚠️ Gemini 2.5 Flash no disponible (${error.message}). Probando gemini-2.0-flash...`);
  }

  // 2. Fallback: Gemini 2.0 Flash
  try {
    const fallbackModel = getGemini().getGenerativeModel({ model: 'gemini-2.0-flash' });
    const fallbackResult = await withTimeout(
      fallbackModel.generateContent(contentParts),
      timeout, 'Gemini 2.0 Flash'
    );
    logDebug(`✅ [Gemini 2.0] Análisis completado (modo: ${analysisMode})`);
    return fallbackResult.response.text();
  } catch (error) {
    if (!isGeminiUnavailable(error) && !error.message?.includes('Timeout')) throw error;
    logDebug(`⚠️ Gemini 2.0 Flash tampoco disponible (${error.message}). Usando Claude Vision...`);
  }

  // 3. Último recurso: Claude Vision (solo 1 frame)
  const { base64, mimeType } = await fetchAsBase64(
    mediaType === 'video' ? extractVideoThumbnail(mediaUrl) : mediaUrl
  );
  return analyzeWithClaudeVision(base64, mimeType, title);
}

// ---------------------------------------------------------------------------
// PASO 2: Generación de copy con Claude (usa análisis visual + transcripción)
// ---------------------------------------------------------------------------

/**
 * Genera copy de marketing con Claude.
 * @param {string} geminiAnalysis - Análisis visual de Gemini
 * @param {string|null} transcript - Transcripción de audio (Groq), puede ser null
 * @param {string} title
 * @param {string[]} platforms
 * @param {{ nombre, genero, audiencia, tono }|null} artistContext - Contexto del artista
 * @returns {{ ai_copy_short, ai_copy_long, hashtags, viral_score }}
 */
async function generateCopyWithClaude(geminiAnalysis, transcript, title = '', platforms = [], artistContext = null, learningContext = null) {
  const platformList = platforms.length > 0 ? platforms.join(', ') : 'TikTok, Instagram, YouTube';

  let systemPrompt = `Sos un Compañero Manager y Estratega de Contenido Digital de nivel agencia profesional. Tu objetivo es acompañar al artista y a su equipo para potenciar su crecimiento en ${platformList}.
Tu tono es motivador, colaborativo y experto, pero siempre cercano. Hablá en plural ("Nosotros", "Vamos a probar").

═══ FRAMEWORKS DE MARKETING DIGITAL ═══

📋 AIDA (Attention-Interest-Desire-Action):
- El copy CORTO debe ser puro ATTENTION + ACTION (captar y provocar interacción)
- El copy LARGO debe seguir AIDA completo: captar → generar interés → despertar deseo → llamar a la acción

📋 PAS (Problem-Agitate-Solution):
- Si el contenido resuelve un problema o muestra una transformación, usá PAS:
  Problem: identificá el dolor/frustración del público
  Agitate: amplificá por qué ese problema importa
  Solution: posicioná el contenido como la respuesta

📋 HOOK-RETAIN-REWARD (estructura de retención):
- El copy debe reforzar el HOOK del video (no repetirlo, complementarlo)
- Si el video tiene un REWARD fuerte (sorpresa, plot twist), el copy debe generar anticipación sin spoilear

📋 STORYTELLING ARC:
- Setup → Conflict → Resolution: si el video cuenta una historia, el copy debe amplificarla
- Usá "open loops" en el copy corto para forzar que lean el largo o vean el video completo

📋 3H DE YOUTUBE (Hero-Hub-Hygiene):
- HERO: contenido épico/aspiracional → copy emocional, grandioso
- HUB: contenido recurrente/serie → copy que invita a seguir para más
- HYGIENE: contenido evergreen/tutorial → copy con keywords de búsqueda

═══ PRINCIPIOS DE COPYWRITING ═══
1. Claridad sobre Creatividad: Si hay que elegir entre ser ingenioso o ser claro, elegí ser CLARO.
2. Beneficios sobre Funcionalidades: No digas solo qué hacés, decí qué significa para el usuario.
3. Especificidad: Evitá palabras vagas como "increíble" o "optimizado". Usá números y datos específicos.
4. Lenguaje del Cliente: Usá términos que usaría una persona real, no jerga corporativa.
5. Una idea por sección: Mantené el mensaje enfocado.
6. Voz Activa y Directa: Sé asertivo. No entierres el valor en explicaciones largas.
7. Emociones primero: La gente comparte lo que les hace SENTIR algo (risa, asombro, nostalgia, orgullo).
8. Pattern Interrupt: El primer line del copy debe frenar el scroll — usá datos, preguntas provocadoras o declaraciones contraintuitivas.

═══ REGLAS POR PLATAFORMA ═══
- TIKTOK: el algoritmo premia watch time + shares + replays. Copy corto y directo. Hashtags de nicho. CTA tipo "comenta si..." o "envíaselo a alguien que..."
- INSTAGRAM: el algoritmo premia saves + comments + shares. Copy puede ser más largo y reflexivo. Carruseles de valor. CTA tipo "guardá esto" o "¿qué opinás?"
- YOUTUBE: el algoritmo premia CTR del thumbnail + retención de audiencia + session time. Copy con keywords de búsqueda. CTA tipo "mirá hasta el final" o "suscribite para más"

═══ GATILLOS PSICOLÓGICOS ═══
Usá al menos 2 de estos en cada copy:
- FOMO: urgencia, exclusividad, "antes de que..."
- SOCIAL PROOF: números, resultados, testimonios implícitos
- RECIPROCIDAD: dar valor primero (tip, dato, secreto) para generar interacción
- CURIOSIDAD GAP: abrir una pregunta que solo se responde viendo el contenido
- IDENTIFICACIÓN: "¿Te pasó esto?" — hacer que el público se sienta representado
- CONTROVERSIA SANA: opiniones que dividen y generan debate en comentarios`;

  if (artistContext) {
    systemPrompt += `\n\nConozco bien a nuestro artista:
- Nombre: ${artistContext.nombre || 'N/A'}
- Estilo/Género: ${artistContext.genero || 'N/A'}
- Nuestra Audiencia: ${artistContext.audiencia || 'N/A'}
- Nuestro Tono: ${artistContext.tono || 'N/A'}`;
  }

  // Inyectar ADN Creativo (Gustos del usuario/manager)
  const dna = learningContext?.creativeDNA;
  if (dna) {
    systemPrompt += `\n\nNUESTRO ADN CREATIVO (Gustos actuales del equipo):
- Notas de Estilo: ${dna.style_notes || 'N/A'}
- Hooks Preferidos: ${dna.preferred_hooks || 'N/A'}
- Temas Prohibidos (NUNCA USAR): ${dna.prohibited_topics || 'N/A'}`;
    if (dna.style_keywords) systemPrompt += `\n- Keywords de Marca: ${dna.style_keywords}`;
  }

  // Inyectar aprendizaje histórico real de la BD
  if (learningContext) {
    const { topHashtags, platformPerformance, scoreBias, topCopies, recentInsights, totalPostsAnalyzed, historicalAvg } = learningContext;

    systemPrompt += `\n\nAPRENDIZAJE DE PUBLICACIONES ANTERIORES (${totalPostsAnalyzed} posts analizados con métricas reales):`;

    if (platformPerformance?.length) {
      systemPrompt += `\n\nPerformance por plataforma (ordenado por engagement real):`;
      platformPerformance.forEach(p => {
        systemPrompt += `\n- ${p.platform.toUpperCase()}: ${p.avgEngagement}% engagement promedio, ${p.avgViews} vistas promedio, score real ${p.avgScore}/10`;
      });
    }

    if (topHashtags?.length) {
      systemPrompt += `\n\nHashtags que históricamente generaron MÁS engagement en este artista (priorizalos):
${topHashtags.join(' ')}`;
    }

    if (topCopies?.length) {
      systemPrompt += `\n\nEjemplos de copy que funcionaron (viral score real alto):`;
      topCopies.forEach(c => {
        systemPrompt += `\n- [Score ${c.score}/10 en ${(c.platforms||[]).join('+')}]: "${c.copy}"`;
      });
    }

    if (historicalAvg) {
      systemPrompt += `\n\nCONTEXTO: El score real promedio de este artista históricamente es ${historicalAvg}/10 — es referencia, NO un objetivo a igualar. Si este video específico es claramente mejor o peor que su historial, tu viral_score DEBE reflejar esa diferencia con claridad, aunque se aleje mucho de ${historicalAvg}.`;
    }

    if (recentInsights?.length) {
      systemPrompt += `\n\nDecisiones estratégicas recientes para este artista (a tener en cuenta):
${recentInsights.map(d => `- ${d}`).join('\n')}`;
    }
  }

  // Contenido del análisis visual + transcripción
  let userContent = `Análisis visual del contenido:\n${geminiAnalysis}`;

  if (transcript && transcript.trim().length > 10) {
    userContent += `\n\nTranscripción del audio:\n"${transcript.trim()}"

IMPORTANTE: Cruzá la transcripción con el análisis visual para entender QUÉ ESTÁ PASANDO REALMENTE en el video:
- Si el audio es una canción conocida y la persona está actuando/bailando → es un lip sync o imitación (alto potencial viral)
- Si el audio menciona un artista y la visual lo confirma → mencionalo en el copy
- Las imitaciones de artistas famosos (Shakira, Becky G, Bad Bunny, etc.) suelen generar alto engagement porque activan reconocimiento inmediato — el copy debe capitalizar esa referencia`;
  }

  userContent += `\n\nTítulo del contenido: ${title || '(sin título)'}

Generá el siguiente JSON (sin markdown, sin explicaciones, solo JSON puro). IMPORTANTE: generá los campos en ESTE orden — completá marketing_breakdown PRIMERO (decidí ahí el framework y los gatillos), después escribí el copy y los hashtags EJECUTANDO esa decisión, y calculá viral_score AL FINAL, como el promedio ponderado real de los sub-scores, nunca como una impresión general escrita antes de analizar:
{
  "marketing_breakdown": {
    "hook_score": 8,
    "retention_score": 7,
    "reward_score": 6,
    "shareability_score": 7,
    "audio_match_score": 8,
    "trend_alignment_score": 5,
    "framework_used": "AIDA",
    "psychological_triggers": ["CURIOSIDAD GAP", "IDENTIFICACIÓN"],
    "content_type_3h": "hub",
    "platform_fit": {
      "tiktok": 8,
      "instagram": 7,
      "youtube": 6
    },
    "best_posting_time": "19:00-21:00",
    "replay_potential": "alto",
    "comment_bait_strength": "medio"
  },
  "ai_copy_short": "Caption corto y potente (1-2 oraciones) que EJECUTA el framework_used y al menos uno de los psychological_triggers que ya decidiste arriba — no un texto genérico desconectado de esa decisión. Debe frenar el scroll y provocar interacción.",
  "ai_copy_long": "Versión extendida (3-5 oraciones) que sigue el framework_used completo (AIDA o PAS, según lo que ya decidiste) e incorpora los psychological_triggers detectados. Incluí storytelling, emociones y CTA estratégico.",
  "hashtags": "#etiqueta1 #etiqueta2 ... (15-20 hashtags estratégicos, alineados con el content_type_3h que ya decidiste)",
  "viral_score": 7.5
}

REGLAS DE HASHTAGS (MUY IMPORTANTE):
- Combiná 5-7 hashtags de nicho específico del contenido + 5-7 de comunidad/tendencia + 3-5 del artista que históricamente funcionaron.
- Alineá la mezcla con el content_type_3h que ya decidiste: "hero" pide hashtags aspiracionales/de mayor alcance, "hub" pide hashtags de comunidad/serie, "hygiene" pide hashtags de búsqueda/tutorial.
- NUNCA uses hashtags genéricos saturados como #viral, #fyp, #foryou, #parati, #trending, #explorepage — TikTok/Instagram los ignoran.
- NUNCA uses hashtags baneados o suprimidos (contenido sexual/sugestivo, spam, follow4follow, etc.) — causan shadowban y matan el alcance.
- Priorizá hashtags entre 10K-500K de volumen (nicho rentable) sobre los de millones (ruido).

REGLAS DE SCORING (MUY IMPORTANTE):
- Usá el rango completo 1-10 en cada sub-score — un video genuinamente débil en una dimensión va en 1-3, uno excepcional en 9-10. No agrupes tus respuestas alrededor de 6-8 "por las dudas", y no favorezcas números redondos por costumbre.
- viral_score: promedio ponderado → hook (25%) + retention (25%) + reward (20%) + shareability (20%) + trend (10%). Calculalo RECIÉN cuando ya decidiste los 5 sub-scores que promedia — nunca antes.
- hook_score: fuerza de los primeros 3 segundos (¿frena el scroll?)
- retention_score: ¿el video mantiene la atención hasta el final? ¿hay progresión?
- reward_score: ¿el final satisface? ¿genera replay? ¿motiva a compartir?
- shareability_score: ¿alguien etiquetaría a un amigo? ¿lo reenviaría por DM?
- audio_match_score: ¿el audio complementa el visual? ¿es trending sound?
- trend_alignment_score: ¿usa un formato/trend actual o es atemporal?
- platform_fit: score específico para cada plataforma según sus reglas de algoritmo
- content_type_3h: "hero" (épico), "hub" (recurrente) o "hygiene" (evergreen/educativo)
- replay_potential: "bajo", "medio", "alto" — ¿el video se ve más de una vez?
- comment_bait_strength: "bajo", "medio", "alto" — ¿provoca comentarios?

Basate en el análisis visual, la transcripción, los frameworks de marketing Y la calibración histórica del artista.
Respondé SOLO con el JSON, sin texto adicional.`;

  const mainPlatform = (platforms || [])[0] || 'tiktok';

  let calibrationCtx = learningContext;
  if (!calibrationCtx || calibrationCtx.totalPostsAnalyzed < 2) {
    const globalCal = await fetchGlobalCalibration();
    if (globalCal) {
      calibrationCtx = { ...globalCal, _globalFallback: true };
    }
  }

  const parseResponse = (raw) => {
    const text = raw.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude no devolvió JSON válido');
    const parsed = JSON.parse(jsonMatch[0]);

    let tags = parsed.hashtags || parsed.etiquetas || '';
    if (Array.isArray(tags)) tags = tags.join(' ');

    const hashtagCheck = checkHashtags(tags);
    if (hashtagCheck.banned.length > 0) {
      logDebug(`⚠️ [Hashtags] Baneados detectados y removidos: ${hashtagCheck.banned.join(', ')}`);
      tags = hashtagCheck.cleanHashtags;
    }
    if (hashtagCheck.risky.length > 0) {
      logDebug(`⚠️ [Hashtags] Riesgosos detectados: ${hashtagCheck.risky.join(', ')}`);
    }

    const rawScore = typeof parsed.viral_score === 'number' ? parsed.viral_score : (parseFloat(String(parsed.viral_score)) || null);
    const calibration = calibrateScore(rawScore, calibrationCtx, mainPlatform);

    const mb = parsed.marketing_breakdown || {};

    return {
      ai_copy_short: parsed.ai_copy_short || parsed.copy_corto || parsed.short_copy || '',
      ai_copy_long: parsed.ai_copy_long || parsed.copy_largo || parsed.long_copy || '',
      hashtags: tags,
      hashtag_warnings: hashtagCheck.warnings.length > 0 ? hashtagCheck.warnings : undefined,
      viral_score: calibration.score,
      score_raw: calibration.raw,
      score_confidence: calibration.confidence,
      score_adjustments: calibration.adjustments,
      marketing_breakdown: {
        hook_score: mb.hook_score || null,
        retention_score: mb.retention_score || null,
        reward_score: mb.reward_score || null,
        shareability_score: mb.shareability_score || null,
        audio_match_score: mb.audio_match_score || null,
        trend_alignment_score: mb.trend_alignment_score || null,
        framework_used: mb.framework_used || null,
        psychological_triggers: mb.psychological_triggers || [],
        content_type_3h: mb.content_type_3h || null,
        platform_fit: mb.platform_fit || {},
        best_posting_time: mb.best_posting_time || null,
        replay_potential: mb.replay_potential || null,
        comment_bait_strength: mb.comment_bait_strength || null,
      },
    };
  };

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      temperature: 0.7,
      system: systemPrompt,
      messages: [
        { role: "user", content: userContent }
      ],
    });
    return parseResponse(msg.content[0].text);
  } catch (error) {
    if (error.status === 404 || error.status === 429 || error.status === 529 || (error.message && (error.message.includes('404') || error.message.includes('429') || error.message.includes('529') || error.message.includes('overloaded')))) {
      console.warn(`⚠️ Claude sonnet-4 no disponible (${error.status}). Reintentando con claude-haiku-4-5-20251001...`);
      const fallbackMsg = await getAnthropic().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      });
      return parseResponse(fallbackMsg.content[0].text);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ORQUESTADOR PRINCIPAL
// ---------------------------------------------------------------------------

/**
 * Procesa un video/imagen con Groq + Gemini + Claude y guarda en Supabase.
 * @param {string} videoId
 * @param {string} videoUrl - URL con transformaciones (para análisis)
 * @param {string} sourceUrl - URL limpia (para guardar en DB)
 * @param {'video'|'image'} mediaType
 * @param {string[]} platforms
 * @param {string} title
 * @param {{ nombre, genero, audiencia, tono }|null} artistContext
 */
async function processVideoAI(videoId, videoUrl, sourceUrl, mediaType, platforms, title, artistContext = null, artistId = null) {
  logDebug(`🤖 [AI interno] Iniciando análisis para video ${videoId}`);

  async function updateProgress(step, message) {
    logDebug(`   [Paso ${step}] ${message}`);
    await supabase.from('videos').update({
      status: 'analyzing',
      ai_copy_short: `[Paso ${step}/4] ${message}`
    }).eq('id', videoId);
  }

  try {
    await updateProgress(1, 'Transcripción...');

    let transcript = null;
    if (mediaType === 'video') {
      transcript = await transcribeWithGroq(sourceUrl || videoUrl);
    }

    await updateProgress(2, 'Entendiendo contenido...');

    const geminiAnalysis = await analyzeWithGemini(videoUrl, mediaType, title);
    logDebug(`✅ [Gemini] Análisis completado para video ${videoId}`);

    await updateProgress(3, 'Aprendiendo del historial...');

    // Obtener contexto de aprendizaje histórico del artista desde la BD
    const learningContext = await fetchArtistLearningContext(artistId);
    if (learningContext) {
      logDebug(`📚 [Learning] Contexto cargado: ${learningContext.topHashtags.length} hashtags, bias=${learningContext.scoreBias}, best=${learningContext.bestPlatform}`);
    }

    // Paso 3: copy con Claude (con aprendizaje histórico)
    const copy = await generateCopyWithClaude(geminiAnalysis, transcript, title, platforms, artistContext, learningContext);
    logDebug(`✅ [Claude] Copy generado para video ${videoId}`);

    await updateProgress(4, 'Envío...');

    const calibrationMeta = {
      raw: copy.score_raw,
      calibrated: copy.viral_score,
      confidence: copy.score_confidence,
      adjustments: copy.score_adjustments,
      calibrated_at: new Date().toISOString(),
    };

    const updates = {
      status: 'needs_review',
      ai_copy_short: copy.ai_copy_short || null,
      ai_copy_long: copy.ai_copy_long || null,
      hashtags: copy.hashtags || null,
      viral_score: copy.viral_score,
      score_calibration: calibrationMeta,
      marketing_breakdown: copy.marketing_breakdown || null,
      error_log: null,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
    };

    const { error: dbError } = await supabase.from('videos').update(updates).eq('id', videoId);
    if (dbError) {
      logDebug(`❌ [AI interno] Error de Supabase al guardar: ${JSON.stringify(dbError)}`);
      throw new Error(`Error DB al guardar AI final: ${dbError.message || JSON.stringify(dbError)}`);
    }

    const mb = copy.marketing_breakdown || {};
    logDebug(`✅ [AI interno] Video ${videoId} procesado — score: raw=${copy.score_raw} → calibrated=${copy.viral_score} (${copy.score_confidence} confidence)`);
    if (mb.hook_score) {
      logDebug(`   📊 [Marketing] Hook:${mb.hook_score} Retain:${mb.retention_score} Reward:${mb.reward_score} Share:${mb.shareability_score} Audio:${mb.audio_match_score} Trend:${mb.trend_alignment_score} | Framework:${mb.framework_used} | 3H:${mb.content_type_3h} | Triggers:${(mb.psychological_triggers||[]).join(',')}`);
    }

    return updates;
  } catch (err) {
    logDebug(`❌ [AI interno] Error crítico procesando video ${videoId}:`);
    logDebug(`   - Mensaje: ${err.message}`);
    console.error(`   - Detalles:`, err.response?.data || 'No hay detalles adicionales');

    const errorDetail = JSON.stringify({
      message: err.message,
      details: err.response?.data || null,
      timestamp: new Date().toISOString()
    });

    await supabase.from('videos').update({
      status: 'error',
      ai_copy_short: null, // No sobreescribir el copy con el error
      error_log: errorDetail
    }).eq('id', videoId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// INSIGHTS DE ANALÍTICA con Claude
// ---------------------------------------------------------------------------

/**
 * Genera insights y recomendaciones de decisión basados en analíticas reales + historial.
 *
 * @param {object} profileAnalytics - Datos de seguidores, reach, etc. por plataforma
 * @param {Array}  posts            - Lista de posts con métricas reales (ya enriquecidos con engagement_rate, viral_score_real)
 * @param {string} artistName       - Nombre del artista/marca
 * @param {Array}  historicalInsights - Últimos 3 análisis anteriores (de analytics_insights_log)
 * @returns {{ insights, decisions, best_platform, best_post_title, engagement_rate }}
 */
async function generateInsights(profileAnalytics, posts, artistName = '', historicalInsights = []) {
  const platformSummary = Object.entries(profileAnalytics || {})
    .filter(([, v]) => v && v.success !== false)
    .map(([platform, data]) => {
      return `- ${platform.toUpperCase()}: ${data.followers || 0} seguidores, ${data.reach || 0} alcance, ${data.impressions || 0} impresiones`;
    }).join('\n') || 'Sin datos de plataformas disponibles.';

  // Posts con métricas reales + comparación entre viral score predicho vs real
  const postsSummary = (posts || []).slice(0, 15).map((p, i) => {
    const likes       = p.likes    || 0;
    const comments    = p.comments || 0;
    const views       = p.views    || 0;
    const shares      = p.shares   || 0;
    const engRate     = typeof p.engagement_rate === 'number' ? p.engagement_rate.toFixed(2) + '%' : '—';
    const scorePred   = p.viral_score      ? `${p.viral_score}/10 (predicho)` : '—';
    const scoreReal   = p.viral_score_real ? `${p.viral_score_real}/10 (real)` : '—';
    const platforms   = Array.isArray(p.platforms) ? p.platforms.join(', ') : 'desconocido';
    const date        = (p.published_at || p.created_at)
      ? new Date(p.published_at || p.created_at).toLocaleDateString('es-AR', { weekday: 'short', month: 'short', day: 'numeric' })
      : 'N/A';
    return `Post ${i + 1}: "${p.title || 'sin título'}" [${date}] [${platforms}]\n  ❤️ ${likes} likes | 💬 ${comments} comentarios | 👁 ${views} vistas | 🔁 ${shares} shares | Engagement: ${engRate} | Score ${scorePred} → ${scoreReal}`;
  }).join('\n\n') || 'Sin publicaciones con métricas disponibles.';

  // Historial de análisis anteriores (para detectar tendencias)
  let historySummary = '';
  if (historicalInsights.length > 0) {
    historySummary = `\nHISTORIAL DE ANÁLISIS ANTERIORES (últimos ${historicalInsights.length}):\n` +
      historicalInsights.map((h) => {
        const date = new Date(h.generated_at).toLocaleDateString('es-AR', { month: 'short', day: 'numeric' });
        const prevInsights = (h.insights || []).slice(0, 2).join(' / ');
        return `[${date}] Engagement: ${h.engagement_rate || 0}% | Seguidores: ${h.followers_total || 0} | Notas: ${prevInsights}`;
      }).join('\n');
  }

  const userContent = `Sos un estratega de contenido digital para redes sociales${artistName ? ` trabajando con "${artistName}"` : ''}.

DATOS DE PERFIL ACTUAL (por plataforma):
${platformSummary}
${historySummary}

ÚLTIMAS PUBLICACIONES CON MÉTRICAS REALES:
${postsSummary}

IMPORTANTE:
- Los posts tienen dos scores: "predicho" (estimado por IA al subir) y "real" (calculado con métricas reales de la plataforma).
- Si el score real es muy distinto del predicho, comentalo como aprendizaje.
- Basate en datos concretos. Si los datos son 0 o escasos, mencioná que se necesita más tiempo.

Respondé SOLO con este JSON (sin markdown, sin texto extra):
{
  "insights": [
    "observación 1 concreta sobre qué está funcionando o no, basada en los números",
    "observación 2: patrón detectado (plataforma, tipo de contenido, horario si hay datos)",
    "observación 3: comparación score predicho vs real — ¿la IA está aprendiendo bien?"
  ],
  "decisions": [
    "decisión 1: acción concreta y específica para esta semana (qué publicar, cuándo, dónde)",
    "decisión 2: ajuste de estrategia basado en engagement real",
    "decisión 3: qué tipo de contenido priorizar y por qué según los datos"
  ],
  "best_platform": "nombre de la plataforma con mejor engagement o 'sin datos suficientes'",
  "best_post_title": "título del post con mejor engagement_rate real o 'sin datos suficientes'",
  "engagement_rate": 0.0
}`;

  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1400,
      temperature: 0.45,
      system: `Sos un Compañero Manager y Estratega Digital con formación en frameworks profesionales de marketing. Tu misión es analizar nuestros resultados y acompañarme a tomar las mejores decisiones para el artista.
Tu análisis debe ser motivador pero basado 100% en los datos reales que hemos recolectado. Hablá como parte del equipo ("Estamos viendo", "Sugiero que vayamos por").

FRAMEWORKS QUE APLICÁS EN TUS ANÁLISIS:
- HOOK-RETAIN-REWARD: Evaluá si los posts exitosos tienen buenos hooks, retención y reward. Identificá patrones.
- AIDA / PAS: Evaluá qué framework de copy funciona mejor para este artista según los datos.
- 3H (Hero/Hub/Hygiene): Clasificá los posts por tipo y detectá qué categoría rinde más.
- REGLAS POR PLATAFORMA: TikTok premia watch time + shares, Instagram premia saves + comments, YouTube premia CTR + retención.
- GATILLOS PSICOLÓGICOS: Detectá qué gatillos (FOMO, Social Proof, Curiosidad, Identificación) generan más engagement en este artista.
- Tus decisiones deben ser accionables y referenciar frameworks específicos (ej: "El formato Hero funciona mejor — priorizar contenido épico sobre tutoriales").`,
      messages: [{ role: 'user', content: userContent }],
    });

    const raw = msg.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude no devolvió JSON válido en insights');
    const parsed = JSON.parse(jsonMatch[0]);
    // Asegurar que engagement_rate sea número
    if (typeof parsed.engagement_rate === 'string') {
      parsed.engagement_rate = parseFloat(parsed.engagement_rate) || 0;
    }
    return parsed;
  } catch (err) {
    logDebug(`❌ [generateInsights] Error: ${err.message}`);
    return {
      insights: ['No se pudieron generar insights. Verificá que haya publicaciones con métricas disponibles.'],
      decisions: ['Publicá más contenido y esperá 24-48hs para que las plataformas registren métricas.'],
      best_platform: 'sin datos suficientes',
      best_post_title: 'sin datos suficientes',
      engagement_rate: 0
    };
  }
}

/**
 * Realiza un análisis profundo de una lista de posts históricos (Auditoría de Marca).
 * @param {object} artist - Datos del artista.
 * @param {array} history - Array de objetos { title, likes, comments, viral_score }.
 */
async function runDeepAuditAnalysis(artist, history = []) {
  if (history.length === 0) {
    return {
      insights: ["No hay suficiente historial para realizar una auditoría profunda."],
      decisions: ["Empezar a publicar con Vidalis para generar datos reales."]
    };
  }

  const systemPrompt = `Sos un Consultor de Branding y Estratega Digital Senior con dominio de todos los frameworks de marketing digital para redes sociales. Tu objetivo es realizar una "Auditoría de Marca" basada en el historial real de publicaciones de un artista.
Tu tono es analítico, profesional y directo. No uses relleno.

FRAMEWORKS QUE APLICÁS:
- HOOK-RETAIN-REWARD: ¿Los posts exitosos tienen hooks fuertes? ¿Los que fallaron tenían hooks débiles?
- AIDA vs PAS: ¿Qué framework de copy funciona mejor para este artista según la data?
- 3H (Hero/Hub/Hygiene): Clasificá los posts por tipo — ¿qué categoría rinde más?
- GATILLOS PSICOLÓGICOS: ¿Qué gatillos (FOMO, Social Proof, Curiosidad, Identificación, Controversia) aparecen en los posts exitosos?
- REGLAS DE PLATAFORMA: TikTok premia watch time + shares, Instagram premia saves + comments, YouTube premia CTR + retención

DATOS DEL ARTISTA:
- Nombre: ${artist.name}
- Género/Estilo: ${artist.ai_genre || 'N/A'}
- Tono Manual: ${artist.ai_tone || 'N/A'}

HISTORIAL DE PUBLICACIONES (Los últimos 20-30 posts):
${history.map((h, i) => `${i+1}. [Título: ${h.title}] | Engagement: ${h.likes} likes, ${h.comments} comments | Score: ${h.viral_score || 'N/A'}`).join('\n')}

TU MISIÓN:
1. Detectar patrones de éxito usando frameworks: ¿Qué hooks, gatillos y formatos funcionaron?
2. Detectar debilidades: ¿Qué posts fallaron y POR QUÉ según los frameworks?
3. Clasificar el contenido con 3H y detectar qué categoría rinde más
4. Generar un "ADN Sugerido" basado en la DATA REAL con recomendaciones de frameworks

Respondé SOLO con el siguiente JSON:
{
  "insights": ["3-5 conclusiones clave referenciando frameworks específicos"],
  "decisions": ["3-5 acciones inmediatas tácticas basadas en frameworks"],
  "framework_analysis": {
    "dominant_3h_type": "hero|hub|hygiene — cuál predomina",
    "recommended_3h_mix": "70% hub, 20% hero, 10% hygiene — mix ideal para este artista",
    "strongest_triggers": ["gatillos psicológicos que mejor funcionan"],
    "weakest_area": "hook|retention|reward — área más débil según HOOK-RETAIN-REWARD",
    "best_copy_framework": "AIDA|PAS|Storytelling — cuál funciona mejor para este artista"
  },
  "suggested_dna": {
    "style_notes": "Cómo debe ser el tono basado en el éxito real",
    "preferred_hooks": "Ejemplos de ganchos que funcionan — basados en framework HOOK",
    "prohibited_topics": "Temas que no generan engagement o dañan la marca",
    "style_keywords": "4-5 palabras clave",
    "recommended_triggers": "Gatillos psicológicos a usar siempre"
  }
}`;

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: "Analizá mi historial y dame el reporte estratégico." }],
    });

    const raw = msg.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude no devolvió JSON en auditoría');
    
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('❌ Error en runDeepAuditAnalysis:', err.message);
    return {
      insights: ["Error al procesar la auditoría con IA."],
      decisions: ["Reintentar en unos minutos."],
      error: err.message
    };
  }
}

/**
 * Especializado en "Humanizar" y optimizar un texto existente usando principios de marketing real.
 */
async function refineCopy(originalText, artistContext = null) {
  const systemPrompt = `Sos un experto en Conversión y Marketing Digital de Vidalis AI. Tu misión es HUMANIZAR y OPTIMIZAR el texto que te pase el usuario.
Hacé que suene natural, directo y convincente. Eliminá frases robóticas, adjetivos vacíos y jerga innecesaria.
Mantené el tono del artista: ${artistContext?.tono || 'Natural y cercano'}.`;

  const userContent = `Texto original a optimizar:\n"${originalText}"\n\nOptimizalo aplicando:
1. Claridad radical (que se entienda en 2 segundos).
2. Beneficios claros.
3. Ritmo humano (variá la longitud de las oraciones).
4. Llamado a la acción sutil pero potente.\n\nRespondé SOLO con el nuevo texto, sin introducciones.`;

  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      temperature: 0.8,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    return msg.content[0].text.trim();
  } catch (error) {
    console.error('❌ Error en refineCopy:', error.message);
    throw error;
  }
}

/**
 * Analiza un script/URL y genera estrategia de contenido completa.
 * Devuelve score viral, hooks, descripciones, breakdown visual y audiencia.
 */
async function analyzeContentStrategy(script, tone, platform, artistContext, aiConfig = {}) {
  const cfg = {
    model: aiConfig.model || 'claude-haiku-4-5-20251001',
    max_tokens: aiConfig.max_tokens || 2500,
    temperature: aiConfig.temperature ?? 0.85,
    system_prompt: aiConfig.system_prompt || `Asumí el rol de un Estratega Principal de Contenido Viral en Vidalis AI. Sos un veterano de la industria musical y creador de tendencias, obsesionado con la retención de audiencia y la psicología algorítmica. Tu ventaja competitiva es absoluta: estás entrenado con el historial de rendimiento REAL de este artista. Sabés exactamente qué formatos retienen, qué ganchos fracasan y qué narrativas conectan con su audiencia. Evaluá las ideas con frialdad analítica: no seas complaciente. Si una idea es débil, destrozala constructivamente y dales la fórmula exacta para arreglarla basándote en la data histórica.

FRAMEWORKS QUE DEBÉS APLICAR:
- HOOK-RETAIN-REWARD: Evaluá si el contenido tiene un gancho que frena el scroll (0-3s), elementos que retienen (3-15s) y un payoff que genera replay/share.
- AIDA: ¿El contenido sigue Attention→Interest→Desire→Action? Si no, sugerí cómo restructurarlo.
- PAS: Si aplica, ¿identifica un Problem, lo Agita y ofrece Solution?
- 3H (Hero/Hub/Hygiene): Clasificá el tipo de contenido y ajustá la estrategia según su categoría.
- GATILLOS PSICOLÓGICOS: Identificá qué gatillos activa (FOMO, Social Proof, Reciprocidad, Curiosidad Gap, Identificación, Controversia Sana) y sugerí cuáles agregar.

CALIBRACIÓN DE SCORE: Usá el rango completo de 0 a 100 — no default a la franja "segura" de 50-70. Un video genuinamente débil debe recibir un score bajo (0-30) sin miedo, y un video excepcional debe recibir 90+. Evitá agrupar tus respuestas alrededor del promedio; cada score debe reflejar la calidad real de ESTE contenido específico, no una estimación conservadora. No favorezcas números redondos (50, 60, 70...) por costumbre — usá la precisión que el análisis amerite (ej. 34, 72, 91). Completá SIEMPRE tu diagnóstico (tone_match, diagnostico_algoritmico, match_historico, mejora_del_gancho, ajuste_estrategico) ANTES de decidir el número final — el score es la CONCLUSIÓN de ese razonamiento, no el punto de partida. Si existe un promedio histórico del artista, tratalo como referencia de contexto, nunca como un valor al que tu score deba parecerse — un contenido claramente mejor o peor que su historial debe reflejarlo con un score que se aleje de ese promedio.

REGLA CRÍTICA DE SISTEMA: Tu respuesta debe ser EXCLUSIVAMENTE un objeto JSON válido. Cero markdown, cero comillas invertidas, cero texto introductorio. Si incluís un solo carácter fuera del JSON, el pipeline fallará.`,
    score_criteria: aiConfig.score_criteria || `- 0-20 (Descarte): Idea genérica, aburrida o predecible. Cero potencial de retención. El usuario hará scroll en el primer segundo.
- 21-40 (Concepto Crudo): Hay una chispa, pero la ejecución es plana. Carece de un ángulo único o ignora por completo la identidad histórica del artista.
- 41-60 (Promedio/Aceptable): Buen concepto, pero mecánicamente débil. Requiere reescribir el gancho (hook), ajustar el ritmo visual o incorporar un catalizador emocional.
- 61-80 (Alto Potencial): Estructura viral sólida. El storytelling es claro, el gancho atrapa y se alinea con los picos históricos de rendimiento del artista. Necesita ajustes finos para maximizar compartidas.
- 81-100 (Unicornio/Hit): Ejecución magistral. Psicología de retención perfecta, alto potencial de shareability, aprovecha el contexto de forma original y conecta emocionalmente. Listo para grabar.

EJEMPLOS DE CALIBRACIÓN (anclas de referencia, no copies el contenido — usá el razonamiento):
- Idea: "Repito la misma rutina de baile que ya subí varias veces, sin ángulo nuevo." → Score ~15: cero sorpresa, la audiencia ya lo vio, no hay pattern interrupt.
- Idea: "Reacciono en cámara a un comentario random con un giro inesperado al final que conecta con mi historia personal." → Score ~90: gancho de curiosidad inmediato, open loop claro, payoff emocional que invita a compartir.
Tu score para el contenido real debe estar tan lejos de estos ejemplos como la calidad real lo justifique — no te quedes a mitad de camino "por las dudas".`,
  };

  const systemPrompt = cfg.system_prompt;

  // Traer contexto de aprendizaje real del artista (o global como fallback)
  let learningCtx = artistContext?.artistId
    ? await fetchArtistLearningContext(artistContext.artistId)
    : null;

  if (!learningCtx || learningCtx.totalPostsAnalyzed < 2) {
    const globalCal = await fetchGlobalCalibration();
    if (globalCal) learningCtx = { ...(learningCtx || {}), ...globalCal, _globalFallback: true };
  }

  // Bloque de historial de videos
  let historyBlock = '';
  if (artistContext?.videoHistory?.length > 0) {
    const videoList = artistContext.videoHistory
      .map(v => `  - "${v.title}" → score real: ${v.score}/100 (${(v.platforms || []).join(', ')})`)
      .join('\n');
    historyBlock = `
HISTORIAL DE VIDEOS DE "${artistContext.nombre}":
- Videos con métricas reales: ${artistContext.totalVideos}
- Score promedio real: ${artistContext.avgScore}/100
- Mejor score real: ${artistContext.bestScore}/100
- Últimos videos:
${videoList}`;
  }

  // Bloque de aprendizaje de datos reales
  let learningBlock = '';
  if (learningCtx) {
    const parts = [];

    if (learningCtx.scoreBias !== 0) {
      const direction = learningCtx.scoreBias > 0 ? 'sobreestimás' : 'subestimás';
      parts.push(`CALIBRACIÓN: Históricamente ${direction} por ${Math.abs(learningCtx.scoreBias)} puntos. Ajustá tu score en consecuencia.`);
    }

    if (learningCtx.platformPerformance?.length > 0) {
      const platList = learningCtx.platformPerformance
        .map(p => `  - ${p.platform}: engagement promedio ${p.avgEngagement}%, views promedio ${p.avgViews}, score promedio ${p.avgScore}`)
        .join('\n');
      parts.push(`RENDIMIENTO POR PLATAFORMA (datos reales):\n${platList}`);
    }

    if (learningCtx.topHashtags?.length > 0) {
      parts.push(`HASHTAGS QUE MEJOR FUNCIONAN: ${learningCtx.topHashtags.slice(0, 15).join(' ')}`);
    }

    if (learningCtx.topCopies?.length > 0) {
      const copyList = learningCtx.topCopies
        .map(c => `  - Score ${c.score}/100: "${c.copy.substring(0, 80)}..."`)
        .join('\n');
      parts.push(`COPIES QUE FUNCIONARON (usá como referencia de estilo):\n${copyList}`);
    }

    if (learningCtx.recentInsights?.length > 0) {
      parts.push(`DECISIONES ESTRATÉGICAS RECIENTES:\n${learningCtx.recentInsights.map(d => `  - ${d}`).join('\n')}`);
    }

    if (learningCtx.creativeDNA) {
      parts.push(`ADN CREATIVO DEL ARTISTA: ${JSON.stringify(learningCtx.creativeDNA)}`);
    }

    if (parts.length > 0) {
      learningBlock = `\n\nDATOS REALES DE RENDIMIENTO (usá esto para calibrar tu análisis):\n${parts.join('\n\n')}`;
    }
  }

  const userContent = `Analizá este contenido y generá estrategia completa:

Contenido: "${script}"
Tono objetivo: ${tone}
Plataforma: ${platform}
${artistContext ? `Artista: ${artistContext.nombre || 'desconocido'}, tono preferido: ${artistContext.tono || 'natural'}` : ''}
${historyBlock}${learningBlock}

MATCH DE TONO (esto afecta el score, no es solo contexto): Evaluá si el contenido REALMENTE ejecuta el tono declarado ("${tone}"), o si hay un desajuste entre lo que se pidió y lo que el contenido transmite. Una ejecución fiel y efectiva del tono elegido debe sumar al score; un desajuste claro (ej. se pidió "educational" pero el contenido no enseña nada, o se pidió "fun" pero resulta soso) debe restarle puntos — un contenido que no cumple el tono que se propuso conecta peor con su audiencia objetivo, sin importar qué tan pulido esté en otros aspectos.

INSTRUCCIONES DE SCORING:
${cfg.score_criteria}
${artistContext?.avgScore ? `Contexto: el promedio histórico REAL de este artista es ${artistContext.avgScore}/100 — es información de referencia, NO un objetivo a igualar. Si este contenido específico es claramente mejor o peor que su promedio histórico, tu score DEBE reflejar esa diferencia con claridad, aunque se aleje mucho de ${artistContext.avgScore}.` : ''}

Devolvé este JSON exacto (sin markdown). IMPORTANTE: generá los campos en ESTE orden — razoná primero, el score va al final de tu análisis (antes de las piezas creativas), nunca al principio:
{
  "tags": [<exactamente 3 strings: características detectadas del contenido>],
  "tone_match": "<¿el contenido ejecuta de verdad el tono '${tone}' declarado, o hay desajuste? Sé específico: si hay desajuste, decí cuál es>",
  "diagnostico_algoritmico": "<explicación de por qué el algoritmo de ${platform} empujará o frenará esto en los primeros 3 segundos>",
  "match_historico": "<qué dice la data previa del artista sobre este tipo de formato o temática — qué funcionó similar y qué no>",
  "mejora_del_gancho": "<reescritura del gancho inicial para retener el 70% de la audiencia en los primeros 3 segundos>",
  "ajuste_estrategico": "<un consejo de alto nivel para maximizar shares o comentarios>",
  "score": <número entero 0-100 — decidilo RECIÉN ACÁ, como conclusión de los 5 campos de análisis anteriores (incluyendo tone_match), calibrado con los datos reales>,
  "hooks": [<exactamente 3 hooks virales en español basados en el contenido${learningCtx?.topHashtags?.length ? ' — incluí hashtags que históricamente funcionan para este artista' : ''}>],
  "descriptions": [<exactamente 3 captions optimizadas con emojis y hashtags${learningCtx?.topHashtags?.length ? ' — priorizá estos hashtags probados: ' + learningCtx.topHashtags.slice(0, 8).join(' ') : ''}>],
  "visualBreakdown": [
    {"title": "Iluminación", "desc": "<recomendación concreta>"},
    {"title": "Ángulo de Cámara", "desc": "<recomendación de ángulo y encuadre>"},
    {"title": "Overlays", "desc": "<recomendación de texto/efectos visuales>"}
  ],
  "audience": {
    "demographic": "<rango de edad y perfil principal>",
    "peakTime": "<mejor horario basado en datos reales de engagement>"
  },
  "improvements": [<exactamente 3 strings: mejoras específicas y accionables para subir el score, basadas en lo que SÍ funcionó antes>]
}`;

  try {
    const msg = await getAnthropic().messages.create({
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      temperature: cfg.temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    const raw = msg.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude no devolvió JSON en analyzeContentStrategy');

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      parsed = JSON.parse(jsonrepair(jsonMatch[0]));
    }

    const cal = calibrateScore100(parsed.score || 50, learningCtx, platform);
    parsed.score = cal.score;
    parsed.score_raw = cal.raw;
    parsed.score_confidence = cal.confidence;
    parsed.score_adjustments = cal.adjustments;
    return parsed;
  } catch (err) {
    console.error('❌ Error en analyzeContentStrategy:', err.message);
    throw err;
  }
}

function applyVisualCalibration(parsed, learningCtx, platform) {
  const cal = calibrateScore100(parsed.overall || 50, learningCtx, platform);
  parsed.overall_raw = cal.raw;
  parsed.overall = cal.score;
  parsed.score_confidence = cal.confidence;
  parsed.score_adjustments = cal.adjustments;
  return parsed;
}

async function scoreVisualVirality(mediaUrl, mediaType, platform, artistId) {
  const imageUrl = mediaType === 'video' ? extractVideoThumbnail(mediaUrl) : mediaUrl;
  const { base64, mimeType } = await fetchAsBase64(imageUrl);

  let learningCtx = await fetchArtistLearningContext(artistId);
  if (!learningCtx || learningCtx.totalPostsAnalyzed < 2) {
    const globalCal = await fetchGlobalCalibration();
    if (globalCal) learningCtx = { ...(learningCtx || {}), ...globalCal, _globalFallback: true };
  }

  let calibrationNote = '';
  if (learningCtx?.platformPerformance?.length) {
    const platData = learningCtx.platformPerformance.find(p => p.platform === platform);
    if (platData) {
      calibrationNote = `\nDatos reales de este artista en ${platform}: engagement promedio ${platData.avgEngagement}%, views promedio ${platData.avgViews}, score promedio ${platData.avgScore}.`;
    }
  }
  if (learningCtx?.historicalAvg) {
    calibrationNote += `\nContexto: el score real promedio de este artista es ${(learningCtx.historicalAvg * 10).toFixed(0)}/100 — es referencia, NO un objetivo a igualar. Si esta imagen es claramente mejor o peor que su historial, tu "overall" debe reflejarlo con claridad, aunque se aleje mucho de ese promedio.`;
  }

  const prompt = `Sos un experto en viralidad de contenido en ${platform || 'redes sociales'} con dominio de frameworks profesionales de marketing digital.
${calibrationNote}

Usá el framework HOOK-RETAIN-REWARD para evaluar el potencial viral visual:
- HOOK: ¿Este frame/thumbnail frena el scroll en 0.5 segundos?
- RETAIN: ¿La composición visual genera curiosidad por ver más?
- REWARD: ¿Promete un payoff emocional que motive a ver el contenido completo?

CALIBRACIÓN: Usá el rango completo 0-100 en cada dimensión — una imagen genuinamente débil va en 0-30, una excepcional en 90+. No agrupes tus respuestas alrededor de 50-70 "por las dudas", y no favorezcas números redondos por costumbre.

QUICKFIXES ESPECÍFICOS: Tus 3 quickFixes deben atacar directamente la o las dimensiones con menor score de las 6 que evaluaste — no des consejos genéricos intercambiables entre imágenes distintas. Si "hook" o "scroll" tienen la dimensión más baja, decí específicamente qué cambiaría ESTA imagen puntual para mejorarlas.

Evaluá cada dimensión del 0 al 100 y devolvé SOLO este JSON (sin markdown). Completá las dimensiones PRIMERO y calculá "overall" AL FINAL, como el promedio ponderado real de lo que acabás de evaluar:
{
  "dimensions": {
    "hook": {"score": <0-100>, "label": "Gancho Visual (HOOK)", "detail": "<aplicando framework: ¿hay pattern interrupt? ¿qué atrapa o qué falta en los primeros 0.5 segundos?>"},
    "quality": {"score": <0-100>, "label": "Calidad Visual", "detail": "<iluminación, resolución, composición, colores, profesionalismo>"},
    "emotion": {"score": <0-100>, "label": "Impacto Emocional", "detail": "<qué gatillo psicológico activa: curiosidad, sorpresa, FOMO, identificación, o nada>"},
    "trend": {"score": <0-100>, "label": "Tendencia", "detail": "<qué tan alineado está con tendencias actuales de ${platform || 'redes'} — formatos, estilos visuales, estética>"},
    "thumb": {"score": <0-100>, "label": "Thumbnail Power", "detail": "<funcionaría como miniatura? contraste, texto overlay, expresión facial, clickbait visual>"},
    "scroll": {"score": <0-100>, "label": "Stop the Scroll (RETAIN)", "detail": "<¿la composición genera un open loop visual? ¿genera suficiente curiosidad para detener el scroll?>"}
  },
  "content_type_3h": "<hero|hub|hygiene — clasificación según el framework 3H de YouTube>",
  "psychological_triggers": [<gatillos detectados: FOMO, SOCIAL_PROOF, CURIOSIDAD_GAP, IDENTIFICACIÓN, CONTROVERSIA, RECIPROCIDAD>],
  "verdict": "<1 frase directa: se viraliza o no, y la razón principal según frameworks de marketing>",
  "quickFixes": [<3 mejoras concretas basadas en frameworks: HOOK más fuerte, gatillo psicológico faltante, optimización de plataforma>],
  "overall": <número entero 0-100 — decidilo RECIÉN ACÁ, como promedio ponderado real de las 6 dimensiones ya evaluadas arriba, no una impresión general>
}`;

  try {
    const model = getGemini().getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await withTimeout(
      model.generateContent([{ inlineData: { data: base64, mimeType } }, prompt]),
      45000, 'Gemini Visual Score'
    );
    const raw = result.response.text();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Gemini no devolvió JSON en scoreVisualVirality');
    return applyVisualCalibration(JSON.parse(jsonMatch[0]), learningCtx, platform);
  } catch (err) {
    if (isGeminiUnavailable(err) || err.message?.includes('Timeout')) {
      logDebug(`⚠️ Gemini no disponible para visual score, usando Claude Vision...`);
      const msg = await getAnthropic().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        temperature: 0.7,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });
      const raw = msg.content[0].text;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Claude no devolvió JSON en scoreVisualVirality');
      return applyVisualCalibration(JSON.parse(jsonMatch[0]), learningCtx, platform);
    }
    throw err;
  }
}

module.exports = {
  processVideoAI,
  analyzeWithGemini,
  generateCopyWithClaude,
  transcribeWithGroq,
  generateInsights,
  runDeepAuditAnalysis,
  refineCopy,
  analyzeContentStrategy,
  scoreVisualVirality,
  calibrateScore,
  calibrateScore100,
  fetchArtistLearningContext,
};
