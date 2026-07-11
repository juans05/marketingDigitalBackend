const crypto = require('crypto');
const fs = require('fs');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function getClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function buildSourceKey(artistId, filename) {
  const dot = String(filename || '').lastIndexOf('.');
  const ext = dot > -1 ? filename.slice(dot + 1).toLowerCase() : 'mp4';
  return `repurposer/sources/${artistId}/${crypto.randomUUID()}.${ext}`;
}

async function generatePresignedUploadUrl({ artistId, filename, contentType }) {
  if (!artistId) throw new Error('artistId es requerido');
  const key = buildSourceKey(artistId, filename);
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType || 'video/mp4',
  });
  const uploadUrl = await getSignedUrl(getClient(), command, { expiresIn: 600 });
  const sourceUrl = `${process.env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
  return { uploadUrl, sourceUrl, key };
}

/**
 * Sube un archivo local directo a R2 desde el servidor (sin presigned URL —
 * el worker ya tiene las credenciales, a diferencia del frontend).
 * @returns {Promise<string>} URL pública del objeto subido
 */
async function uploadFileToR2(localPath, key, contentType) {
  const body = fs.readFileSync(localPath);
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  });
  await getClient().send(command);
  return `${process.env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
}

async function deleteFromR2(key) {
  const command = new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  });
  await getClient().send(command);
}

module.exports = { buildSourceKey, generatePresignedUploadUrl, uploadFileToR2, deleteFromR2 };
