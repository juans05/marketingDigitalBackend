/**
 * clipImpactScoringService.js — Scores a repurposer clip against a specific
 * platform using a dedicated 7-criteria rubric (hook, retention, emotional
 * impact, clarity, value, CTA, editing). Fully independent of
 * generateCopyWithClaude / calibrateScore, which remain untouched and keep
 * scoring normal (non-repurposer) video uploads.
 */

const { createClient } = require('@supabase/supabase-js');
const { getAnthropic } = require('../lib/anthropic');
const { extractJsonValue } = require('../lib/jsonExtract');
const { resolveSupabaseServiceKey } = require('../lib/resolveSupabaseServiceKey');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  resolveSupabaseServiceKey('clipImpactScoringService')
);

function logDebug(message) {
  console.log(`🎯 [ClipImpactScoring] ${message}`);
}

function logError(message) {
  console.error(`❌ [ClipImpactScoring] ${message}`);
}

function buildRubricPrompt({ parentVideoId, durationSeconds, platform, niche }) {
  return `# EVALUADOR DE IMPACTO DE CLIPS - MODELO DE PUNTUACIÓN

Eres un experto en viral content y estrategia de redes sociales.
Tu tarea: Analizar un clip extraído de video y asignarle un score de impacto (1-10).

## CONTEXTO DEL CLIP
- Video Padre ID: ${parentVideoId}
- Duración del clip: ${durationSeconds}
- Plataforma objetivo: ${platform}
- Niche: ${niche}

---

## CRITERIOS DE PUNTUACIÓN (Análisis independiente de cada uno)

### 1. HOOK/ATENCIÓN INICIAL (0-2 puntos)
¿Los primeros 0.5 segundos atrapan?
- **2 pts**: Contraste visual brutal, pregunta intrigante, sorpresa emocional
- **1.5 pts**: Movimiento dinámico, cambio de escena, elemento inesperado
- **1 pt**: Contenido relevante pero sin sorpresa
- **0 pts**: Introducción lenta, no llama atención

### 2. RETENCIÓN (Viewer Hold Rate) (0-2 puntos)
¿Mantiene el engagement en los segundos 1-3?
- **2 pts**: Tensión creciente, plot twist en desarrollo, pregunta sin respuesta
- **1.5 pts**: Información útil revelada progresivamente
- **1 pt**: Contenido consistente sin variación
- **0 pts**: Contenido plano o predecible

### 3. IMPACTO EMOCIONAL (0-2 puntos)
¿Genera reacción visceral?
- **2 pts**: Inspiración, shock, risa genuina, rabia constructiva, asombro
- **1.5 pts**: Emociones moderadas pero claras
- **1 pt**: Emociones ligeras o neutrales
- **0 pts**: Sin impacto emocional

### 4. CLARIDAD DEL MENSAJE (0-1.5 puntos)
¿Se entiende qué es o qué aprenderé en 3-6 segundos?
- **1.5 pts**: Ultra claro, sin confusión
- **0.75 pts**: Claro con pequeña ambigüedad
- **0 pts**: Confuso o poco claro

### 5. VALOR/PROPÓSITO (0-1.5 puntos)
¿El clip ofrece algo (aprendizaje, entretenimiento, inspiración)?
- **1.5 pts**: Enseña algo que la gente buscaba, resuelve un problema, entretiene
- **0.75 pts**: Tiene valor pero limitado
- **0 pts**: Puro relleno sin valor

### 6. CALL-TO-ACTION / ENGANCHE (0-1 punto)
¿Invita a interactuar o continuar?
- **1 pt**: CTA claro, pregunta abierta, continuación en series
- **0.5 pts**: CTA implícito
- **0 pts**: Sin invitación a actuar

### 7. EDICIÓN & PACING (0-0.5 puntos)
¿El ritmo del clip acelera o aburre?
- **0.5 pts**: Transiciones rápidas, cortes estratégicos, música/audio en sync
- **0.25 pts**: Edición correcta pero sin dinamismo
- **0 pts**: Pacing lento o edición confusa

---

## CÁLCULO FINAL

**SCORE BASE** = Suma de todos los criterios (máximo 10)

**AJUSTES POR CONTEXTO:**
- Si es educativo + entretenido: +0.5
- Si tiene elemento de sorpresa: +0.5
- Si es nativo de plataforma (ej: trending sound en TikTok): +0.5
- Si tiene texto overlay confuso: -0.5
- Si es contenido duplicado/genérico: -1

**SCORE FINAL** = Limitado a 1-10

---

## COPY PARA REDES (además del score)
Generá también el copy para acompañar este clip en ${platform}:
- copy_short: caption corto y directo (1-2 oraciones), con gancho, listo para pegar
- copy_long: versión extendida (3-5 oraciones) con storytelling y CTA

---

## ESTRUCTURA DE RESPUESTA

Respondé SOLO con este JSON (sin markdown, sin explicaciones):

{
  "parent_video_id": "${parentVideoId}",
  "platform": "${platform}",
  "score": 0,
  "score_breakdown": {
    "hook": 0,
    "retention": 0,
    "emotional_impact": 0,
    "clarity": 0,
    "value": 0,
    "cta": 0,
    "editing": 0
  },
  "main_strength": "",
  "main_weakness": "",
  "improvement_suggestion": "",
  "viral_likelihood": "",
  "recommended_platform": "",
  "hashtags_suggested": [],
  "copy_short": "",
  "copy_long": ""
}`;
}

