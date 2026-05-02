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
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content[0]?.text || '';
  const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (match) return JSON.parse(match[1] || match[0]);
  return JSON.parse(text);
}

async function _getArtistVideos(artistId) {
  const { data, error } = await supabase
    .from('videos')
    .select('id, title, viral_score, created_at, platforms, hashtags, ai_copy, hook_suggestion, status')
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
  const { data: video, error } = await supabase
    .from('videos')
    .select('id, title, ai_copy, hook_suggestion, hashtags, platforms')
    .eq('id', videoId)
    .single();
  if (error || !video) throw new Error('Video no encontrado');

  const baseText = video.ai_copy || video.hook_suggestion || video.title || 'Nuevo contenido';
  const hashtags = Array.isArray(video.hashtags) ? video.hashtags.slice(0, 5).join(' ') : '';

  const prompt = `Eres un experto en copywriting para redes sociales de artistas musicales.
Genera 3 variantes de caption para este video:
- Título: ${video.title || 'sin título'}
- Copy base: ${baseText}
- Hashtags: ${hashtags}

Cada variante debe tener un ángulo diferente:
1. HUMOR — tono divertido y casual
2. EMOTIVO — conexión emocional con el fan
3. DIRECTO — CTA fuerte y conciso

Responde SOLO con JSON:
{
  "video_id": "${videoId}",
  "is_complete": false,
  "winner_id": null,
  "variants": [
    { "id": "a", "caption": "...", "likes": 0, "comments": 0, "is_winner": false },
    { "id": "b", "caption": "...", "likes": 0, "comments": 0, "is_winner": false },
    { "id": "c", "caption": "...", "likes": 0, "comments": 0, "is_winner": false }
  ]
}`;

  try {
    const result = await _callClaude(prompt);
    // Persist variants in DB for future retrieval
    await supabase.from('ab_tests').upsert({
      video_id: videoId,
      variants: result.variants,
      is_complete: false,
      created_at: new Date().toISOString(),
    }, { onConflict: 'video_id' }).catch(() => {}); // Silently fail if table doesn't exist yet
    return result;
  } catch (err) {
    // Fallback with static variants if AI fails
    return {
      video_id: videoId,
      is_complete: false,
      winner_id: null,
      variants: [
        { id: 'a', caption: `${baseText} 😂 ${hashtags}`, likes: 0, comments: 0, is_winner: false },
        { id: 'b', caption: `${baseText} ❤️ ${hashtags}`, likes: 0, comments: 0, is_winner: false },
        { id: 'c', caption: `${baseText} 🔥 ${hashtags}`, likes: 0, comments: 0, is_winner: false },
      ],
    };
  }
};

exports.getABResult = async (videoId) => {
  const { data } = await supabase
    .from('ab_tests')
    .select('*')
    .eq('video_id', videoId)
    .single();

  if (!data) throw new Error('No hay A/B test para este video');

  return {
    video_id: videoId,
    variants: data.variants || [],
    winner_id: data.winner_id || null,
    is_complete: data.is_complete || false,
  };
};

// ─── Ad Copy ──────────────────────────────────────────────────────────────────

exports.generateAdCopy = async (videoId) => {
  const { data: video, error } = await supabase
    .from('videos')
    .select('id, title, ai_copy, hook_suggestion, viral_score')
    .eq('id', videoId)
    .single();
  if (error || !video) throw new Error('Video no encontrado');

  const baseText = video.ai_copy || video.hook_suggestion || video.title || 'Nuevo video';

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
    return await _callClaude(prompt);
  } catch {
    return [
      { platform: 'meta', headline: `${(video.title || 'Nuevo video').substring(0, 35)}`, primary_text: baseText.substring(0, 120), cta: 'Ver ahora' },
      { platform: 'tiktok', headline: `${(video.title || 'Nuevo video').substring(0, 30)}`, primary_text: baseText.substring(0, 95), cta: 'Seguir' },
    ];
  }
};
