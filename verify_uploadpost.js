require('dotenv').config();
const uploadPostService = require('./src/services/uploadPostService');

async function test() {
  console.log('🧪 Iniciando prueba de Upload-Post.com...');
  
  if (!process.env.UPLOAD_POST_API_KEY) {
    console.error('❌ ERROR: Debes configurar UPLOAD_POST_API_KEY en el archivo .env');
    return;
  }

  try {
    // 1. Probar creación de perfil
    console.log('1. Creando perfil de prueba...');
    const userId = await uploadPostService.createProfile('Test Artist ' + Date.now());
    console.log('✅ Perfil creado. ID:', userId);

    // 2. Probar generación de URL de conexión
    console.log('2. Generando link de conexión...');
    const connectUrl = await uploadPostService.generateConnectUrl(userId);
    console.log('✅ Link generado:', connectUrl);

    // 3. Probar analíticas (esto puede fallar si no hay cuentas conectadas, pero probamos el endpoint)
    console.log('3. Probando endpoint de analíticas...');
    try {
      const stats = await uploadPostService.getAnalytics(userId, ['instagram']);
      console.log('✅ Analíticas (respuesta recibida):', stats);
    } catch (e) {
      console.log('ℹ️ Analíticas fallaron (normal si no hay redes conectadas aún):', e.message);
    }

    console.log('\n✨ Prueba completada con éxito.');
  } catch (err) {
    console.error('❌ Error durante la prueba:', err.response?.data || err.message);
  }
}

test();