async function scoreClipForPlatform(clip, { platform, niche, parentVideoId }) {
  const promptText = buildRubricPrompt({
    parentVideoId,
    durationSeconds: clip.duration,
    platform,
    niche: niche || 'general',
  });

  const client = getAnthropic();
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: promptText }],
  });

  if (!response.content || response.content.length === 0 || !response.content[0].text) {
    throw new Error('Invalid Claude response format');
  }

  const jsonText = extractJsonValue(response.content[0].text);
  if (!jsonText) {
    throw new Error('No JSON found in Claude response');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseError) {
    logError(`Parse error: ${parseError.message}`);
    throw new Error('Invalid Claude response format');
  }

  const rawScore = parseFloat(parsed.score);
  const score = Number.isFinite(rawScore) ? Math.max(1, Math.min(10, rawScore)) : 5;

  return {
    score,
    score_breakdown: parsed.score_breakdown || {},
    main_strength: parsed.main_strength || '',
    main_weakness: parsed.main_weakness || '',
    improvement_suggestion: parsed.improvement_suggestion || '',
    viral_likelihood: parsed.viral_likelihood || '',
    recommended_platform: parsed.recommended_platform || platform,
    hashtags_suggested: Array.isArray(parsed.hashtags_suggested) ? parsed.hashtags_suggested : [],
    copy_short: parsed.copy_short || '',
    copy_long: parsed.copy_long || '',
  };
}

async function scoreClipsWithImpactRubric(clips, { platform, niche, parentVideoId }) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('Clips array is required');
  }

  const scoredClips = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    try {
      logDebug(`Scoring clip ${i + 1}/${clips.length} for platform ${platform}`);
      const result = await scoreClipForPlatform(clip, { platform, niche, parentVideoId });
      scoredClips.push({ ...clip, score: result });
    } catch (error) {
      logError(`Failed to score clip ${i + 1}: ${error.message}`);
      scoredClips.push({
        ...clip,
        score: {
          score: 0,
          score_breakdown: {},
          main_strength: '',
          main_weakness: '',
          improvement_suggestion: '',
          viral_likelihood: '',
          recommended_platform: platform,
          hashtags_suggested: [],
          copy_short: '',
          copy_long: '',
          error: error.message,
        },
      });
    }
  }

  logDebug(`Scored ${scoredClips.length} clips`);
  return scoredClips;
}

async function persistClipScore(clipVideoId, platform, result) {
  const { error: upsertError } = await supabase
    .from('clip_platform_scores')
    .upsert({
      clip_video_id: clipVideoId,
      platform,
      score: result.score,
      score_breakdown: result.score_breakdown,
      main_strength: result.main_strength,
      main_weakness: result.main_weakness,
      improvement_suggestion: result.improvement_suggestion,
      viral_likelihood: result.viral_likelihood,
      recommended_platform: result.recommended_platform,
      hashtags_suggested: result.hashtags_suggested,
      copy_short: result.copy_short,
      copy_long: result.copy_long,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'clip_video_id,platform' });

  if (upsertError) throw upsertError;

  const { error: updateError } = await supabase
    .from('videos')
    .update({ clip_impact_score: result.score })
    .eq('id', clipVideoId);

  if (updateError) throw updateError;

  logDebug(`Persisted score for clip ${clipVideoId} / ${platform}: ${result.score}`);
}

async function rescoreClip(clipVideoId, platform, niche) {
  const { data: clipRow, error } = await supabase
    .from('videos')
    .select('id, parent_video_id, ai_clips_data')
    .eq('id', clipVideoId)
    .single();

  if (error || !clipRow) {
    throw new Error(`Clip not found: ${clipVideoId}`);
  }

  const clip = { duration: clipRow.ai_clips_data?.duration || 0 };

  const result = await scoreClipForPlatform(clip, {
    platform,
    niche: niche || 'general',
    parentVideoId: clipRow.parent_video_id,
  });

  await persistClipScore(clipVideoId, platform, result);

  return { clipVideoId, platform, ...result };
}

module.exports = {
  buildRubricPrompt,
  scoreClipForPlatform,
  scoreClipsWithImpactRubric,
  persistClipScore,
  rescoreClip,
};
