function buildClipUrl(sourceUrl, startSeconds, endSeconds) {
  if (!sourceUrl || !sourceUrl.includes('cloudinary.com') || !sourceUrl.includes('/upload/')) {
    throw new Error(`buildClipUrl: la URL no es de Cloudinary: ${sourceUrl}`);
  }

  const cleanUrl = sourceUrl.replace(/\s+/g, '').split('?')[0];
  const regex = /^(https:\/\/res\.cloudinary\.com\/[^\/]+\/(?:video|image)\/upload\/)(?:[^\/]+\/)*(v\d+\/.*)$/;
  const match = cleanUrl.match(regex);

  if (!match) {
    throw new Error(`buildClipUrl: la URL de Cloudinary no estándar: ${cleanUrl}`);
  }

  const baseUrl = match[1];
  const publicId = match[2];
  const trans = `so_${startSeconds},eo_${endSeconds}`;
  return `${baseUrl}${trans}/${publicId}`;
}

module.exports = { buildClipUrl };
