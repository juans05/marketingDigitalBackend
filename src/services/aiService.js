/**
 * aiService.js — Procesamiento de IA interno (sin n8n)
 * Gemini 2.0 Flash (análisis visual) + Groq Whisper (transcripción) → Claude (copy)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);

const fs = require('fs');
const path = require('path');
const debugLogPath = path.join(process.cwd(), 'debug_ai.log');

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

function getGemini() {
  if (!gemini) {
    logDebug('🧪 [Gemini] Verificando API Key: ' + (process.env.GEMINI_API_KEY ? 'Presente' : '⚠️ FALTANTE'));
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurado');
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return gemini;
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
 * Extrae el primer frame de un video Cloudinary como JPEG (f_jpg,so_0).
 */
function extractVideoThumbnail(videoUrl) {
  if (!videoUrl.includes('cloudinary.com') || !videoUrl.includes('/upload/')) return videoUrl;
  const uploadIdx = videoUrl.indexOf('/upload/');
  const cleanBase = videoUrl.slice(0, uploadIdx + 8);
  const afterUpload = videoUrl.slice(uploadIdx + 8);
  const publicPart = afterUpload.replace(/^(?:[^/]+\/)*?(v\d+\/.*)$/, '$1');
  return `${cleanBase}f_jpg,so_0/${publicPart}`.replace(/\.(mp4|mov|webm)(\?|$)/i, '.jpg');
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

  try {
    const { data: artistProfile } = await supabase
      .from('artists')
      .select('name, ai_genre, ai_audience, ai_tone, creative_dna, branding_data')
      .eq('id', artistId)
      .single();

    // 1. Top 10 posts con mejor engagement real (solo los que tienen métricas)
    const { data: topPosts } = await supabase
      .from('videos')
      .select('title, hashtags, platforms, viral_score, viral_score_real, ai_copy_short, analytics_4h')
      .eq('artist_id', artistId)
      .not('viral_score_real', 'is', null)
      .order('viral_score_real', { ascending: false })
      .limit(10);

    // 2. Snapshots agrupados por plataforma (engagement promedio)
    const { data: snapshots } = await supabase
      .from('post_metrics_snapshots')
      .select('platform, likes, comments, views, shares, engagement_rate, viral_score_real')
      .eq('artist_id', artistId)
      .order('snapshot_at', { ascending: false })
      .limit(100);

    // 3. Últimos 3 análisis de insights (para detectar tendencias en decisiones)
    const { data: insightsLog } = await supabase
      .from('analytics_insights_log')
      .select('generated_at, insights, decisions, engagement_rate, best_platform')
      .eq('artist_id', artistId)
      .order('generated_at', { ascending: false })
      .limit(3);

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

    // --- Calibración: sesgo del modelo (predicho vs real) ---
    const calibrationPosts = (topPosts || []).filter(p => p.viral_score && p.viral_score_real);
    let scoreBias = 0;
    if (calibrationPosts.length > 0) {
      const totalBias = calibrationPosts.reduce((acc, p) => acc + (p.viral_score - p.viral_score_real), 0);
      scoreBias = parseFloat((totalBias / calibrationPosts.length).toFixed(1));
    }

    // --- Top copies que funcionaron (score real >= 6) ---
    const topCopies = (topPosts || [])
      .filter(p => (p.viral_score_real || 0) >= 6 && p.ai_copy_short)
      .slice(0, 3)
      .map(p => ({ copy: p.ai_copy_short, score: p.viral_score_real, platforms: p.platforms }));

    logDebug(`📚 [Learning] Artista ${artistId}: ${topHashtags.length} hashtags aprendidos, bias=${scoreBias}, best platform=${platformPerformance[0]?.platform || 'N/A'}`);

    return {
      topHashtags,          // hashtags que históricamente generan más engagement
      platformPerformance,  // plataformas ordenadas por engagement
      bestPlatform: platformPerformance[0]?.platform || null,
      scoreBias,            // si > 0 la IA sobreestima; si < 0 subestima
      topCopies,            // ejemplos de copy que funcionaron
      totalPostsAnalyzed: calibrationPosts.length,
      recentInsights: (insightsLog || []).flatMap(i => i.decisions || []).slice(0, 3),
      creativeDNA: artistProfile?.creative_dna || artistProfile?.branding_data?.creative_dna || null,
      brandingData: artistProfile?.branding_data || null,
    };
  } catch (err) {
    logDebug(`⚠️ [Learning] No se pudo obtener contexto de aprendizaje: ${err.message}`);
    return null;
  }
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

const VISUAL_ANALYSIS_PROMPT = (title) =>
  `Analizá este contenido visual${title ? ` titulado "${title}"` : ''}.
Describí en detalle:
1. Qué se ve (personas, escena, actividad, colores, estética, vestuario)
2. Tono y mood (energético, tranquilo, dramático, etc.)
3. Nicho o industria (música, moda, fitness, entretenimiento, etc.)
4. Elementos visuales que lo hacen atractivo o viral
5. Público objetivo probable

Sé específico y detallado. Esta información se usará para generar copy de marketing.`;

const isGeminiUnavailable = (err) =>
  err.status === 429 || err.status === 503 ||
  (err.message && (err.message.includes('429') || err.message.includes('503') ||
    err.message.includes('alta demanda') || err.message.includes('high demand') ||
    err.message.includes('quota') || err.message.includes('cuota')));

/**
 * Fallback: analiza la imagen usando Claude Vision cuando Gemini no está disponible.
 */
async function analyzeWithClaudeVision(base64, mimeType, title = '') {
  logDebug('🔄 [Claude Vision] Gemini no disponible — usando Claude como fallback visual...');
  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: VISUAL_ANALYSIS_PROMPT(title) }
      ]
    }]
  });
  return msg.content[0].text;
}

