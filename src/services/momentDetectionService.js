/**
 * momentDetectionService.js — Claude-based moment detection from transcripts
 * Analyzes transcriptions to detect narrative moments suitable for short clips (15-90 seconds)
 */

const { getAnthropic } = require('../lib/anthropic');
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
 * Detects narrative moments from a transcript using Claude Opus.
 * Analyzes transcripts to find clips suitable as short-form content (15-90 seconds).
 *
 * @param {string} transcript - Full transcript text
 * @param {string} videoTitle - Optional: video title for context
 * @param {string} videoId - Optional: video ID for tracking
 * @returns {Promise<Array>} Array of validated moments ordered by confidence (viral potential)
 * @throws {Error} If transcript is empty, Claude fails, or no valid moments detected
 */
async function detectMomentsWithClaude(transcript = '', videoTitle = '', videoId = '') {
  // Validate input
  if (!transcript || transcript.trim().length === 0) {
    throw new Error('Transcript cannot be empty');
  }

  const transcriptTrimmed = transcript.trim();

  try {
    // Build the prompt
    let promptText = `Sos un editor experto en videos virales. Analiza la siguiente transcripción y detecta entre 3 y 8 momentos que funcionen como clips independientes de 15 a 90 segundos.

Para cada momento:
- Identifica el timestamp de inicio (en segundos)
- Identifica el timestamp de fin (en segundos, máximo 90s después del inicio)
- Explica por qué es un buen gancho (frase con impacto, anécdota fuerte, plot twist, etc)
- Asigna confianza (0.0 a 1.0)
- Agrega tags relevantes (ej: "storytelling", "emotional", "hook", "punchline")

Ordena los momentos por potencial viral (mayor a menor).

IMPORTANTE: Solo devuelve JSON válido, sin markdown ni explicaciones adicionales.

Transcripción:`;

    if (videoTitle) {
      promptText += `\n[Título: "${videoTitle}"]`;
    }

    promptText += `\n${transcriptTrimmed}`;

    logDebug(`🧠 [MomentDetection] Analizando transcript (${transcriptTrimmed.length} caracteres)${videoTitle ? ` - "${videoTitle}"` : ''}...`);

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
    let parsedResponse;

    try {
      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      parsedResponse = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      logError(`❌ [MomentDetection] Parse error: ${parseError.message}`);
      throw new Error('Invalid Claude response format');
    }

    // Extract moments array
    const rawMoments = Array.isArray(parsedResponse.moments)
      ? parsedResponse.moments
      : [];

    if (rawMoments.length === 0) {
      throw new Error('No valid moments detected');
    }

    // Validate and transform moments
    const validMoments = rawMoments
      .map((moment, idx) => {
        // Validate timestamps
        const start = moment.start;
        const end = moment.end;

        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          return null;
        }

        if (end <= start) {
          return null;
        }

        const duration = end - start;

        // Check duration constraints: 15-90 seconds
        if (duration < 15 || duration > 90) {
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
      throw new Error('No valid moments detected');
    }

    // Sort by confidence (highest first) — this is the "viral potential"
    validMoments.sort((a, b) => b.confidence - a.confidence);

    logDebug(`✅ [MomentDetection] Detected ${validMoments.length} valid moments from transcript`);

    return validMoments;
  } catch (error) {
    if (error.message === 'Transcript cannot be empty' ||
        error.message === 'Invalid Claude response format' ||
        error.message === 'No valid moments detected') {
      throw error;
    }

    logError(`❌ [MomentDetection] Error: ${error.message}`);
    throw new Error(`Failed to detect moments: ${error.message}`);
  }
}

module.exports = {
  detectMomentsWithClaude
};
