/**
 * growthService.js — Growth Pro features
 * Análisis de patrones, mejor horario, estrategia de contenido, A/B testing, ad copy
 */

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

async function _callClaude(prompt) {
  console.log(`[_callClaude] model=${MODEL} promptLen=${prompt.length}`);
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content[0]?.text || '';
  console.log(`[_callClaude] respuesta cruda (primeros 300 chars): ${text.substring(0, 300)}`);
  const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (match) {
    const parsed = JSON.parse(match[1] || match[0]);
    console.log(`[_callClaude] JSON parseado OK`);
    return parsed;
  }
  console.log(`[_callClaude] intentando JSON.parse directo`);
  return JSON.parse(text);
}

async function _getArtistVideos(artistId) {
  const { data, error } = await supabase
    .from('videos')
    .select('id, title, viral_score, created_at, platforms, hashtags, ai_copy_short, status')
    .eq('artist_id', artistId)
    .in('status', ['published', 'ready', 'needs_review'])
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  return data || [];
}

async function _getVideoMetrics(videoIds) {
  if (!videoIds.length) return [];
  const { data } = await supabase
    .from('post_metrics_snapshots')
    .select('video_id, views, likes, comments, shares, snapshot_at')
    .in('video_id', videoIds)
    .order('snapshot_at', { ascending: false });
  return data || [];
}

// ─── Insights de crecimiento ──────────────────────────────────────────────────

exports.getInsights = async (artistId) => {
  const videos = await _getArtistVideos(artistId);
  if (videos.length < 3) {
    return [{
      type: 'info',
      title: 'Publicando más datos',
      description: 'Necesitas al menos 3 videos publicados para detectar patrones. ¡Sigue subiendo contenido!',
      impact: 0,
    }];
  }

  const metrics = await _getVideoMetrics(videos.map(v => v.id));

  const summary = videos.slice(0, 10).map(v => {
    const m = metrics.filter(m => m.video_id === v.id);
    const totalLikes = m.reduce((s, r) => s + (r.likes || 0), 0);
    return `- "${v.title || 'sin título'}" | score: ${v.viral_score || 0} | likes: ${totalLikes} | plataformas: ${v.platforms}`;
  }).join('\n');

  const prompt = `Eres un experto en growth para content creators de música y entretenimiento.
Analiza estos videos publicados y detecta máximo 4 patrones de crecimiento accionables.

VIDEOS:
${summary}

Responde SOLO con JSON array:
[
  {
    "type": "content_type|timing|hashtag|platform|hook",
    "title": "Título corto del patrón (máx 8 palabras)",
    "description": "Explicación accionable de 1-2 oraciones.",
    "impact": 85
  }
]
impact = porcentaje de mejora estimado (0-400).`;

  try {
    return await _callClaude(prompt);
  } catch {
    return [{
      type: 'general',
      title: 'Continúa publicando',
      description: 'Con más videos publicados, la IA detectará patrones específicos de crecimiento para tu contenido.',
      impact: 0,
    }];
  }
};

// ─── Mejor hora para publicar ─────────────────────────────────────────────────

exports.getBestTime = async (artistId) => {
  const videos = await _getArtistVideos(artistId);
  const metrics = await _getVideoMetrics(videos.map(v => v.id));

  if (videos.length < 3 || metrics.length === 0) {
    return {
      day_of_week: 'Martes',
      hour: 20,
      reach_multiplier: 2.1,
      recommendation: 'Recomendación general: publica entre Martes y Jueves a las 8pm para maximizar alcance en tu audiencia.',
    };
  }

  // Agrega likes por hora/día del video
  const byDayHour = {};
  videos.forEach(v => {
    const date = new Date(v.created_at);
    const key = `${date.getDay()}_${date.getHours()}`;
    const m = metrics.filter(m => m.video_id === v.id);
    const likes = m.reduce((s, r) => s + (r.likes || 0), 0);
    if (!byDayHour[key]) byDayHour[key] = { likes: 0, count: 0, day: date.getDay(), hour: date.getHours() };
    byDayHour[key].likes += likes;
    byDayHour[key].count += 1;
  });

  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const entries = Object.values(byDayHour).filter(e => e.count > 0);

  if (!entries.length) {
    return { day_of_week: 'Martes', hour: 20, reach_multiplier: 2.0, recommendation: 'Publica los Martes a las 8pm como punto de partida.' };
  }

  const best = entries.sort((a, b) => (b.likes / b.count) - (a.likes / a.count))[0];
  const avg = entries.reduce((s, e) => s + e.likes / e.count, 0) / entries.length;
  const multiplier = avg > 0 ? (best.likes / best.count) / avg : 1.5;

  return {
    day_of_week: days[best.day],
    hour: best.hour,
    reach_multiplier: parseFloat(multiplier.toFixed(1)),
    recommendation: `Tus videos publicados los ${days[best.day]} a las ${best.hour}:00 generan ${multiplier.toFixed(1)}x más engagement. Aprovecha este horario para tu próximo video.`,
  };
};

