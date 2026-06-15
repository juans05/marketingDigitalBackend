require('dotenv').config();
const zernioService = require('./src/services/zernioService');
const logger = require('./src/services/loggerService');

let profileId = null;

async function main() {
  if (!process.env.ZERNIO_API_KEY) {
    console.error('❌ ZERNIO_API_KEY no está configurada en .env');
    process.exit(1);
  }

  console.log('\n🔌 Verificando API de Zernio...\n');

  try {
    // 1. Crear perfil de prueba
    console.log('1️⃣  Creando perfil de prueba...');
    profileId = await zernioService.createProfile('Artista Test', 'test-id');
    console.log(`   ✅ Perfil creado: ${profileId}`);
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  try {
    // 2. Generar URL de autenticación
    console.log('\n2️⃣  Generando URL de conexión Instagram...');
    const connectData = await zernioService.generateConnectUrl(profileId, 'instagram');
    console.log(`   ✅ Auth URL: ${connectData.authUrl}`);
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  try {
    // 3. Listar cuentas conectadas
    console.log('\n3️⃣  Listando cuentas activas...');
    const accounts = await zernioService.getActivePlatforms(profileId);
    console.log(`   ✅ Cuentas: ${JSON.stringify(accounts)}`);
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  let automationId = null;
  try {
    // 4. Crear regla de automatización
    console.log('\n4️⃣  Creando automatización Comment-to-DM...');
    const automation = await zernioService.createCommentAutomation(profileId, 'acc_test', {
      name: 'Test Automation',
      keywords: ['test', 'prueba'],
      matchMode: 'contains',
      dmMessage: '¡Gracias por tu interés! Aquí tienes más info.',
      commentReply: '¡Revisa tu inbox!',
    });
    automationId = automation._id || automation.id;
    console.log(`   ✅ Automatización creada: ${automationId}`);
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  try {
    // 5. Listar automatizaciones
    console.log('\n5️⃣  Listando automatizaciones...');
    const list = await zernioService.listCommentAutomations(profileId);
    console.log(`   ✅ Automatizaciones: ${JSON.stringify(list)}`);
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  if (automationId) {
    try {
      // 6. Obtener detalle de automatización
      console.log('\n6️⃣  Obteniendo detalle de automatización...');
      const details = await zernioService.getCommentAutomationDetails(automationId);
      console.log(`   ✅ Detalle: ${JSON.stringify(details)}`);
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
    }

    try {
      // 7. Actualizar automatización
      console.log('\n7️⃣  Actualizando automatización...');
      const updated = await zernioService.updateCommentAutomation(automationId, { isActive: false });
      console.log(`   ✅ Actualizada: ${JSON.stringify(updated)}`);
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
    }

    try {
      // 8. Eliminar automatización
      console.log('\n8️⃣  Eliminando automatización...');
      await zernioService.deleteCommentAutomation(automationId);
      console.log('   ✅ Automatización eliminada');
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
    }
  }

  // 9. Eliminar perfil de prueba (cleanup)
  if (profileId) {
    try {
      console.log('\n9️⃣  Eliminando perfil de prueba...');
      await zernioService.deleteProfile(profileId);
      console.log('   ✅ Perfil eliminado');
    } catch (err) {
      console.error(`   ⚠️  No se pudo eliminar el perfil: ${err.message}`);
    }
  }

  console.log('\n✅ Verificación completada.\n');
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
