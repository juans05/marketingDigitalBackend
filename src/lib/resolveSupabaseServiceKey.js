// Resuelve qué credencial de Supabase usar y lo deja visible en los logs del
// contenedor (Railway). Existe porque un desajuste de nombre entre
// SUPABASE_SERVICE_ROLE_KEY (lo que lee el código) y SUPABASE_SERVICE_KEY (lo
// que a veces se configura en el panel) hace que el cliente caiga
// silenciosamente a SUPABASE_ANON_KEY, y los inserts fallan por RLS con un
// error casi imposible de diagnosticar sin este log.
function resolveSupabaseServiceKey(label) {
  const tag = `[Supabase${label ? `:${label}` : ''}]`;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log(`🔑 ${tag} Usando SUPABASE_SERVICE_ROLE_KEY`);
    return process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  if (process.env.SUPABASE_SERVICE_KEY) {
    console.log(`🔑 ${tag} SUPABASE_SERVICE_ROLE_KEY no está definida, usando SUPABASE_SERVICE_KEY`);
    return process.env.SUPABASE_SERVICE_KEY;
  }
  if (process.env.SUPABASE_ANON_KEY) {
    console.warn(`⚠️ ${tag} Ni SUPABASE_SERVICE_ROLE_KEY ni SUPABASE_SERVICE_KEY están definidas, cayendo a SUPABASE_ANON_KEY (los inserts/updates pueden fallar por RLS)`);
    return process.env.SUPABASE_ANON_KEY;
  }
  console.warn(`⚠️ ${tag} Ninguna credencial de Supabase configurada, usando placeholder`);
  return 'placeholder';
}

module.exports = { resolveSupabaseServiceKey };