// ─── Estrategia de contenido semanal ─────────────────────────────────────────

exports.getContentStrategy = async (artistId) => {
  const videos = await _getArtistVideos(artistId);

  if (videos.length < 2) {
    return [
      { content_type: 'Behind the scenes', emoji: '🎬', recommended_count: 2, reason: 'El contenido auténtico genera más conexión con tu audiencia.', avoid: false },
      { content_type: 'Video musical corto', emoji: '🎵', recommended_count: 1, reason: 'Muestra tu talento con un clip de 30s.', avoid: false },
    ];
  }

  const metrics = await _getVideoMetrics(videos.map(v => v.id));
  const summary = videos.slice(0, 8).map(v => {
    const m = metrics.filter(m => m.video_id === v.id);
    const likes = m.reduce((s, r) => s + (r.likes || 0), 0);
    return `"${v.title || 'sin título'}" score=${v.viral_score || 0} likes=${likes}`;
  }).join(', ');

  const prompt = `Eres un estratega de contenido para artistas musicales en redes sociales.
Basándote en estos videos recientes: ${summary}

Genera una estrategia para ESTA SEMANA con exactamente 4 items JSON:
[
  {
    "content_type": "Tipo de contenido (máx 4 palabras)",
    "emoji": "1 emoji relevante",
    "recommended_count": 2,
    "reason": "Por qué funciona para este artista (1 oración)",
    "avoid": false
  },
  {
    "content_type": "Tipo a evitar esta semana",
    "emoji": "1 emoji",
    "recommended_count": 0,
    "reason": "Por qué evitarlo esta semana",
    "avoid": true
  }
]
Incluye 3 recomendados y 1 a evitar. Solo JSON.`;

  try {
    return await _callClaude(prompt);
  } catch {
    return [
      { content_type: 'Video corto musical', emoji: '🎵', recommended_count: 2, reason: 'Tu audiencia responde mejor al contenido musical directo.', avoid: false },
      { content_type: 'Behind the scenes', emoji: '🎬', recommended_count: 1, reason: 'Humaniza tu marca personal.', avoid: false },
      { content_type: 'Tendencias virales', emoji: '🔥', recommended_count: 1, reason: 'Un trend semanal amplifica el alcance orgánico.', avoid: false },
      { content_type: 'Contenido muy editado', emoji: '⚠️', recommended_count: 0, reason: 'Esta semana prioriza la autenticidad sobre la producción.', avoid: true },
    ];
  }
};

// ─── Historial de viral score ─────────────────────────────────────────────────

exports.getViralHistory = async (artistId) => {
  const { data, error } = await supabase
    .from('videos')
    .select('id, title, viral_score, created_at')
    .eq('artist_id', artistId)
    .not('viral_score', 'is', null)
    .order('created_at', { ascending: true })
    .limit(30);
  if (error) throw new Error(error.message);

  return (data || []).map(v => ({
    date: v.created_at?.split('T')[0],
    viral_score: v.viral_score,
    title: v.title,
  }));
};

// ─── A/B Testing ──────────────────────────────────────────────────────────────

