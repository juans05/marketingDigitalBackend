require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function searchUsers() {
  console.log('🔍 Buscando usuarios en PostgreSQL...\n');

  try {
    // Buscar en tabla de artistas
    console.log('📊 Tabla: artists');
    const { data: artists, error: artistError } = await supabase
      .from('artists')
      .select('*')
      .limit(20);

    if (artistError) {
      console.error('❌ Error en artists:', artistError.message);
    } else if (artists && artists.length > 0) {
      console.log(`✅ ${artists.length} artistas encontrados:\n`);
      console.table(artists);
    } else {
      console.log('⚠️  No hay artistas registrados');
    }

    // Buscar en tabla de agencias
    console.log('\n📊 Tabla: agencies');
    const { data: agencies, error: agencyError } = await supabase
      .from('agencies')
      .select('*')
      .limit(20);

    if (agencyError) {
      console.error('❌ Error en agencies:', agencyError.message);
    } else if (agencies && agencies.length > 0) {
      console.log(`✅ ${agencies.length} agencias encontradas:\n`);
      console.table(agencies);
    } else {
      console.log('⚠️  No hay agencias registradas');
    }

  } catch (err) {
    console.error('❌ Error de conexión:', err.message);
  }
}

searchUsers();
