require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

async function test() {
  console.log("🚀 Probando inserción en system_logs...");
  const { data, error } = await supabase
    .from('system_logs')
    .insert([{
      level: 'info',
      event_type: 'TEST_LOG',
      details: { message: 'Probando grabación desde script' },
      source: 'test_script'
    }])
    .select();

  if (error) {
    console.error("❌ ERROR AL GRABAR EN TABLA:", error.message);
    console.error("Detalles:", error.details);
    console.error("Pista: Asegúrate de que la tabla 'system_logs' existe y tiene el RLS desactivado.");
  } else {
    console.log("✅ LOG GRABADO EXITOSAMENTE EN LA TABLA!");
    console.log("Datos:", data);
  }
}

test();