exports.generateABVariants = async (videoId) => {
  console.log(`[growthService.generateABVariants] START videoId=${videoId}`);

  // 1. FETCH VIDEO + VALIDAR
  const { data: video, error } = await supabase
    .from('videos')
    .select('id, title, ai_copy_short, hashtags, platforms')
    .eq('id', videoId)
    .single();

  if (error || !video) {
    const msg = `Video no encontrado: ${error?.message || 'unknown'}`;
    console.error(`[generateABVariants] ${msg}`);
    throw new Error(msg);
  }

  // 2. PREPARAR DATOS
  const baseText = video.ai_copy_short || video.title || 'Nuevo contenido';
  const hashtags = Array.isArray(video.hashtags)
    ? video.hashtags.slice(0, 5).join(' ')
    : '';

  // 3. DETECTAR PLATAFORMA PRINCIPAL (si hay múltiples, toma la primera)
  const primaryPlatform = Array.isArray(video.platforms) && video.platforms.length > 0
    ? video.platforms[0].toLowerCase()
    : 'instagram';

  const platformConstraints = {
    instagram: { maxChars: 2200, style: 'enganchador, visual' },
    tiktok: { maxChars: 150, style: 'viral, trend-aware, hook fuerte' },
    youtube: { maxChars: 500, style: 'claro, descriptivo' },
    reels: { maxChars: 2200, style: 'dinámico, viral' },
  };

  const { maxChars, style } = platformConstraints[primaryPlatform] || platformConstraints.instagram;

  console.log(`[generateABVariants] baseText="${baseText.substring(0, 60)}..." platform=${primaryPlatform} maxChars=${maxChars}`);

  // 4. PROMPT MEJORADO
  const prompt = `Eres un experto en copywriting para ${primaryPlatform} especializado en artistas musicales.

CONTEXTO DEL VIDEO:
- Título: ${video.title || '(sin título)'}
- Concepto: ${baseText}
- Hashtags recomendados: ${hashtags || '(ninguno sugerido)'}
- Plataforma objetivo: ${primaryPlatform}
- Límite de caracteres: ${maxChars}

TAREA:
Genera 3 captions TOTALMENTE DIFERENTES en tono y estrategia.
Cada uno DEBE ser ≤ ${maxChars} caracteres (incluyendo hashtags).

VARIANTE 1 - HUMOR
Tono: Divertido, relatable, rompe tensión
Objetivo: Maximizar shares y risas
Incluye: Humor light, emoji máx 2

VARIANTE 2 - EMOTIVO  
Tono: Vulnerable, conexión profunda
Objetivo: Maximizar saves y comentarios emocionales
Incluye: Historia personal o universal, sin exagerar

VARIANTE 3 - DIRECTO (CTA)
Tono: Urgente, accionable, conversión
Objetivo: Clickthrough, visitas, conversión
Incluye: Verbo de acción claro (descubre, mira, únete, etc)

RESTRICCIONES:
- NUNCA superes ${maxChars} caracteres por caption
- Integra hashtags naturalmente (3-5 mínimo)
- Emojis: máx 3 por caption, relevantes
- Lenguaje: español, informal pero cuidado

RESPONDE SOLO CON JSON VÁLIDO (sin markdown):
{
  "variants": [
    {
      "id": "humor",
      "caption": "...",
      "char_count": 0,
      "engagement_hook": "Por qué los fans van a reaccionar"
    },
    {
      "id": "emotivo",
      "caption": "...",
      "char_count": 0,
      "engagement_hook": "Por qué los fans van a comentar/guardar"
    },
    {
      "id": "directo",
      "caption": "...",
      "char_count": 0,
      "engagement_hook": "Por qué los fans van a hacer clic"
    }
  ],
  "recommended_variant": "humor|emotivo|directo",
  "recommendation_reason": "2-3 oraciones explicando por qué"
}`;

  try {
    console.log(`[generateABVariants] Calling Claude API...`);
    const aiResponse = await _callClaude(prompt);

    // 5. VALIDAR JSON
    let result;
    try {
      result = typeof aiResponse === 'string'
        ? JSON.parse(aiResponse)
        : aiResponse;
    } catch (parseErr) {
      console.error(`[generateABVariants] Invalid JSON from Claude:`, aiResponse?.substring?.(0, 200));
      throw new Error('Claude devolvió JSON inválido');
    }

    // 6. VALIDAR ESTRUCTURA
    if (!result.variants || !Array.isArray(result.variants) || result.variants.length !== 3) {
      throw new Error(`Expected 3 variants, got ${result.variants?.length}`);
    }

    // 7. VALIDAR CADA CAPTION
    const validatedVariants = result.variants.map((v, idx) => {
      const charCount = v.caption?.length || 0;

      if (charCount > maxChars) {
        console.warn(
          `[generateABVariants] ⚠️ Variant "${v.id}" exceeds limit: ${charCount}/${maxChars}`
        );
        // Truncar si es necesario (último recurso)
        return {
          ...v,
          caption: v.caption.substring(0, maxChars).trim(),
          char_count: v.caption.substring(0, maxChars).trim().length,
          was_truncated: true,
        };
      }

      return {
        ...v,
        char_count: charCount,
        was_truncated: false,
      };
    });

    const finalResult = {
      video_id: videoId,
      platform: primaryPlatform,
      variants: validatedVariants.map((v) => ({
        id: v.id,
        caption: v.caption,
        char_count: v.char_count,
        engagement_hook: v.engagement_hook,
      })),
      recommended_variant: result.recommended_variant,
      recommendation_reason: result.recommendation_reason,
      is_complete: false,
      created_at: new Date().toISOString(),
      ai_model: 'claude-sonnet-4-6',
    };

    console.log(`[generateABVariants] ✅ Generated 3 variants:
      - Humor: ${validatedVariants[0].char_count}/${maxChars} chars
      - Emotivo: ${validatedVariants[1].char_count}/${maxChars} chars
      - Directo: ${validatedVariants[2].char_count}/${maxChars} chars
      Recommended: ${result.recommended_variant}`);

    // 8. GUARDAR EN BD
    const { error: upsertError } = await supabase
      .from('ab_tests')
      .upsert(finalResult, { onConflict: 'video_id' });

    if (upsertError) {
      console.error(`[generateABVariants] Upsert failed:`, upsertError.message);
      // Lanzar error pero devolver resultado (para que no se pierda en memoria)
      console.warn(`[generateABVariants] Variants generadas pero no guardadas en BD`);
    } else {
      console.log(`[generateABVariants] ✅ Saved to ab_tests table`);
    }

    return finalResult;

  } catch (err) {
    console.error(`[generateABVariants] AI generation failed:`, err.message);

    // 9. FALLBACK INTELIGENTE (no es basura)
    console.log(`[generateABVariants] Using intelligent fallback...`);

    const fallbackVariants = _generateFallbackVariants(
      baseText,
      hashtags,
      primaryPlatform,
      maxChars
    );

    const fallbackResult = {
      video_id: videoId,
      platform: primaryPlatform,
      variants: fallbackVariants,
      recommended_variant: 'humor',
      recommendation_reason: 'Fallback activado por error en Claude. Prueba la variante Humor primero; tiene mejor track record de engagement inicial.',
      is_complete: false,
      created_at: new Date().toISOString(),
      ai_model: 'fallback',
      error: err.message,
    };

    // Intentar guardar fallback
    await supabase
      .from('ab_tests')
      .upsert(fallbackResult, { onConflict: 'video_id' })
      .catch((e) => console.warn(`[generateABVariants] Fallback upsert failed:`, e.message));

    return fallbackResult;
  }
};

