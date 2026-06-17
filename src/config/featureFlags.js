/**
 * Feature flags por account_type.
 * Para habilitar un feature para agencias: agregar 'agency' al array.
 * account_types válidos: 'individual', 'artist', 'agency', 'admin'
 */
const FLAGS = {
  profile_update:     ['individual', 'artist', 'admin'],
  analytics_sync:     ['individual', 'artist', 'admin'],
  smart_inbox:        ['individual', 'artist', 'admin'],
  growth_insights:    ['individual', 'artist', 'admin'],
  ab_variants:        ['individual', 'artist', 'admin'],
};

/**
 * Devuelve true si el account_type tiene acceso al feature.
 * 'admin' siempre tiene acceso a todo.
 */
function hasFeature(accountType, featureName) {
  if (accountType === 'admin') return true;
  const allowed = FLAGS[featureName];
  if (!allowed) return false;
  return allowed.includes(accountType);
}

module.exports = { FLAGS, hasFeature };
