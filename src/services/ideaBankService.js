const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./loggerService');
const trendService = require('./trendService');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

let anthropic = null;
function getAnthropic() {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurado');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// ============================================================
// GENERATE 5 DAILY IDEAS
// ============================================================
async function generateDailyIdeas(artistId, count = 5) {
  const [styleProfile, preferences, trends, recentHooks] = await Promise.all([
    getStyleProfile(artistId),
    getRecentPreferences(artistId, 50),
    trendService.fetchAllTrends(artistId),
    getRecentlyGeneratedHooks(artistId, 20)
  ]);

  const likedPatterns = preferences.filter(p => p.action === 'like').map(p => p.hook || '');
  const dislikedPatterns = preferences.filter(p => p.action === 'dislike').map(p => p.hook || '');
  const trendSummary = trends.slice(0, 8).map(t => `[${t.platform}] ${t.topic}`).join('\n');
  const recentHooksSummary = recentHooks.slice(0, 15).join('\n') || 'Sin ideas previas';

  const prompt = `Eres un estratega de contenido viral para redes sociales. Genera exactamente ${count} ideas de contenido para un creador.

PERFIL DEL CREADOR:
- Tono: ${styleProfile?.tone || 'energético y directo'}
- Temas que le funcionan: ${(styleProfile?.common_themes || []).join(', ') || 'general'}
- Formatos preferidos: ${(styleProfile?.preferred_formats || []).join(', ') || 'reel, video corto'}
- Patrones de hooks exitosos: ${(styleProfile?.hook_patterns || []).map(h => h.pattern || h).join(', ') || 'preguntas, datos impactantes'}

TENDENCIAS ACTUALES:
${trendSummary || 'No hay tendencias disponibles, genera ideas evergreen'}

LO QUE LE GUSTA (ideas previas que guardó):
${likedPatterns.slice(0, 5).join('\n') || 'Sin historial aún'}

LO QUE NO LE GUSTA (ideas que descartó):
${dislikedPatterns.slice(0, 5).join('\n') || 'Sin historial aún'}

IDEAS YA GENERADAS RECIENTEMENTE PARA ESTE CREADOR (no las repitas ni generes ángulos muy similares):
${recentHooksSummary}

REGLAS:
1. Cada idea debe ser DIFERENTE en formato y ángulo
2. Los hooks deben generar curiosidad instantánea
3. Incluye variedad: educativo, entretenimiento, opinión, tutorial, storytime
4. Adapta al tono del creador
5. Si hay tendencias, úsalas como inspiración (no copies literalmente)
6. No repitas ninguna de las ideas ya generadas listadas arriba

Responde ÚNICAMENTE con un JSON array. Sin texto adicional antes o después:
[
  {
    "hook": "gancho de 1-2 líneas que detiene el scroll",
    "bullets": ["punto 1 del contenido", "punto 2", "punto 3"],
    "cta": "call to action final",
    "category": "tema/categoría",
    "trend_source": "de dónde viene la inspiración o null",
    "trend_platform": "reddit|youtube|tiktok|instagram|original"
  }
]`;

  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = msg.content[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');

    const ideas = JSON.parse(jsonMatch[0]);

    const rows = ideas.slice(0, count).map(idea => ({
      artist_id: artistId,
      hook: idea.hook,
      bullets: idea.bullets || [],
      cta: idea.cta || '',
      category: idea.category || 'general',
      trend_source: idea.trend_source || null,
      trend_platform: idea.trend_platform || 'original',
      status: 'pending'
    }));

    const { data, error } = await supabase
      .from('idea_bank')
      .insert(rows)
      .select();

    if (error) throw error;
    logger.log('success', 'IDEAS_GENERATED', { artistId, count: data.length });
    return data;
  } catch (err) {
    logger.log('error', 'IDEAS_GENERATION_FAILED', { artistId, error: err.message });
    throw err;
  }
}

// ============================================================
// EXPAND IDEA TO FULL SCRIPT
// ============================================================
async function expandToScript(ideaId, artistId) {
  const { data: idea, error } = await supabase
    .from('idea_bank')
    .select('*')
    .eq('id', ideaId)
    .eq('artist_id', artistId)
    .single();

  if (error || !idea) throw new Error('Idea no encontrada');
  if (idea.script) return idea;

  const styleProfile = await getStyleProfile(artistId);

  const prompt = `Eres un guionista de contenido viral. Expande esta idea en un guión completo listo para grabar.

IDEA:
- Hook: "${idea.hook}"
- Puntos: ${(idea.bullets || []).join(', ')}
- CTA: "${idea.cta || ''}"
- Categoría: ${idea.category}

ESTILO DEL CREADOR:
- Tono: ${styleProfile?.tone || 'energético y directo'}
- Formato: video corto (60-90 segundos)

Genera un guión con estas secciones:
1. HOOK (segundos 0-3): Cómo abrir para detener el scroll
2. DESARROLLO (segundos 3-45): Contenido principal, escena por escena
3. CTA & CIERRE (segundos 45-60): Cierre con llamada a la acción

Responde ÚNICAMENTE con JSON:
{
  "hook_script": "texto del hook para decir a cámara",
  "development": "desarrollo completo escena por escena",
  "cta_script": "cierre y call to action",
  "suggested_hashtags": ["hashtag1", "hashtag2", "hashtag3"],
  "estimated_duration": "60-90s",
  "format_tips": "tips de grabación/edición"
}`;

  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = msg.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const scriptData = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');

    const fullScript = `🎣 HOOK (0-3s)\n${scriptData.hook_script}\n\n📖 DESARROLLO (3-45s)\n${scriptData.development}\n\n🎯 CTA & CIERRE (45-60s)\n${scriptData.cta_script}\n\n#️⃣ Hashtags: ${(scriptData.suggested_hashtags || []).map(h => `#${h.replace('#', '')}`).join(' ')}\n\n💡 Tips: ${scriptData.format_tips || ''}`;

    const { data: updated } = await supabase
      .from('idea_bank')
      .update({ script: fullScript })
      .eq('id', ideaId)
      .select()
      .single();

    return updated || { ...idea, script: fullScript };
  } catch (err) {
    logger.log('error', 'SCRIPT_EXPAND_FAILED', { ideaId, error: err.message });
    throw err;
  }
}

