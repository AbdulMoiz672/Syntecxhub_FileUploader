const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

function readConfig(environment = process.env) {
  const maxFileSizeBytes = Number(environment.MAX_FILE_SIZE_BYTES || 10 * 1024 * 1024);
  if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes < 1) {
    throw new Error('MAX_FILE_SIZE_BYTES must be a positive integer.');
  }

  const allowedMimeTypes = (environment.ALLOWED_MIME_TYPES || 'image/jpeg,image/png,application/pdf,text/plain')
    .split(',')
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean);

  return {
    port: 3000,
    mongoUri: environment.MONGODB_URI,
    databaseName: environment.MONGODB_DATABASE || 'file_uploader',
    bucketName: environment.GRIDFS_BUCKET || 'uploads',
    maxFileSizeBytes,
    allowedMimeTypes: new Set(allowedMimeTypes),
  };
}

module.exports = { readConfig };