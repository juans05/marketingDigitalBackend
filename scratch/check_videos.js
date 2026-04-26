
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  console.log('--- ARTISTAS ---');
  const { data: artists } = await supabase.from('artists').select('id, name, agency_id');
  console.table(artists);

  console.log('\n--- VIDEOS ---');
  const { data: videos } = await supabase.from('videos').select('id, title, artist_id, status, created_at').order('created_at', { ascending: false }).limit(5);
  console.table(videos);
}

check();
