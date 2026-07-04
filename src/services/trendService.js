const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./loggerService');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder'
);

// Reddit: fetch hot posts from a subreddit via RSS (JSON API blocked since 2024)
async function fetchRedditTrends(subreddit, limit = 10) {
  try {
    subreddit = subreddit.replace(/^r\//, '');
    if (!/^[A-Za-z0-9_]{1,21}$/.test(subreddit)) return [];
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/hot.rss?limit=${limit}`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'VidalisBot/1.0' },
      timeout: 10000
    });
    const entries = data.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    return entries.map(entry => {
      const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (entry.match(/<link href="([^"]*)"/) || [])[1] || '';
      const updated = (entry.match(/<updated>([^<]*)<\/updated>/) || [])[1] || '';
      const category = (entry.match(/<category[^>]*label="([^"]*)"/) || [])[1] || null;
      return {
        topic: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
        hook: title,
        source: `r/${subreddit}`,
        platform: 'reddit',
        engagement_score: 0,
        comments: 0,
        url: link,
        category,
        detected_at: updated || new Date().toISOString()
      };
    }).filter(t => t.topic && !t.topic.startsWith('r/'));
  } catch (err) {
    logger.log('error', 'REDDIT_FETCH_FAILED', { subreddit, error: err.message });
    return [];
  }
}

// YouTube: fetch trending/search videos (requires YOUTUBE_API_KEY)
async function fetchYouTubeTrends(query, regionCode = 'US', limit = 10) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    logger.log('warn', 'YOUTUBE_API_KEY_MISSING');
    return [];
  }
  try {
    const url = `https://www.googleapis.com/youtube/v3/search`;
    const params = {
      part: 'snippet',
      q: query,
      type: 'video',
      order: 'viewCount',
      regionCode,
      maxResults: limit,
      publishedAfter: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      key: apiKey
    };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    return (data?.items || []).map(item => ({
      topic: item.snippet.title,
      hook: item.snippet.title,
      source: `YouTube · ${query}`,
      platform: 'youtube',
      engagement_score: 0,
      url: `https://youtube.com/watch?v=${item.id.videoId}`,
      category: query,
      thumbnail: item.snippet.thumbnails?.medium?.url,
      channel: item.snippet.channelTitle,
      detected_at: item.snippet.publishedAt
    }));
  } catch (err) {
    logger.log('error', 'YOUTUBE_FETCH_FAILED', { query, error: err.message });
    return [];
  }
}

// Aggregate trends from all sources for an artist
async function fetchAllTrends(artistId) {
  const { data: refs } = await supabase
    .from('trend_references')
    .select('*')
    .eq('artist_id', artistId)
    .eq('is_active', true);

  const sources = refs || [];
  const allTrends = [];

  const redditSubs = sources.filter(s => s.platform === 'reddit').map(s => s.value);
  const ytQueries = sources.filter(s => s.platform === 'youtube').map(s => s.value);

  // Default sources if none configured
  const defaultReddit = ['socialmedia', 'tiktokhelp', 'contentcreation'];
  const defaultYt = ['trending reels', 'viral content'];

  const subsToFetch = redditSubs.length > 0 ? redditSubs : defaultReddit;
  const queriesToFetch = ytQueries.length > 0 ? ytQueries : defaultYt;

  // Fetch in parallel
  const redditPromises = subsToFetch.map(sub => fetchRedditTrends(sub.replace('r/', ''), 8));
  const ytPromises = queriesToFetch.map(q => fetchYouTubeTrends(q, 'US', 5));

  const results = await Promise.allSettled([...redditPromises, ...ytPromises]);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      allTrends.push(...result.value);
    }
  }

  // Sort by engagement and deduplicate by similar titles
  allTrends.sort((a, b) => (b.engagement_score || 0) - (a.engagement_score || 0));

  return allTrends.slice(0, 20);
}

// CRUD for trend references
async function addTrendReference(artistId, type, value, platform) {
  let sanitized = value.trim();
  if (platform === 'reddit') sanitized = sanitized.replace(/^r\//, '');
  if (!sanitized || sanitized.length > 100) throw new Error('Invalid reference value');
  if (platform === 'reddit' && !/^[A-Za-z0-9_]{1,21}$/.test(sanitized)) throw new Error('Nombre de subreddit inválido. Solo letras, números y guión bajo, sin espacios.');
  const { data, error } = await supabase
    .from('trend_references')
    .insert({ artist_id: artistId, type, value: sanitized, platform })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function removeTrendReference(refId, artistId) {
  const { error } = await supabase
    .from('trend_references')
    .delete()
    .eq('id', refId)
    .eq('artist_id', artistId);
  if (error) throw error;
}

async function getTrendReferences(artistId) {
  const { data, error } = await supabase
    .from('trend_references')
    .select('*')
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

module.exports = {
  fetchRedditTrends,
  fetchYouTubeTrends,
  fetchAllTrends,
  addTrendReference,
  removeTrendReference,
  getTrendReferences
};
