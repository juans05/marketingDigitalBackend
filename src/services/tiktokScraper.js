const axios = require('axios');
const logger = require('./loggerService');

const MOBILE_UA = 'com.zhiliaoapp.musically/2022600040 (Linux; U; Android 12; en_US; Pixel 6; Build/SQ3A.220705.003.A1; Cronet/58.0.2991.100)';

async function getProfileStats(username) {
  if (!username) return null;
  username = username.replace('@', '').trim();

  try {
    const { data } = await axios.get(`https://tiktok.com/@${encodeURIComponent(username)}?is_copy_url=1&is_from_webapp=v1`, {
      headers: { 'User-Agent': MOBILE_UA },
      timeout: 12000,
      maxRedirects: 5
    });

    const extract = (key) => {
      const match = data.match(new RegExp(`"${key}":(\\d+)`));
      return match ? parseInt(match[1]) : 0;
    };

    const stats = {
      followers: extract('followerCount'),
      following: extract('followingCount'),
      likes: extract('heartCount') || extract('heart'),
      videos: extract('videoCount'),
    };

    if (stats.followers === 0 && stats.likes === 0 && stats.videos === 0) {
      return null;
    }

    return stats;
  } catch (err) {
    logger.log('error', 'TIKTOK_SCRAPE_FAILED', { username, error: err.message });
    return null;
  }
}

module.exports = { getProfileStats };
