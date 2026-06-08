/**
 * Analytics Service - Vidalis.AI
 *
 * Servicio de analíticas real usando datos desde Supabase
 * Obtiene métricas agregadas de post_metrics_snapshots
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('./loggerService');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'placeholder'
);

/**
 * Obtener estadísticas agregadas de un artista
 * @param {string} artistId - ID del artista
 * @param {string} agencyId - ID de la agencia (para validación)
 */
exports.getArtistStats = async (artistId, agencyId) => {
  try {
    logger.log('info', 'GET_ARTIST_STATS', { artistId, agencyId });

    // Obtener videos del artista
    const { data: videos, error: videoError } = await supabase
      .from('videos')
      .select('viral_score_real, platforms, analytics_4h, created_at')
      .eq('artist_id', artistId)
      .is('deleted_at', null);

    if (videoError) {
      logger.log('error', 'GET_VIDEOS_FAILED', { artistId, error: videoError.message });
      videos = [];
    }

    // Obtener snapshots de métricas
    const { data: snapshots, error: snapshotsError } = await supabase
      .from('post_metrics_snapshots')
      .select('views, likes, comments, shares, saves, reach, impressions, platform, snapshot_at')
      .eq('artist_id', artistId);

    if (snapshotsError) {
      logger.log('warn', 'GET_SNAPSHOTS_FAILED', { artistId, error: snapshotsError.message });
    }

    // Calcular agregaciones
    const totalViews = (snapshots || []).reduce((sum, s) => sum + (s.views || 0), 0);
    const totalLikes = (snapshots || []).reduce((sum, s) => sum + (s.likes || 0), 0);
    const totalComments = (snapshots || []).reduce((sum, s) => sum + (s.comments || 0), 0);
    const totalShares = (snapshots || []).reduce((sum, s) => sum + (s.shares || 0), 0);
    const totalSaves = (snapshots || []).reduce((sum, s) => sum + (s.saves || 0), 0);

    const publishedVideos = (videos || []).length;
    const avgViralScore =
      publishedVideos > 0
        ? (videos || []).reduce((sum, v) => sum + (v.viral_score_real || 0), 0) / publishedVideos
        : 0;

    // Desglose por plataforma
    const platformBreakdown = {};
    (snapshots || []).forEach((s) => {
      const platform = s.platform || 'unknown';
      platformBreakdown[platform] = (platformBreakdown[platform] || 0) + (s.views || 0);
    });

    // Crecimiento (últimos 30 días)
    const growthData = calculateGrowthData(snapshots || []);
    const viewsGrowth = calculateGrowthRate(growthData);

    const stats = {
      totalFollowers: 0,
      followersGrowth: 0,
      totalViews,
      viewsGrowth,
      totalLikes,
      totalComments,
      totalShares,
      totalSaves,
      publishedVideos,
      avgViralScore: parseFloat(avgViralScore.toFixed(2)),
      platformBreakdown,
      lastUpdated: new Date().toISOString(),
    };

    logger.log('success', 'GET_ARTIST_STATS_SUCCESS', { artistId, stats });
    return stats;
  } catch (err) {
    logger.log('error', 'GET_ARTIST_STATS_ERROR', { artistId, error: err.message });
    throw err;
  }
};

/**
 * Obtener analíticas de un video específico
 * @param {string} videoId - ID del video
 */
exports.getVideoAnalytics = async (videoId) => {
  try {
    logger.log('info', 'GET_VIDEO_ANALYTICS', { videoId });

    // Obtener video
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select('*')
      .eq('id', videoId)
      .single();

    if (videoError || !video) {
      logger.log('error', 'VIDEO_NOT_FOUND', { videoId });
      throw new Error(`Video ${videoId} not found`);
    }

    // Obtener snapshots
    const { data: snapshots, error: snapshotsError } = await supabase
      .from('post_metrics_snapshots')
      .select('*')
      .eq('video_id', videoId)
      .order('snapshot_at', { ascending: false })
      .limit(30);

    if (snapshotsError) {
      logger.log('warn', 'GET_SNAPSHOTS_FAILED', { videoId, error: snapshotsError.message });
    }

    // Extraer últimas métricas
    const analytics4h = video.analytics_4h || {};
    const totalViews = analytics4h.views || 0;
    const totalLikes = analytics4h.likes || 0;
    const totalComments = analytics4h.comments || 0;
    const totalShares = analytics4h.shares || 0;
    const totalSaves = analytics4h.saves || 0;
    const totalReach = analytics4h.reach || 0;
    const totalImpressions = analytics4h.impressions || 0;
    const engagementRate = analytics4h.engagement_rate || 0;

    // Desglose por plataforma
    const platformBreakdown = {};
    (snapshots || []).forEach((s) => {
      const platform = s.platform || 'unknown';
      platformBreakdown[platform] = (platformBreakdown[platform] || 0) + (s.views || 0);
    });

    // Historial
    const history = (snapshots || []).map((s) => ({
      snapshot_at: s.snapshot_at,
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      shares: s.shares,
      saves: s.saves,
    }));

    const analytics = {
      id: videoId,
      views: totalViews,
      likes: totalLikes,
      comments: totalComments,
      shares: totalShares,
      saves: totalSaves,
      reach: totalReach,
      impressions: totalImpressions,
      engagementRate: parseFloat(engagementRate.toFixed(2)),
      viralScore: video.viral_score_real || 0,
      history,
      platformBreakdown,
      publishedAt: video.published_at,
      updatedAt: video.updated_at,
    };

    logger.log('success', 'GET_VIDEO_ANALYTICS_SUCCESS', { videoId });
    return analytics;
  } catch (err) {
    logger.log('error', 'GET_VIDEO_ANALYTICS_ERROR', { videoId, error: err.message });
    throw err;
  }
};

/**
 * Helper: calcular crecimiento desde snapshots
 */
function calculateGrowthData(snapshots) {
  const grouped = {};

  snapshots.forEach((s) => {
    const date = new Date(s.snapshot_at).toISOString().split('T')[0];
    if (!grouped[date]) {
      grouped[date] = { views: 0 };
    }
    grouped[date].views += s.views || 0;
  });

  return Object.entries(grouped)
    .map(([date, data]) => ({ date, views: data.views }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Helper: calcular tasa de crecimiento
 */
function calculateGrowthRate(growthData) {
  if (growthData.length < 2) return 0;

  const first = growthData[0].views;
  const last = growthData[growthData.length - 1].views;

  if (first === 0) return 0;
  return parseFloat((((last - first) / first) * 100).toFixed(2));
}

module.exports = {
  getArtistStats,
  getVideoAnalytics,
};