// HELPER: Fallback inteligente (no emojis básicos)
function _generateFallbackVariants(baseText, hashtags, platform, maxChars) {
  const templates = {
    humor: {
      formats: [
        `Nadie: \nYo: ${baseText.toLowerCase()} 😂\n${hashtags}`,
        `Después de escuchar esto estoy: ${baseText}... SÍ o SÍ. 😄\n${hashtags}`,
        `Mi mamá me dice que deje la música.\nMi canción: ${baseText} 🎵\n${hashtags}`,
      ],
      description: 'Tono divertido - tiende a generar shares',
    },
    emotivo: {
      formats: [
        `"${baseText}"\n\nDedicada a todos los que me apoyaron en los peores momentos. 💙\n${hashtags}`,
        `La canción que necesitaba escuchar cuando más la necesitaba: ${baseText}\n${hashtags}`,
        `Este tema salió del alma. ${baseText} ✨\n${hashtags}`,
      ],
      description: 'Tono emocional - tiende a generar comments y saves',
    },
    directo: {
      formats: [
        `${baseText} 🔥\n\nEscúchalo completo en el link de bio → \n${hashtags}`,
        `NUEVO: ${baseText}\n\nYa disponible en Spotify & Apple Music\n${hashtags}`,
        `${baseText}\n\nHaz clic → [LINK EN BIO] para descubrirlo completo\n${hashtags}`,
      ],
      description: 'Call-to-action claro - tiende a generar clickthrough',
    },
  };

  return Object.entries(templates).map(([id, { formats, description }]) => {
    let caption = formats[Math.floor(Math.random() * formats.length)];

    // Asegurar que no exceda límite
    if (caption.length > maxChars) {
      caption = caption.substring(0, maxChars - 3).trim() + '...';
    }

    return {
      id,
      caption,
      char_count: caption.length,
      engagement_hook: description,
    };
  });
}

