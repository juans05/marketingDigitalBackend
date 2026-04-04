const cloudinary = require('cloudinary').v2;

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error("❌ ERROR: Faltan variables de configuración de Cloudinary en el entorno.");
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

exports.generateUploadSignature = (folder = null, resourceType = 'video') => {
  const timestamp = Math.round(new Date().getTime() / 1000);
  
  // Eager diferenciado:
  // - Video: Versión optimizada para Reels (MP4/H264/AAC)
  // - Image: Versión optimizada para Feed (JPG/1080x1080)
  const eager = resourceType === 'video' 
    ? 'w_1080,h_1920,c_fill,vc_h264,ac_aac,f_mp4'
    : 'w_1080,h_1080,c_pad,b_black,f_jpg';

  // Signed upload directo sin preset
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