// ============================================================
// ANALYZE ARTIST STYLE
// ============================================================
async function analyzeArtistStyle(artistId) {
  const { data: videos } = await supabase
    .from('videos')
    .select('title, ai_copy_long, hashtags, viral_score, status, post_type')
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (!videos || videos.length < 3) {
    return { message: 'Se necesitan al menos 3 videos para analizar tu estilo' };
  }

  const videosText = videos.map((v, i) =>
    `Video ${i + 1}: "${v.title || 'Sin título'}" | Copy: "${(v.ai_copy_long || '').substring(0, 100)}" | Hashtags: ${v.hashtags || 'ninguno'} | Score: ${v.viral_score || 'N/A'} | Tipo: ${v.post_type || 'reel'}`
  ).join('\n');

  const prompt = `Analiza el estilo de contenido de este creador basándote en sus últimos videos:

${videosText}

Responde ÚNICAMENTE con JSON:
{
  "tone": "descripción del tono en 2-3 palabras",
  "hook_patterns": [{"pattern": "patrón de hook", "effectiveness": 78}],
  "common_themes": [{"theme": "tema", "count": 5, "avg_score": 4.2}],
  "preferred_formats": ["reel", "feed"],
  "audience_keywords": ["palabra1", "palabra2"],
  "best_posting_times": {"best_day": "martes", "best_hour": "18:00"},
  "avg_engagement_rate": 4.5,
  "summary": "resumen de 1 línea del estilo"
}`;

  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = msg.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const style = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');

    const { data: upserted } = await supabase
      .from('artist_style_profile')
      .upsert({
        artist_id: artistId,
        tone: style.tone || 'general',
        hook_patterns: style.hook_patterns || [],
        common_themes: style.common_themes || [],
        preferred_formats: style.preferred_formats || ['reel'],
        audience_keywords: style.audience_keywords || [],
        best_posting_times: style.best_posting_times || {},
        avg_engagement_rate: style.avg_engagement_rate || 0,
        total_posts_analyzed: videos.length,
        updated_at: new Date().toISOString()
      }, { onConflict: 'artist_id' })
      .select()
      .single();

    return upserted || style;
  } catch (err) {
    logger.log('error', 'STYLE_ANALYSIS_FAILED', { artistId, error: err.message });
    throw err;
  }
}

// ============================================================
// CRUD OPERATIONS
// ============================================================
async function getTodayIdeas(artistId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('idea_bank')
    .select('*')
    .eq('artist_id', artistId)
    .gte('created_at', today.toISOString())
    .order('created_at', { ascending: false });

  return data || [];
}

async function getSavedIdeas(artistId, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const { data, error, count } = await supabase
    .from('idea_bank')
    .select('*', { count: 'exact' })
    .eq('artist_id', artistId)
    .in('status', ['liked', 'saved'])
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return { ideas: data || [], total: count || 0, page, limit };
}

async function swipeIdea(ideaId, artistId, action) {
  const statusMap = { like: 'liked', dislike: 'disliked', save: 'saved' };

  await supabase.from('idea_preferences').insert({
    artist_id: artistId,
    idea_id: ideaId,
    action
  });

  const { data } = await supabase
    .from('idea_bank')
    .update({
      status: statusMap[action] || action,
      is_favorite: action === 'save'
    })
    .eq('id', ideaId)
    .eq('artist_id', artistId)
    .select()
    .single();

  return data;
}

async function rateIdea(ideaId, artistId, rating) {
  const { data } = await supabase
    .from('idea_bank')
    .update({ rating: Math.min(5, Math.max(1, rating)) })
    .eq('id', ideaId)
    .eq('artist_id', artistId)
    .select()
    .single();
  return data;
}

async function getStyleProfile(artistId) {
  const { data } = await supabase
    .from('artist_style_profile')
    .select('*')
    .eq('artist_id', artistId)
    .single();
  return data;
}

async function getRecentlyGeneratedHooks(artistId, limit = 20) {
  const { data } = await supabase
    .from('idea_bank')
    .select('hook')
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return (data || []).map(r => r.hook).filter(Boolean);
}

async function getRecentPreferences(artistId, limit = 50) {
  const { data } = await supabase
    .from('idea_preferences')
    .select('action, idea_bank(hook)')
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return (data || []).map(p => ({
    action: p.action,
    hook: p.idea_bank?.hook || ''
  }));
}

module.exports = {
  generateDailyIdeas,
  expandToScript,
  analyzeArtistStyle,
  getTodayIdeas,
  getSavedIdeas,
  swipeIdea,
  rateIdea,
  getStyleProfile
};
