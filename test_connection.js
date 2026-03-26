require('dotenv').config();
const socialPublisher = require('./src/services/socialPublisher');

async function test() {
  const artist = {
    id: 'test-id',
    name: 'Test Artist',
    publish_mode: null, // Probar con null para ver el comportamiento por defecto
    ayrshare_profile_key: null
  };

  const mockSupabase = {
    from: () => ({
      update: () => ({
        eq: () => Promise.resolve({ error: null })
      })
    })
  };

  console.log('🧪 Probando getConnectUrl con artista (publish_mode: null)...');
  try {
    const result = await socialPublisher.getConnectUrl(artist, mockSupabase);
    console.log('✅ Resultado:', result);
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

test();
