/**
 * Hashtags baneados o suprimidos por TikTok/Instagram.
 * Usar estos hashtags reduce el alcance o puede causar shadowban.
 * Fuente: reportes de la comunidad + TikTok Creator Portal.
 * Actualizar periódicamente.
 */

const BANNED_HASHTAGS = new Set([
  // ── TikTok: contenido sexual/sugestivo ──
  '#sensualdance', '#sensual', '#sensualdancing',
  '#twerking', '#twerkdance', '#booty', '#bootydance',
  '#hotgirl', '#hotgirls', '#sexydance', '#sexyback',
  '#thot', '#thotiana', '#onlyfans', '#linkinbio',
  '#foryoupage18', '#adult', '#adultcontent', '#nsfw',
  '#porn', '#xxx', '#nude', '#nudes', '#naked',
  '#sugardaddy', '#sugarbaby', '#escort',
  '#sextok', '#spicytok', '#spicyaccountant',

  // ── TikTok: violencia / contenido peligroso ──
  '#gore', '#death', '#suicide', '#selfharm',
  '#cutting', '#anorexia', '#bulimia', '#proana',
  '#promia', '#thinspo', '#skinny',
  '#drugdealer', '#drugs', '#weed420',

  // ── TikTok: engagement bait / spam ──
  '#followforfollow', '#fff', '#f4f', '#follow4follow',
  '#likeforlike', '#lfl', '#l4l', '#like4like',
  '#followme', '#followback', '#teamfollowback',
  '#instalike', '#instadaily', '#instagood',
  '#gainwithxtina', '#gaintrick', '#gaintrain',
  '#spam4spam', '#s4s', '#shoutoutforshoutout',

  // ── Instagram: suprimidos / shadowban conocidos ──
  '#beautyblogger', '#costumes', '#elevator',
  '#girlsnight', '#happythanksgiving', '#humpday',
  '#icy', '#instamood', '#killingit', '#kissing',
  '#master', '#milf', '#nasty', '#newyearsday',
  '#prettygirl', '#pushups', '#rate', '#saltlife',
  '#single', '#singlelife', '#skateboarding',
  '#snap', '#snapchat', '#snowstorm', '#sopretty',
  '#stranger', '#stud', '#sunbathing', '#swole',
  '#tag4like', '#teens', '#thought', '#todayimwearing',
  '#underage', '#valentinesday', '#woman', '#womancrushwednesday',

  // ── Ambas plataformas: odio / discriminación ──
  '#hate', '#racism', '#nazi', '#whitepower',
  '#alllivesmatter', '#bluelivesmatter',

  // ── Ambas: desinformación / conspiración ──
  '#flatearth', '#antivax', '#plandemic',
  '#qanon', '#wwg1wga',
]);

const RISKY_HASHTAGS = new Set([
  '#viral', '#foryou', '#fyp', '#foryoupage', '#parati',
  '#xyzbca', '#trending', '#explorepage', '#explore',
  '#viralvideo', '#goviral', '#blowthisup',
  '#tiktokviral', '#tiktokfamous',
]);

const RISKY_REASON = 'Hashtags genéricos de alcance (#viral, #fyp, #parati) están saturados y TikTok/Instagram los ignoran. Usá hashtags de nicho específicos de tu contenido.';

function checkHashtags(hashtagString) {
  if (!hashtagString) return { safe: true, banned: [], risky: [], warnings: [] };

  const tags = hashtagString.match(/#[\wÀ-ɏ]+/gi) || [];
  const banned = [];
  const risky = [];
  const warnings = [];

  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (BANNED_HASHTAGS.has(lower)) {
      banned.push(lower);
    } else if (RISKY_HASHTAGS.has(lower)) {
      risky.push(lower);
    }
  }

  if (banned.length > 0) {
    warnings.push(`ELIMINADOS: ${banned.join(', ')} — estos hashtags están baneados/suprimidos y reducen tu alcance o causan shadowban.`);
  }
  if (risky.length > 0) {
    warnings.push(`ADVERTENCIA: ${risky.join(', ')} — ${RISKY_REASON}`);
  }

  return {
    safe: banned.length === 0,
    banned,
    risky,
    warnings,
    cleanHashtags: banned.length > 0
      ? tags.filter(t => !BANNED_HASHTAGS.has(t.toLowerCase())).join(' ')
      : hashtagString,
  };
}

module.exports = { BANNED_HASHTAGS, RISKY_HASHTAGS, checkHashtags };
