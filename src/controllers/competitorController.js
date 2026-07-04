const { createClient } = require('@supabase/supabase-js');
const competitorService = require('../services/competitorService');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

const ANALYSIS_COST = 50;

async function verifyCompetitorOwnership(competitorId, userId) {
  const { data: comp } = await supabase
    .from('competitors')
    .select('id, artist_id, artists(agency_id)')
    .eq('id', competitorId)
    .single();

  if (!comp) return null;
  if (comp.artists?.agency_id !== userId && comp.artist_id !== userId) return null;
  return comp;
}

// ── Add a competitor ─────────────────────────────────────────────────────────

exports.addCompetitor = async (req, res) => {
  try {
    const { artistId } = req.params;
    const userId = req.user?.id || req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const { data: art } = await supabase.from('artists').select('agency_id').eq('id', artistId).single();
    if (!art || art.agency_id !== userId) return res.status(403).json({ error: 'No tienes permisos para este artista' });

    const { name, tiktok_username, youtube_username, instagram_username, facebook_username } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Se requiere un nombre para el competidor' });

    const hasUsername = tiktok_username || youtube_username || instagram_username || facebook_username;
    if (!hasUsername) return res.status(400).json({ error: 'Se requiere al menos un username de red social' });

    const { count } = await supabase
      .from('competitors')
      .select('id', { count: 'exact', head: true })
      .eq('artist_id', artistId);

    if (count >= 10) return res.status(400).json({ error: 'Máximo 10 competidores por artista' });

    const { data, error } = await supabase
      .from('competitors')
      .insert({
        artist_id: artistId,
        name: name.trim(),
        tiktok_username: tiktok_username?.replace('@', '').trim() || null,
        youtube_username: youtube_username?.replace('@', '').trim() || null,
        instagram_username: instagram_username?.replace('@', '').trim() || null,
        facebook_username: facebook_username?.replace('@', '').trim() || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── List competitors ─────────────────────────────────────────────────────────

exports.getCompetitors = async (req, res) => {
  try {
    const { artistId } = req.params;
    const userId = req.user?.id || req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const { data: art } = await supabase.from('artists').select('agency_id').eq('id', artistId).single();
    if (!art || art.agency_id !== userId) return res.status(403).json({ error: 'No tienes permisos para este artista' });

    const { data, error } = await supabase
      .from('competitors')
      .select('*')
      .eq('artist_id', artistId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── Delete a competitor ──────────────────────────────────────────────────────

exports.deleteCompetitor = async (req, res) => {
  try {
    const { competitorId } = req.params;
    const userId = req.user?.id || req.user?.userId;

    const comp = await verifyCompetitorOwnership(competitorId, userId);
    if (!comp) return res.status(403).json({ error: 'No tienes permisos para este competidor' });

    const { error } = await supabase
      .from('competitors')
      .delete()
      .eq('id', competitorId);

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── Update competitor usernames ──────────────────────────────────────────────

exports.updateCompetitor = async (req, res) => {
  try {
    const { competitorId } = req.params;
    const userId = req.user?.id || req.user?.userId;

    const comp = await verifyCompetitorOwnership(competitorId, userId);
    if (!comp) return res.status(403).json({ error: 'No tienes permisos para este competidor' });

    const { name, tiktok_username, youtube_username, instagram_username, facebook_username } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (tiktok_username !== undefined) updates.tiktok_username = tiktok_username?.replace('@', '').trim() || null;
    if (youtube_username !== undefined) updates.youtube_username = youtube_username?.replace('@', '').trim() || null;
    if (instagram_username !== undefined) updates.instagram_username = instagram_username?.replace('@', '').trim() || null;
    if (facebook_username !== undefined) updates.facebook_username = facebook_username?.replace('@', '').trim() || null;

    const { data, error } = await supabase
      .from('competitors')
      .update(updates)
      .eq('id', competitorId)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── Analyze competitor (costs 20 Sparks) ─────────────────────────────────────

exports.analyzeCompetitor = async (req, res) => {
  try {
    const { competitorId } = req.params;
    const userId = req.user?.id || req.user?.userId;

    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    // 1. Get competitor first to find artist → agency
    const { data: competitor, error: compErr } = await supabase
      .from('competitors')
      .select('*')
      .eq('id', competitorId)
      .single();

    if (compErr || !competitor) return res.status(404).json({ error: 'Competidor no encontrado' });

    const artistId = competitor.artist_id;

    // Verify ownership
    const { data: ownerCheck } = await supabase
      .from('artists')
      .select('agency_id')
      .eq('id', artistId)
      .single();

    if (ownerCheck?.agency_id !== userId) return res.status(403).json({ error: 'No tienes permisos para este competidor' });

    // 2. Get agency sparks balance via artist
    const { data: artistRow } = await supabase
      .from('artists')
      .select('agencies(id, sparks_balance)')
      .eq('id', artistId)
      .single();

    const agencyId = artistRow?.agencies?.id;
    const balance = artistRow?.agencies?.sparks_balance ?? 0;

    if (balance < ANALYSIS_COST) {
      return res.status(402).json({
        error: 'Sparks insuficientes',
        required: ANALYSIS_COST,
        current: balance,
        message: `Necesitas ${ANALYSIS_COST} Sparks para analizar un competidor. Tienes ${balance}.`,
      });
    }

    // 3. Get artist's own metrics for comparison
    const { data: snapshots } = await supabase
      .from('platform_snapshots')
      .select('platform, followers, reach, likes, comments, shares, saves, views, posts_count, engagement_rate')
      .eq('artist_id', artistId)
      .order('snapshot_date', { ascending: false })
      .limit(20);

    const artistByPlatform = {};
    (snapshots || []).forEach(s => {
      if (!artistByPlatform[s.platform]) artistByPlatform[s.platform] = s;
    });

    // 4. Scrape competitor profiles (throws if microservice unavailable or empty)
    const competitorData = await competitorService.analyzeCompetitor(competitor);

    // 5. Compare
    const comparisons = competitorService.compareMetrics(artistByPlatform, competitorData);
    const actionPlan = competitorService.generateActionPlan(comparisons);

    // 6. Deduct Sparks from agency
    if (agencyId) {
      const { error: sparkErr } = await supabase
        .from('agencies')
        .update({ sparks_balance: balance - ANALYSIS_COST })
        .eq('id', agencyId);

      if (sparkErr) console.error('Error deducting sparks:', sparkErr.message);
    }

    // 7. Save snapshot
    const { error: snapErr } = await supabase
      .from('competitor_snapshots')
      .insert({
        competitor_id: competitorId,
        artist_id: artistId,
        data: competitorData,
        comparisons,
        action_plan: actionPlan,
      });

    if (snapErr) console.error('Error saving competitor snapshot:', snapErr.message);

    // 8. Respond
    res.json({
      competitor: {
        id: competitor.id,
        name: competitor.name,
        tiktok_username: competitor.tiktok_username,
        youtube_username: competitor.youtube_username,
        instagram_username: competitor.instagram_username,
      },
      platforms: competitorData,
      comparisons,
      action_plan: actionPlan,
      sparks_used: ANALYSIS_COST,
      sparks_remaining: balance - ANALYSIS_COST,
    });
  } catch (e) {
    console.error('analyzeCompetitor error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

// ── Feature B: Get weekly snapshot history for a competitor ───────────────────

exports.getCompetitorHistory = async (req, res) => {
  try {
    const { competitorId } = req.params;
    const userId = req.user?.id || req.user?.userId;

    const comp = await verifyCompetitorOwnership(competitorId, userId);
    if (!comp) return res.status(403).json({ error: 'No tienes permisos para este competidor' });

    const { data, error } = await supabase
      .from('competitor_weekly_snapshots')
      .select('*')
      .eq('competitor_id', competitorId)
      .order('snapshot_date', { ascending: false })
      .limit(12);

    if (error) throw error;

    const { data: competitor } = await supabase
      .from('competitors')
      .select('name, tiktok_username, youtube_username, instagram_username')
      .eq('id', competitorId)
      .single();

    const byPlatform = {};
    (data || []).forEach(s => {
      if (!byPlatform[s.platform]) byPlatform[s.platform] = [];
      byPlatform[s.platform].push(s);
    });

    const platforms = {};
    for (const [platform, snapshots] of Object.entries(byPlatform)) {
      snapshots.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
      const latest = snapshots[snapshots.length - 1];
      const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
      const followersGrowth = prev && prev.followers > 0
        ? parseFloat((((latest.followers - prev.followers) / prev.followers) * 100).toFixed(1))
        : 0;

      platforms[platform] = {
        snapshots: snapshots.slice(-8),
        latest: {
          followers: latest.followers,
          following: latest.following,
          likes: latest.likes,
          videos: latest.videos,
          posts: latest.posts,
          engagement_rate: latest.engagement_rate,
        },
        growth: {
          followers_growth_pct: followersGrowth,
          followers_gained: latest.followers - (prev?.followers || 0),
        },
      };
    }

    res.json({
      competitor: {
        id: competitor?.id || competitorId,
        name: competitor?.name || '',
        tiktok_username: competitor?.tiktok_username,
        youtube_username: competitor?.youtube_username,
        instagram_username: competitor?.instagram_username,
      },
      platforms,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── Feature A: Analyze competitor content (costs 30 Sparks) ───────────────────

exports.analyzeCompetitorContent = async (req, res) => {
  try {
    const { competitorId } = req.params;
    const userId = req.user?.id || req.user?.userId;
    const ANALYSIS_CONTENT_COST = 30;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const { data: competitor, error: compErr } = await supabase
      .from('competitors')
      .select('*')
      .eq('id', competitorId)
      .single();

    if (compErr || !competitor) return res.status(404).json({ error: 'Competidor no encontrado' });

    const { data: ownerCheck } = await supabase
      .from('artists')
      .select('agency_id')
      .eq('id', competitor.artist_id)
      .single();

    if (ownerCheck?.agency_id !== userId) return res.status(403).json({ error: 'No tienes permisos' });

    const { data: artistRow } = await supabase
      .from('artists')
      .select('agencies(id, sparks_balance)')
      .eq('id', competitor.artist_id)
      .single();

    const agencyId = artistRow?.agencies?.id;
    const balance = artistRow?.agencies?.sparks_balance ?? 0;

    if (balance < ANALYSIS_CONTENT_COST) {
      return res.status(402).json({
        error: 'Sparks insuficientes',
        required: ANALYSIS_CONTENT_COST,
        current: balance,
        message: `Necesitas ${ANALYSIS_CONTENT_COST} Sparks para analizar contenido. Tienes ${balance}.`,
      });
    }

    // Scrape recent posts
    const postsByPlatform = await competitorService.scrapeCompetitorPosts(competitor);
    if (!postsByPlatform) {
      return res.status(400).json({ error: 'No se pudieron obtener posts del competidor. Verifica los usernames.' });
    }

    // AI analysis with Claude
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const analyses = {};

    for (const [platform, posts] of Object.entries(postsByPlatform)) {
      if (!posts || posts.length === 0) continue;

      const totalLikes = posts.reduce((s, p) => s + (p.likes || 0), 0);
      const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
      const totalShares = posts.reduce((s, p) => s + (p.shares || 0), 0);
      const avgDuration = posts.filter(p => p.duration).length > 0
        ? posts.filter(p => p.duration).map(p => p.duration).reduce((a, b) => a + b, '')
        : null;

      const minPosts = posts.slice(0, 10).map((p, i) =>
        `Post ${i + 1}: "${(p.title || '').substring(0, 150)}" | ❤️ ${p.likes || 0} | 💬 ${p.comments || 0} | 🔁 ${p.shares || 0} | 👁 ${p.views || 0} | ⏱ ${p.duration || 'N/A'} | ${(p.hashtags || []).join(' ')}`
      ).join('\n');

      const prompt = `Analiza estos ${posts.length} posts de ${platform.toUpperCase()} de un creador de contenido y extrae patrones.

POSTS:
${minPosts}

Extrae en formato JSON (sin markdown, solo JSON):
{
  "top_topics": ["tema1", "tema2", "tema3"],
  "top_formats": ["formato1", "formato2"],
  "peak_hours": ["hora1", "hora2"],
  "peak_days": ["día1", "día2", "día3"],
  "common_hooks": ["hook1", "hook2", "hook3"],
  "top_hashtags": ["hashtag1", "hashtag2", "hashtag3"],
  "avg_duration": "duración promedio estimada",
  "emoji_most_used": ["emoji1", "emoji2"],
  "content_summary": "resumen de 1-2 líneas del tipo de contenido que publica"
}`;

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = msg.content[0]?.text || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      analyses[platform] = {
        posts_count: posts.length,
        ...analysis,
        total_likes: totalLikes,
        total_comments: totalComments,
        total_shares: totalShares,
        raw_posts: posts.slice(0, 10),
      };
    }

    // Save to DB
    const rows = Object.entries(analyses).map(([platform, analysis]) => ({
      competitor_id: competitorId,
      platform,
      posts_count: analysis.posts_count,
      top_topics: analysis.top_topics || [],
      top_formats: analysis.top_formats || [],
      peak_hours: analysis.peak_hours || [],
      peak_days: analysis.peak_days || [],
      common_hooks: analysis.common_hooks || [],
      top_hashtags: analysis.top_hashtags || [],
      avg_duration: analysis.avg_duration || null,
      raw_posts: analysis.raw_posts || [],
      ai_summary: analysis.content_summary || null,
    }));

    const { error: insertErr } = await supabase
      .from('competitor_content_analysis')
      .upsert(rows, { onConflict: 'competitor_id,platform', ignoreDuplicates: false })
      .select();

    if (insertErr) console.error('Error saving content analysis:', insertErr.message);

    // Deduct Sparks
    if (agencyId) {
      await supabase
        .from('agencies')
        .update({ sparks_balance: balance - ANALYSIS_CONTENT_COST })
        .eq('id', agencyId);
    }

    res.json({
      competitor: { id: competitor.id, name: competitor.name },
      analyses,
      sparks_used: ANALYSIS_CONTENT_COST,
      sparks_remaining: balance - ANALYSIS_CONTENT_COST,
    });
  } catch (e) {
    console.error('analyzeCompetitorContent error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

// ── Feature C: Steal ideas from competitor (costs 20 Sparks) ──────────────────

exports.stealIdeas = async (req, res) => {
  try {
    const { competitorId } = req.params;
    const userId = req.user?.id || req.user?.userId;
    const STEAL_IDEAS_COST = 20;

    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const { data: competitor, error: compErr } = await supabase
      .from('competitors')
      .select('*')
      .eq('id', competitorId)
      .single();

    if (compErr || !competitor) return res.status(404).json({ error: 'Competidor no encontrado' });

    const artistId = competitor.artist_id;

    const { data: ownerCheck } = await supabase
      .from('artists')
      .select('agency_id')
      .eq('id', artistId)
      .single();

    if (ownerCheck?.agency_id !== userId) return res.status(403).json({ error: 'No tienes permisos' });

    // Check sparks
    const { data: artistRow } = await supabase
      .from('artists')
      .select('agencies(id, sparks_balance)')
      .eq('id', artistId)
      .single();

    const agencyId = artistRow?.agencies?.id;
    const balance = artistRow?.agencies?.sparks_balance ?? 0;

    if (balance < STEAL_IDEAS_COST) {
      return res.status(402).json({
        error: 'Sparks insuficientes',
        required: STEAL_IDEAS_COST,
        current: balance,
        message: `Necesitas ${STEAL_IDEAS_COST} Sparks para generar ideas. Tienes ${balance}.`,
      });
    }

    // Get existing content analysis data
    const { data: contentAnalysis } = await supabase
      .from('competitor_content_analysis')
      .select('*')
      .eq('competitor_id', competitorId);

    const hasAnalysis = contentAnalysis && contentAnalysis.length > 0;
    let postsByPlatform = {};

    if (hasAnalysis) {
      contentAnalysis.forEach(a => {
        if (a.raw_posts) postsByPlatform[a.platform] = a.raw_posts;
      });
    }

    // If no stored analysis or empty, scrape fresh
    if (Object.keys(postsByPlatform).length === 0) {
      postsByPlatform = await competitorService.scrapeCompetitorPosts(competitor);
      if (!postsByPlatform) {
        return res.status(400).json({ error: 'No hay análisis de contenido ni se pudieron obtener posts. Ejecuta "Analizar Contenido" primero.' });
      }
    }

    // Get artist profile
    const { data: artist } = await supabase
      .from('artists')
      .select('name, ai_genre, ai_audience, ai_tone, active_platforms')
      .eq('id', artistId)
      .single();

    if (!artist) return res.status(404).json({ error: 'Artista no encontrado' });

    // Generate ideas with AI
    const ideas = await competitorService.generateStealIdeas(postsByPlatform, artist);

    // Save to idea_bank
    const savedIdeas = [];
    for (const idea of ideas.slice(0, 5)) {
      const platformsList = Object.entries(idea.platforms || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`);

      const { data: saved, error: saveErr } = await supabase
        .from('idea_bank')
        .insert({
          artist_id: artistId,
          hook: idea.hook || '',
          cta: idea.cta || '',
          category: 'competitor',
          status: 'pending',
          trend_source: idea.inspiration_source || null,
          trend_platform: 'original',
          bullets: [idea.title || '', ...platformsList],
        })
        .select()
        .single();

      if (saveErr) {
        console.error('Error saving idea:', saveErr.message);
      } else {
        savedIdeas.push(saved);
      }
    }

    // Deduct Sparks
    if (agencyId) {
      await supabase
        .from('agencies')
        .update({ sparks_balance: balance - STEAL_IDEAS_COST })
        .eq('id', agencyId);
    }

    res.json({
      competitor: { id: competitor.id, name: competitor.name },
      ideas: ideas.slice(0, 5),
      saved_to_idea_bank: savedIdeas.length,
      sparks_used: STEAL_IDEAS_COST,
      sparks_remaining: balance - STEAL_IDEAS_COST,
    });
  } catch (e) {
    console.error('stealIdeas error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

// ── Toggle competitor snapshot tracking per artist (daily, 50 sparks / 30d) ──

const SNAPSHOT_COST = 50;
const SNAPSHOT_DURATION_DAYS = 30;

exports.toggleSnapshotTracking = async (req, res) => {
  try {
    const { artistId } = req.params;
    const userId = req.user?.id || req.user?.userId;
    const { enabled, confirm } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled debe ser true o false' });
    }

    const { data: art } = await supabase
      .from('artists')
      .select('agency_id, competitor_snapshot_enabled, competitor_snapshot_expires_at')
      .eq('id', artistId)
      .single();

    if (!art || art.agency_id !== userId) {
      return res.status(403).json({ error: 'No tienes permisos para este artista' });
    }

    // Disabling is free
    if (!enabled) {
      const { error } = await supabase
        .from('artists')
        .update({ competitor_snapshot_enabled: false })
        .eq('id', artistId);

      if (error) throw error;
      return res.json({ artist_id: artistId, competitor_snapshot_enabled: false });
    }

    // Enabling: check if already active and not expired
    const now = new Date();
    const expiresAt = art.competitor_snapshot_expires_at ? new Date(art.competitor_snapshot_expires_at) : null;

    if (art.competitor_snapshot_enabled && expiresAt && expiresAt > now) {
      const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
      return res.json({
        artist_id: artistId,
        competitor_snapshot_enabled: true,
        expires_at: art.competitor_snapshot_expires_at,
        days_left: daysLeft,
        message: `El tracking ya está activo por ${daysLeft} días más.`,
      });
    }

    const { data: agency } = await supabase
      .from('agencies')
      .select('id, sparks_balance')
      .eq('id', art.agency_id)
      .single();

    const agencyId = agency?.id;
    const balance = agency?.sparks_balance ?? 0;

    // Step 1: return cost info if not confirmed
    if (confirm !== true) {
      return res.json({
        requires_confirmation: true,
        cost: SNAPSHOT_COST,
        duration_days: SNAPSHOT_DURATION_DAYS,
        balance,
        message: `Activar el tracking diario de competidores cuesta ${SNAPSHOT_COST} Sparks por ${SNAPSHOT_DURATION_DAYS} días. Tienes ${balance} Sparks.`,
        suggestion: balance < SNAPSHOT_COST ? 'Sparks insuficientes. Compra más Sparks para activar esta función.' : undefined,
      });
    }

    // Step 2: confirm — deduct sparks
    if (balance < SNAPSHOT_COST) {
      return res.status(402).json({
        error: 'Sparks insuficientes',
        required: SNAPSHOT_COST,
        current: balance,
        message: `Necesitas ${SNAPSHOT_COST} Sparks para activar el tracking diario. Tienes ${balance}.`,
      });
    }

    const newExpiresAt = new Date(now.getTime() + SNAPSHOT_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateErr } = await supabase
      .from('artists')
      .update({
        competitor_snapshot_enabled: true,
        competitor_snapshot_expires_at: newExpiresAt,
      })
      .eq('id', artistId);

    if (updateErr) throw updateErr;

    if (agencyId) {
      await supabase
        .from('agencies')
        .update({ sparks_balance: balance - SNAPSHOT_COST })
        .eq('id', agencyId);
    }

    res.json({
      artist_id: artistId,
      competitor_snapshot_enabled: true,
      expires_at: newExpiresAt,
      duration_days: SNAPSHOT_DURATION_DAYS,
      sparks_used: SNAPSHOT_COST,
      sparks_remaining: balance - SNAPSHOT_COST,
      message: `Tracking diario activado por ${SNAPSHOT_DURATION_DAYS} días.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── Get snapshot tracking status for an artist ──────────────────────────────

exports.getSnapshotStatus = async (req, res) => {
  try {
    const { artistId } = req.params;
    const userId = req.user?.id || req.user?.userId;

    const { data: art } = await supabase
      .from('artists')
      .select('competitor_snapshot_enabled, competitor_snapshot_expires_at, agency_id')
      .eq('id', artistId)
      .single();

    if (!art || art.agency_id !== userId) {
      return res.status(403).json({ error: 'No tienes permisos para este artista' });
    }

    const now = new Date();
    const expiresAt = art.competitor_snapshot_expires_at ? new Date(art.competitor_snapshot_expires_at) : null;
    const isExpired = expiresAt ? expiresAt <= now : true;
    const isActive = art.competitor_snapshot_enabled && !isExpired;
    const daysLeft = isActive && expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : 0;

    res.json({
      artist_id: artistId,
      enabled: isActive,
      expires_at: art.competitor_snapshot_expires_at,
      days_left: daysLeft,
      status: isActive ? 'active' : (art.competitor_snapshot_enabled ? 'expired' : 'inactive'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── Get last analysis for a competitor ────────────────────────────────────────

exports.getLastAnalysis = async (req, res) => {
  try {
    const { competitorId } = req.params;
    const userId = req.user?.id || req.user?.userId;

    const comp = await verifyCompetitorOwnership(competitorId, userId);
    if (!comp) return res.status(403).json({ error: 'No tienes permisos para este competidor' });

    const { data, error } = await supabase
      .from('competitor_snapshots')
      .select('*')
      .eq('competitor_id', competitorId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return res.json(null);

    const { data: competitor } = await supabase
      .from('competitors')
      .select('name, tiktok_username, youtube_username, instagram_username')
      .eq('id', competitorId)
      .single();

    res.json({
      competitor,
      platforms: data.data,
      comparisons: data.comparisons,
      action_plan: data.action_plan,
      analyzed_at: data.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