exports.getABResult = async (videoId) => {
  console.log(`[growthService.getABResult] videoId=${videoId}`);
  const { data, error } = await supabase
    .from('ab_tests')
    .select('*')
    .eq('video_id', videoId)
    .single();

  console.log(`[growthService.getABResult] query → encontrado=${!!data} error=${JSON.stringify(error)}`);
  if (!data) throw new Error('No hay A/B test para este video');

  return {
    video_id: videoId,
    variants: data.variants || [],
    winner_id: data.winner_id || null,
    is_complete: data.is_complete || false,
    recommendation: data.recommendation || null,
  };
};

// ─── Ad Copy ──────────────────────────────────────────────────────────────────

exports.generateAdCopy = async (videoId) => {
  console.log(`[growthService.generateAdCopy] videoId=${videoId}`);
  const { data: video, error } = await supabase
    .from('videos')
    .select('id, title, ai_copy_short, viral_score')
    .eq('id', videoId)
    .single();
  console.log(`[growthService.generateAdCopy] video query → title="${video?.title}" error=${JSON.stringify(error)}`);
  if (error || !video) throw new Error('Video no encontrado');

  const baseText = video.ai_copy_short || video.title || 'Nuevo video';
  console.log(`[growthService.generateAdCopy] baseText="${baseText.substring(0, 80)}"`);

  const prompt = `Eres un experto en paid advertising para artistas musicales.
Crea ad copy para 2 plataformas basado en:
- Copy orgánico: ${baseText}
- Título: ${video.title || 'sin título'}

Responde SOLO con JSON array (2 items):
[
  {
    "platform": "meta",
    "headline": "Headline impactante (máx 40 chars)",
    "primary_text": "Texto principal persuasivo (máx 125 chars)",
    "cta": "Botón CTA (máx 20 chars)"
  },
  {
    "platform": "tiktok",
    "headline": "Hook para TikTok Ads (máx 35 chars)",
    "primary_text": "Descripción atractiva (máx 100 chars)",
    "cta": "CTA de TikTok (máx 20 chars)"
  }
]`;

  try {
    const result = await _callClaude(prompt);
    console.log(`[growthService.generateAdCopy] AI OK plataformas=${result?.length}`);
    return result;
  } catch (err) {
    console.error(`[growthService.generateAdCopy] AI falló, usando fallback:`, err.message);
    return [
      { platform: 'meta', headline: `${(video.title || 'Nuevo video').substring(0, 35)}`, primary_text: baseText.substring(0, 120), cta: 'Ver ahora' },
      { platform: 'tiktok', headline: `${(video.title || 'Nuevo video').substring(0, 30)}`, primary_text: baseText.substring(0, 95), cta: 'Seguir' },
    ];
  }
};
