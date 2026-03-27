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

let gemini = null;
let anthropic = null;

function getGemini() {
  if (!gemini) {
    console.log('🧪 [Gemini] Verificando API Key:', process.env.GEMINI_API_KEY ? 'Presente' : '⚠️ FALTANTE');
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurado');
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return gemini;
}

function getAnthropic() {
  if (!anthropic) {
    console.log('🧪 [Anthropic] Verificando API Key:', process.env.ANTHROPIC_API_KEY ? 'Presente' : '⚠️ FALTANTE');
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

/**
 * Analiza el contenido visual con Gemini 2.0 Flash.
 * @param {string} mediaUrl
 * @param {'video'|'image'} mediaType
 * @param {string} title
 * @returns {string} Análisis detallado
 */
async function analyzeWithGemini(mediaUrl, mediaType, title = '') {
  const model = getGemini().getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
  const imageUrl = mediaType === 'video' ? extractVideoThumbnail(mediaUrl) : mediaUrl;
  const { base64, mimeType } = await fetchAsBase64(imageUrl);

  const prompt = `Analizá este contenido visual${title ? ` titulado "${title}"` : ''}.
Describí en detalle:
1. Qué se ve (personas, escena, actividad, colores, estética, vestuario)
2. Tono y mood (energético, tranquilo, dramático, etc.)
3. Nicho o industria (música, moda, fitness, entretenimiento, etc.)
4. Elementos visuales que lo hacen atractivo o viral
5. Público objetivo probable

Sé específico y detallado. Esta información se usará para generar copy de marketing.`;

  const result = await model.generateContent([
    { inlineData: { data: base64, mimeType } },
    prompt
  ]);

  return result.response.text();
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
async function generateCopyWithClaude(geminiAnalysis, transcript, title = '', platforms = [], artistContext = null) {
  const platformList = platforms.length > 0 ? platforms.join(', ') : 'TikTok, Instagram, YouTube';

  // Construir system prompt con contexto del artista (si existe)
  let systemPrompt = `Sos un experto en marketing de contenido para redes sociales (${platformList}).`;
  if (artistContext) {
    systemPrompt += `\n\nContexto del artista:
- Nombre: ${artistContext.nombre || 'N/A'}
- Género/Nicho: ${artistContext.genero || 'N/A'}
- Público objetivo: ${artistContext.audiencia || 'N/A'}
- Tono de comunicación: ${artistContext.tono || 'N/A'}

Adaptá el copy y los hashtags al estilo, nicho y audiencia de este artista.`;
  }

  // Construir el mensaje con análisis visual y transcripción
  let userContent = `Análisis visual del contenido:
${geminiAnalysis}`;

  if (transcript && transcript.trim().length > 10) {
    userContent += `\n\nTranscripción del audio:
"${transcript.trim()}"

Usá la transcripción para entender mejor el mensaje del contenido y generá un copy más preciso y auténtico.`;
  }

  userContent += `\n\nTítulo del contenido: ${title || '(sin título)'}

Generá el siguiente JSON (sin markdown, sin explicaciones, solo JSON puro):
{
  "ai_copy_short": "Copy corto de 1-2 oraciones para caption de redes sociales. Enganchador, con llamado a la acción.",
  "ai_copy_long": "Copy largo de 3-5 oraciones. Más descriptivo, storytelling, ideal para YouTube o blog.",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3 ... (15-20 hashtags relevantes, mezcla de masivos y nicho)",
  "viral_score": 7.5
}

viral_score: número del 1 al 10 basado en el potencial viral del contenido.
Respondé SOLO con el JSON, sin texto adicional.`;

  const message = await getAnthropic().messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }]
  });

  const raw = message.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude no devolvió JSON válido');

  return JSON.parse(jsonMatch[0]);
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
async function processVideoAI(videoId, videoUrl, sourceUrl, mediaType, platforms, title, artistContext = null) {
  console.log(`🤖 [AI interno] Iniciando análisis para video ${videoId}`);

  try {
    await supabase.from('videos').update({ status: 'analyzing' }).eq('id', videoId);

    // Paso 0 (solo videos): transcripción de audio con Groq Whisper
    let transcript = null;
    if (mediaType === 'video') {
      transcript = await transcribeWithGroq(sourceUrl || videoUrl);
    }

    // Paso 1: análisis visual con Gemini
    console.log(`🔍 [Gemini] Analizando ${mediaType}...`);
    const geminiAnalysis = await analyzeWithGemini(videoUrl, mediaType, title);
    console.log(`✅ [Gemini] Análisis completado para video ${videoId}`);

    // Paso 2: copy con Claude (recibe análisis + transcripción + contexto artista)
    console.log(`✍️ [Claude] Generando copy para video ${videoId}...`);
    const copy = await generateCopyWithClaude(geminiAnalysis, transcript, title, platforms, artistContext);
    console.log(`✅ [Claude] Copy generado para video ${videoId}`);

    const updates = {
      status: 'ready',
      ai_copy_short: copy.ai_copy_short || null,
      ai_copy_long: copy.ai_copy_long || null,
      hashtags: copy.hashtags || null,
      viral_score: typeof copy.viral_score === 'number' ? copy.viral_score : null,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
    };

    await supabase.from('videos').update(updates).eq('id', videoId);
    console.log(`✅ [AI interno] Video ${videoId} procesado y guardado con éxito.`);

    return updates;
  } catch (err) {
    console.error(`❌ [AI interno] Error crítico procesando video ${videoId}:`);
    console.error(`   - Mensaje: ${err.message}`);
    console.error(`   - Detalles:`, err.response?.data || 'No hay detalles adicionales');
    
    await supabase.from('videos').update({ status: 'error' }).eq('id', videoId);
    throw err;
  }
}

module.exports = { processVideoAI, analyzeWithGemini, generateCopyWithClaude, transcribeWithGroq };
