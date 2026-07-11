/**
 * momentDetectionService.js — Claude-based moment detection from transcripts
 * Analyzes transcriptions to detect narrative moments suitable for short clips (15-90 seconds)
 */

const { getAnthropic } = require('../lib/anthropic');
const { extractJsonObject } = require('../lib/jsonExtract');
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

function logError(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${message}\n`;
  console.error(message);
  try {
    fs.appendFileSync(debugLogPath, logMsg);
  } catch (e) {
    console.error('Failed to write to debug_ai.log', e.message);
  }
}

/**
 * Formats timestamped segments as a script Claude can ground timestamps in,
 * e.g. "[0s-3s] Hola bienvenidos...". Plain concatenated text gives Claude
 * no way to know what second any sentence occurs at — asking it for
 * "timestamp de inicio en segundos" against untimed prose is an impossible
 * task, which is why it was returning empty/unusable moments.
 */
function formatTranscriptWithTimestamps(segments) {
  return segments
    .map(s => `[${Math.round(s.start)}s-${Math.round(s.end)}s] ${s.text}`)
    .join('\n');
}

/**
 * Detects narrative moments from a timestamped transcript using Claude Opus.
 * Analyzes transcripts to find clips suitable as short-form content (15-90 seconds).
 *
 * @param {Array<{text: string, start: number, end: number}>} segments - Timestamped transcript segments (from transcriptionService)
 * @param {string} videoTitle - Optional: video title for context
 * @param {string} videoId - Optional: video ID for tracking
 * @returns {Promise<Array>} Array of validated moments ordered by confidence (viral potential)
 * @throws {Error} If transcript is empty, Claude fails, or no valid moments detected
 */
async function detectMomentsWithClaude(segments = [], videoTitle = '', videoId = '') {
  // Validate input
  const hasContent = Array.isArray(segments) && segments.some(s => (s.text || '').trim().length > 0);
  if (!hasContent) {
    throw new Error('Transcript cannot be empty');
  }

  const timestampedTranscript = formatTranscriptWithTimestamps(segments);

  try {
    // Build the prompt
    let promptText = `Sos un editor experto en videos virales. Analiza la siguiente transcripción (con marcas de tiempo reales, en segundos) y detecta entre 3 y 8 momentos que funcionen como clips independientes de 15 a 90 segundos.

Para cada momento:
- Identifica el timestamp de inicio y fin EN BASE A LAS MARCAS DE TIEMPO REALES de la transcripción — no inventes tiempos, usá los que aparecen entre corchetes
- La duración (fin - inicio) debe estar entre 15 y 90 segundos
- Explica por qué es un buen gancho (frase con impacto, anécdota fuerte, plot twist, etc)
- Asigna confianza (0.0 a 1.0)
- Agrega tags relevantes (ej: "storytelling", "emotional", "hook", "punchline")

Ordena los momentos por potencial viral (mayor a menor).

IMPORTANTE: Solo devuelve JSON válido, sin markdown ni explicaciones adicionales.

Transcripción (formato "[inicio s-fin s] texto"):`;

    if (videoTitle) {
      promptText += `\n[Título: "${videoTitle}"]`;
    }

    promptText += `\n${timestampedTranscript}`;

    logDebug(`🧠 [MomentDetection] Analizando transcript (${timestampedTranscript.length} caracteres, ${segments.length} segmentos)${videoTitle ? ` - "${videoTitle}"` : ''}...`);

    // Call Claude Opus 4.6
    const client = getAnthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: promptText
        }
      ]
    });

    // Parse response
    if (!response.content || response.content.length === 0 || !response.content[0].text) {
      throw new Error('Invalid Claude response format');
    }

    const responseText = response.content[0].text;
    logDebug(`🧠 [MomentDetection] Respuesta cruda de Claude (${responseText.length} caracteres): ${responseText.slice(0, 2000)}${responseText.length > 2000 ? '…(truncado)' : ''}`);

    let parsedResponse;

    try {
      // Extract JSON from response (may be wrapped in markdown code blocks
      // or have trailing prose after it)
      const jsonText = extractJsonObject(responseText);
      if (!jsonText) {
        throw new Error('No JSON found in response');
      }
      parsedResponse = JSON.parse(jsonText);
    } catch (parseError) {
      logError(`❌ [MomentDetection] Parse error: ${parseError.message}`);
      throw new Error('Invalid Claude response format');
    }

    // Extract moments array
    const rawMoments = Array.isArray(parsedResponse.moments)
      ? parsedResponse.moments
      : [];

    if (rawMoments.length === 0) {
      logError(`❌ [MomentDetection] Claude devolvió 0 momentos. Claves de la respuesta parseada: [${Object.keys(parsedResponse).join(', ')}]`);
      throw new Error('No valid moments detected (Claude returned an empty moments array)');
    }

    logDebug(`🧠 [MomentDetection] Claude devolvió ${rawMoments.length} momentos candidatos, validando...`);

    // Validate and transform moments
    const rejections = [];
    const validMoments = rawMoments
      .map((moment, idx) => {
        const label = `#${idx + 1} (start=${moment.start}, end=${moment.end})`;

        // Validate timestamps
        const start = moment.start;
        const end = moment.end;

        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          rejections.push(`${label}: start/end no son números finitos`);
          return null;
        }

        if (end <= start) {
          rejections.push(`${label}: end <= start`);
          return null;
        }

        const duration = end - start;

        // Check duration constraints: 15-90 seconds
        if (duration < 15 || duration > 90) {
          rejections.push(`${label}: duración ${duration}s fuera de rango 15-90s`);
          return null;
        }

        // Validate and clamp confidence
        let confidence = parseFloat(moment.confidence) || 0.5;
        confidence = Math.max(0.0, Math.min(1.0, confidence));

        // Validate and truncate reason
        let reason = (moment.reason || '').toString().slice(0, 200);

        // Validate and limit tags
        let tags = [];
        if (Array.isArray(moment.tags)) {
          tags = moment.tags
            .filter(t => typeof t === 'string')
            .slice(0, 5);
        }

        return {
          index: moment.index !== undefined ? moment.index : idx + 1,
          start,
          end,
          reason,
          confidence,
          tags
        };
      })
      .filter(m => m !== null);

    if (validMoments.length === 0) {
      logError(`❌ [MomentDetection] Los ${rawMoments.length} momentos de Claude fallaron la validación:\n${rejections.join('\n')}`);
      throw new Error('No valid moments detected (all candidates failed validation)');
    }

    if (rejections.length > 0) {
      logDebug(`⚠️ [MomentDetection] ${rejections.length} de ${rawMoments.length} momentos descartados:\n${rejections.join('\n')}`);
    }

    // Sort by confidence (highest first) — this is the "viral potential"
    validMoments.sort((a, b) => b.confidence - a.confidence);

    logDebug(`✅ [MomentDetection] Detected ${validMoments.length} valid moments from transcript`);

    return validMoments;
  } catch (error) {
    if (error.message === 'Transcript cannot be empty' ||
        error.message === 'Invalid Claude response format' ||
        error.message.startsWith('No valid moments detected')) {
      throw error;
    }

    logError(`❌ [MomentDetection] Error: ${error.message}`);
    throw new Error(`Failed to detect moments: ${error.message}`);
  }
}

module.exports = {
  detectMomentsWithClaude
};
