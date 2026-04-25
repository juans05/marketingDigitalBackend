const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

/**
 * Registra un evento en la base de datos de logs.
 * @param {string} level - 'info' | 'success' | 'warn' | 'error'
 * @param {string} event_type - Categoría del evento
 * @param {object} details - Información relevante (mensajes de error, IDs, etc)
 * @param {string} agency_id - (Opcional) ID de la agencia relacionada
 * @param {string} source - (Opcional) Origen del log
 */
exports.log = async (level, event_type, details = {}, agency_id = null, source = 'backend') => {
  try {
    // Sanitización básica: Nunca guardar campos sensibles si se pasan por error
    const cleanDetails = { ...details };
    delete cleanDetails.password;
    delete cleanDetails.password_hash;
    delete cleanDetails.token;
    delete cleanDetails.secret;

    const { error } = await supabase
      .from('system_logs')
      .insert([{
        level,
        event_type,
        details: cleanDetails,
        agency_id,
        source
      }]);

    if (error) console.error('❌ Error guardando log en DB:', error.message);
    
    // También enviarlo a la consola para debugging en tiempo real
    const icon = level === 'error' ? '🔴' : level === 'warn' ? '🟡' : '🟢';
    console.log(`${icon} [${event_type}] ${JSON.stringify(cleanDetails)}`);

  } catch (err) {
    console.error('⚠️ [loggerService] Falló el registro de log:', err.message);
  }
};
