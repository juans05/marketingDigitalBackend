require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function resetPasswords() {
  const newPassword = 'Sistema2025.qq';

  console.log('🔐 Reseteando todas las contraseñas...\n');

  try {
    // Hashear la nueva contraseña
    const passwordHash = await bcrypt.hash(newPassword, 10);
    console.log('✓ Contraseña hasheada\n');

    // Obtener todas las agencias
    const { data: agencies, error: fetchError } = await supabase
      .from('agencies')
      .select('id, name, email');

    if (fetchError) {
      console.error('❌ Error al obtener agencias:', fetchError.message);
      return;
    }

    // Actualizar cada agencia
    let updated = 0;
    for (const agency of agencies) {
      const { error } = await supabase
        .from('agencies')
        .update({ password_hash: passwordHash })
        .eq('id', agency.id);

      if (!error) {
        updated++;
      } else {
        console.error(`❌ Error actualizando ${agency.email}:`, error.message);
      }
    }

    console.log(`✅ Contraseñas reseteadas exitosamente! (${updated}/${agencies.length})\n`);
    console.log('Nuevas credenciales:\n');

    agencies.forEach(agency => {
      console.log(`📧 ${agency.email}`);
      console.log(`   🔐 Contraseña: ${newPassword}\n`);
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

resetPasswords();
