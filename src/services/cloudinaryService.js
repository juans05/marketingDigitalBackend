const cloudinary = require('cloudinary').v2;

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error("❌ ERROR: Faltan variables de configuración de Cloudinary en el entorno.");
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

exports.generateUploadSignature = (folder = null) => {
  const timestamp = Math.round(new Date().getTime() / 1000);
  const eager = 'w_1080,h_1920,c_fill,g_auto,vc_h264,ac_aac,f_mp4';
  // Signed upload directo sin preset — evita conflictos con presets Signed de Cloudinary
  const params = { 
    access_mode: 'public', 
    folder: folder || 'vidalis_uploads', 
    timestamp,
    eager
  };

  const signature = cloudinary.utils.api_sign_request(
    params,
    process.env.CLOUDINARY_API_SECRET
  );

  return {
    timestamp,
    signature,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    folder: folder || 'vidalis_uploads',
    eager
  };
};
