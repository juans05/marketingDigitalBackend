/**
 * SIMULATE FULL FLOW - Vidalis.AI (v3 - Final Fix)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const vidalisService = require('./src/services/vidalisService');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function runSimulation() {
  console.log('🚀 Iniciando simulación técnica del flujo...');

  try {
    const artist = { id: '3e5ae800-9ef2-4bf8-8d88-5029414491c9', name: 'Test Artist', ayrshare_profile_key: 'F3EBE5AA-87924E8B-9050AEE2-C63BA632' };
    const testVideoUrl = `https://res.cloudinary.com/do4rokki9/video/upload/v1712200000/vidalis_uploads/test_sim.mp4`;
    
    console.log('📡 [Paso 1] Registrando video...');
    const result = await vidalisService.registerVideo({
      title: 'Prueba Omnicanal 9:16',
      source_url: testVideoUrl,
      artist_id: artist.id,
      status: 'analyzing'
    });

    console.log(`✅ [Paso 1] OK. ID: ${result.id}`);
    console.log(`🔗 URL de Plataforma (9:16): ${result.processed_url}`);

    if (result.processed_url.includes('w_1080,h_1920,c_fill,vc_h264,ac_aac,f_mp4')) {
      console.log('✅ Verificación de Transformación 9:16: EXITOSA');
    }

    console.log('📤 [Paso 2] Generando opciones omnicanal...');
    const platforms = ['instagram', 'facebook', 'tiktok', 'youtube'];
    
    // CORRECCIÓN: (sourceUrl, platforms, postText, postType)
    const options = vidalisService.buildPlatformOptions(testVideoUrl, platforms, 'Prueba de impacto viral 🚀', 'reel');
    
    console.log('⚙️ Opciones Generadas por Red:');
    console.log(`   - YouTube: ${options.youtubeOptions?.youtubeShortsPost ? '✅ Short' : '❌ Normal'}`);
    console.log(`   - TikTok: ${options.tiktokOptions?.videoTitle ? '✅ Title OK' : '❌ No Title'}`);
    console.log(`   - Instagram: ${options.instagramOptions?.reels ? '✅ Reel' : '❌ Feed'}`);
    console.log(`   - Facebook: ${options.instagramOptions?.reels ? '✅ Reel compatible' : '❌ Normal'}`);

    console.log('\n--- PRUEBA TÉCNICA COMPLETADA ---');
    process.exit(0);

  } catch (error) {
    console.error('❌ ERROR EN LA SIMULACIÓN:', error.message);
    process.exit(1);
  }
}

runSimulation();
