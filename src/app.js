const path = require('node:path');
const { Readable } = require('node:stream');
const express = require('express');
const multer = require('multer');
const { ObjectId } = require('mongodb');
const { ApiError, errorHandler } = require('./errors');
const { createAuth } = require('./auth');

const inlinePreviewTypes = new Set([
  'application/pdf',
  'text/plain',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function safeFilename(filename) {
  return path.win32.basename(path.basename(filename || 'upload'));
}

function parseFileId(value) {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new ApiError(400, 'INVALID_FILE_ID', 'The file ID must be a 24-character hexadecimal ObjectId.');
  }
  return new ObjectId(value);
}

function createApp({ bucket, config, database, auth = createAuth(database) }) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileSizeBytes, files: 1 },
    fileFilter(request, file, callback) {
      if (!config.allowedMimeTypes.has(file.mimetype.toLowerCase())) {
        callback(new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'This file type is not allowed.'));
        return;
      }
      callback(null, true);
    },
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/config', (request, response) => {
    response.json({
      allowedMimeTypes: [...config.allowedMimeTypes],
      maxFileSizeBytes: config.maxFileSizeBytes,
    });
  });

  app.post('/api/auth/register', async (request, response, next) => {
    try {
      const result = await auth.register(request.body?.email, request.body?.password);
      response.set('Set-Cookie', auth.sessionCookie(result.token));
      response.status(201).json({ user: result.user });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', async (request, response, next) => {
    try {
      const result = await auth.login(request.body?.email, request.body?.password);
      response.set('Set-Cookie', auth.sessionCookie(result.token));
      response.status(200).json({ user: result.user });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', async (request, response, next) => {
    try {
      await auth.logout(request);
      response.set('Set-Cookie', auth.clearSessionCookie());
      response.status(200).json({ message: 'Signed out successfully.' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', auth.requireAuth, (request, response) => {
    response.json({ user: { id: request.user._id.toHexString(), email: request.user.email } });
  });

  app.get('/api/files', auth.requireAuth, async (request, response, next) => {
    try {
      const storedFiles = await bucket.find({ 'metadata.ownerId': request.user._id })
        .sort({ uploadDate: -1 }).toArray();
      response.json({
        files: storedFiles.map((file) => ({
          id: file._id.toHexString(),
          filename: safeFilename(file.filename),
          size: file.length,
          uploadDate: file.uploadDate,
          contentType: file.metadata?.contentType || 'application/octet-stream',
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/files/upload', auth.requireAuth, upload.single('file'), async (request, response, next) => {
    if (!request.file) {
      next(new ApiError(400, 'FILE_REQUIRED', 'A file is required in the "file" field.'));
      return;
    }

    const id = new ObjectId();
    let uploadStream;
    try {
      uploadStream = bucket.openUploadStreamWithId(id, safeFilename(request.file.originalname), {
        metadata: { contentType: request.file.mimetype, ownerId: request.user._id },
      });
      await require('node:stream/promises').pipeline(
        Readable.from(request.file.buffer),
        uploadStream,
      );

      const storedFile = await bucket.find({ _id: id }).next();
      response.status(201).json({
        id: id.toHexString(),
        filename: storedFile.filename,
        size: storedFile.length,
        uploadDate: storedFile.uploadDate,
      });
    } catch (error) {
      if (uploadStream) {
        try {
          await uploadStream.abort();
        } catch {}
        try {
          await bucket.delete(id);
        } catch {}
      }
      next(error);
    }
  });

  app.get('/api/files/:id', auth.requireAuth, async (request, response, next) => {
    let downloadStream;
    try {
      const id = parseFileId(request.params.id);
      const file = await bucket.find({ _id: id, 'metadata.ownerId': request.user._id }).next();
      if (!file) {
        throw new ApiError(404, 'FILE_NOT_FOUND', 'The requested file was not found.');
      }

      const contentType = file.metadata?.contentType || 'application/octet-stream';
      response.attachment(safeFilename(file.filename));
      if (request.query.preview === '1' && inlinePreviewTypes.has(contentType)) {
        response.set('Content-Disposition', 'inline');
      }
      response.set({
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
      });
      downloadStream = bucket.openDownloadStream(id);
      downloadStream.on('error', (error) => {
        if (!response.headersSent) {
          next(error);
        } else {
          response.destroy(error);
        }
      });
      request.on('aborted', () => downloadStream.destroy());
      downloadStream.pipe(response);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/files/:id', auth.requireAuth, async (request, response, next) => {
    try {
      const id = parseFileId(request.params.id);
      const file = await bucket.find({ _id: id, 'metadata.ownerId': request.user._id }).next();
      if (!file) {
        throw new ApiError(404, 'FILE_NOT_FOUND', 'The requested file was not found.');
      }

      await bucket.delete(id);
      response.status(200).json({ message: 'File deleted successfully.', id: id.toHexString() });
    } catch (error) {
      next(error);
    }
  });

  app.use(errorHandler);
  return app;
}

module.exports = { createApp, parseFileId, safeFilename };