const axios = require('axios');

const API_URL = 'http://localhost:3001/api/vidalis';

async function seedData() {
  try {
    console.log("🚀 Iniciando carga de datos de prueba...");

    // 1. Crear Agencia
    const agencyRes = await axios.post(`${API_URL}/agencies`, {
      name: "Vidalis Music Agency",
      plan_type: "Agency"
    });
    const agencyId = agencyRes.data.id;
    console.log(`✅ Agencia creada: ${agencyRes.data.name} (ID: ${agencyId})`);

    // 2. Crear Artista vinculado a la Agencia
    const artistRes = await axios.post(`${API_URL}/artists`, {
      agency_id: agencyId,
      name: "Juan S. (Demo Artist)",
      social_keys: { tiktok: "linked", ig: "linked" }
    });
    console.log(`✅ Artista creado: ${artistRes.data.name} (ID: ${artistRes.data.id})`);

    console.log("\n🎉 Fase 2 Completada al 100%. Ya puedes usar estos IDs para tus videos.");
  } catch (error) {
    console.error("❌ Error en el seeding:", error.response ? error.response.data : error.message);
  }
}

seedData();
