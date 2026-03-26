require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function diagnose() {
  const targetId = 'cb8109bb-0463-479a-ba5e-1a5da0ed862e';
  console.log('--- DIAGNOSTICO ---');
  console.log('Buscando ID:', targetId);
  
  try {
    const { data: artists, error } = await supabase.from('artists').select('id, name');
    if (error) throw error;
    
    console.log('Total artistas encontrados:', artists.length);
    const found = artists.find(a => a.id === targetId);
    if (found) {
      console.log('✅ El artista EXISTE:', found);
    } else {
      console.log('❌ El artista NO SE ENCUENTRA en la lista.');
    }
    
    console.log('Todos los IDs de artistas:');
    artists.forEach(a => console.log(`- ${a.id} (${a.name})`));
    
  } catch (err) {
    console.error('❌ Error de conexión/consulta:', err.message);
  }
}

diagnose();