async function analyzeWithGemini(mediaUrl, mediaType, title = '') {
  const imageUrl = mediaType === 'video' ? extractVideoThumbnail(mediaUrl) : mediaUrl;
  const { base64, mimeType } = await fetchAsBase64(imageUrl);
  const prompt = VISUAL_ANALYSIS_PROMPT(title);

  // 1. Intento principal: Gemini 2.5 Flash
  try {
    const model = getGemini().getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType } },
      prompt
    ]);
    return result.response.text();
  } catch (error) {
    if (!isGeminiUnavailable(error)) throw error;
    logDebug(`⚠️ Gemini 2.5 Flash no disponible (${error.status || 'quota'}). Probando gemini-2.0-flash...`);
  }

  // 2. Fallback: Gemini 2.0 Flash
  try {
    const fallbackModel = getGemini().getGenerativeModel({ model: 'gemini-2.0-flash' });
    const fallbackResult = await fallbackModel.generateContent([
      { inlineData: { data: base64, mimeType } },
      prompt
    ]);
    return fallbackResult.response.text();
  } catch (error) {
    if (!isGeminiUnavailable(error)) throw error;
    logDebug(`⚠️ Gemini 2.0 Flash tampoco disponible (${error.status || 'quota'}). Usando Claude Vision...`);
  }

  // 3. Último recurso: Claude Vision
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

  let systemPrompt = `Sos un Compañero Manager y Estratega de Contenido Digital. Tu objetivo es acompañar al artista y a su equipo para potenciar su crecimiento en ${platformList}.
Tu tono es motivador, colaborativo y experto, pero siempre cercano. Hablá en plural ("Nosotros", "Vamos a probar").`;

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
    const { topHashtags, platformPerformance, scoreBias, topCopies, recentInsights, totalPostsAnalyzed } = learningContext;

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

    if (scoreBias !== 0) {
      const direction = scoreBias > 0 ? 'optimista (sobreestimado)' : 'conservador (subestimado)';
      const adjust = scoreBias > 0
        ? `He notado que antes hemos sido un poco optimistas, así que voy a ajustar el viral_score UN POCO HACIA ABAJO (~${Math.abs(scoreBias)} puntos) para ser más realistas con lo que hemos visto en su audiencia.`
        : `Nuestra audiencia está respondiendo mejor de lo que pensábamos, así que voy a ajustar el viral_score UN POCO HACIA ARRIBA (~${Math.abs(scoreBias)} puntos) para reflejar su verdadero potencial.`;
      systemPrompt += `\n\nCALIBRACIÓN DE NUESTRO EQUIPO: En publicaciones anteriores nuestro score predicho ha sido algo ${direction}. ${adjust}`;
    }

    if (recentInsights?.length) {
      systemPrompt += `\n\nDecisiones estratégicas recientes para este artista (a tener en cuenta):
${recentInsights.map(d => `- ${d}`).join('\n')}`;
    }
  }

  // Contenido del análisis visual + transcripción
  let userContent = `Análisis visual del contenido:\n${geminiAnalysis}`;

  if (transcript && transcript.trim().length > 10) {
    userContent += `\n\nTranscripción del audio:\n"${transcript.trim()}"\n\nUsá la transcripción para entender mejor el mensaje del contenido.`;
  }

  userContent += `\n\nTítulo del contenido: ${title || '(sin título)'}

Generá el siguiente JSON (sin markdown, sin explicaciones, solo JSON puro):
{
  "ai_copy_short": "Un caption corto y potente (1-2 oraciones). Buscamos engagement inmediato.",
  "ai_copy_long": "Una versión con más contexto (3-5 oraciones) para generar conexión/storytelling.",
  "hashtags": "#etiqueta1 #etiqueta2 ... (15-20 combinando nuestros clásicos que funcionan con nuevos relevantes)",
  "viral_score": 7.5
}

viral_score: número del 1 al 10. Basate en el análisis visual, la transcripción Y la calibración histórica del artista.
Respondé SOLO con el JSON, sin texto adicional.`;

  const parseResponse = (raw) => {
    const text = raw.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude no devolvió JSON válido');
    const parsed = JSON.parse(jsonMatch[0]);
    
    // Fuzzy matching de posibles propiedades por si Claude traduce las llaves al español.
    let tags = parsed.hashtags || parsed.etiquetas || '';
    if (Array.isArray(tags)) tags = tags.join(' ');

    return {
      ai_copy_short: parsed.ai_copy_short || parsed.copy_corto || parsed.short_copy || '',
      ai_copy_long: parsed.ai_copy_long || parsed.copy_largo || parsed.long_copy || '',
      hashtags: tags,
      viral_score: typeof parsed.viral_score === 'number' ? Math.round(parsed.viral_score) : (parseInt(String(parsed.viral_score)) || null),
    };
  };

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-sonnet-4-20250514",
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

    const updates = {
      status: 'needs_review',
      ai_copy_short: copy.ai_copy_short || null,
      ai_copy_long: copy.ai_copy_long || null,
      hashtags: copy.hashtags || null,
      viral_score: copy.viral_score,
      error_log: null, // Limpiar errores anteriores
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
    };

    const { error: dbError } = await supabase.from('videos').update(updates).eq('id', videoId);
    if (dbError) {
      logDebug(`❌ [AI interno] Error de Supabase al guardar: ${JSON.stringify(dbError)}`);
      throw new Error(`Error DB al guardar AI final: ${dbError.message || JSON.stringify(dbError)}`);
    }

    logDebug(`✅ [AI interno] Video ${videoId} procesado y guardado con éxito.`);

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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1400,
      temperature: 0.45,
      system: `Sos un Compañero Manager y Estratega Digital. Tu misión es analizar nuestros resultados y acompañarme a tomar las mejores decisiones para el artista.
Tu análisis debe ser motivador pero basado 100% en los datos reales que hemos recolectado. Hablá como parte del equipo ("Estamos viendo", "Sugiero que vayamos por").`,
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

  const systemPrompt = `Sos un Consultor de Branding y Estratega Digital Senior. Tu objetivo es realizar una "Auditoría de Marca" basada en el historial real de publicaciones de un artista.
Tu tono es analítico, profesional y directo. No uses relleno.

DATOS DEL ARTISTA:
- Nombre: ${artist.name}
- Género/Estilo: ${artist.ai_genre || 'N/A'}
- Tono Manual: ${artist.ai_tone || 'N/A'}

HISTORIAL DE PUBLICACIONES (Los últimos 20-30 posts):
${history.map((h, i) => `${i+1}. [Título: ${h.title}] | Engagement: ${h.likes} likes, ${h.comments} comments | Score: ${h.viral_score || 'N/A'}`).join('\n')}

TU MISIÓN:
1. Detectar patrones de éxito: ¿Qué temas o frases funcionaron mejor?
2. Detectar debilidades: ¿Qué posts pasaron desapercibidos?
3. Generar un "ADN Sugerido": Basado en la DATA REAL, ¿cuál debería ser el estilo, los hooks y temas del artista?

Respondé SOLO con el siguiente JSON:
{
  "insights": ["3-5 conclusiones clave sobre lo que funciona"],
  "decisions": ["3-5 acciones inmediatas tácticas"],
  "suggested_dna": {
    "style_notes": "Cómo debe ser el tono basado en el éxito real",
    "preferred_hooks": "Ejemplos de ganchos que funcionan",
    "prohibited_topics": "Temas que no generan engagement o dañan la marca",
    "style_keywords": "4-5 palabras clave"
  }
}`;

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-3-5-sonnet-20240620",
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

module.exports = { 
  processVideoAI, 
  analyzeWithGemini, 
  generateCopyWithClaude, 
  transcribeWithGroq, 
  generateInsights,
  runDeepAuditAnalysis
};
