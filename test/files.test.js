const { Writable, Readable } = require('node:stream');
const assert = require('node:assert/strict');
const test = require('node:test');
const request = require('supertest');
const { ObjectId } = require('mongodb');
const { createApp } = require('../src/app');
const { readConfig } = require('../src/config');

test('uses a stable HTTP port without reading a PORT setting', () => {
  const config = readConfig({
    MONGODB_URI: 'mongodb://127.0.0.1:27017',
    MONGODB_DATABASE: 'file_uploader_test',
    PORT: '65012',
  });
  assert.equal(config.port, 3000);
});

function createTestApp() {
  const files = new Map();
  const collections = new Map();

  function matches(document, filter) {
    return Object.entries(filter).every(([field, expected]) => {
      const value = field.split('.').reduce((current, part) => current?.[part], document);
      if (expected && typeof expected === 'object' && '$gt' in expected) {
        return value > expected.$gt;
      }
      if (value instanceof ObjectId && expected instanceof ObjectId) {
        return value.equals(expected);
      }
      return value === expected;
    });
  }

  const database = {
    collection(name) {
      if (!collections.has(name)) collections.set(name, []);
      const documents = collections.get(name);
      return {
        createIndex: async () => {},
        findOne: async (filter) => documents.find((document) => matches(document, filter)) || null,
        async insertOne(document) {
          if (name === 'users' && documents.some((entry) => entry.email === document.email)) {
            const error = new Error('Duplicate email.');
            error.code = 11000;
            throw error;
          }
          const insertedId = new ObjectId();
          documents.push({ ...document, _id: insertedId });
          return { insertedId };
        },
        async deleteOne(filter) {
          const index = documents.findIndex((document) => matches(document, filter));
          if (index >= 0) documents.splice(index, 1);
        },
      };
    },
  };

  const bucket = {
    openUploadStreamWithId(id, filename, options) {
      const chunks = [];
      return new Writable({
        write(chunk, encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          files.set(id.toHexString(), {
            _id: id,
            filename,
            length: Buffer.concat(chunks).length,
            uploadDate: new Date('2026-01-01T00:00:00.000Z'),
            metadata: options.metadata,
            data: Buffer.concat(chunks),
          });
          callback();
        },
      });
    },
    find(filter = {}) {
      const matchingFiles = [...files.values()].filter((file) => Object.entries(filter).every(([field, expected]) => {
        const value = field.split('.').reduce((current, part) => current?.[part], file);
        if (value?.toHexString && expected?.toHexString) {
          return value.toHexString() === expected.toHexString();
        }
        return value === expected;
      }));
      return {
        next: async () => matchingFiles[0] || null,
        sort() {
          matchingFiles.sort((left, right) => right.uploadDate - left.uploadDate);
          return this;
        },
        toArray: async () => matchingFiles,
      };
    },
    openDownloadStream(id) {
      return Readable.from(files.get(id.toHexString()).data);
    },
    async delete(id) {
      files.delete(id.toHexString());
    },
  };

  return {
    app: createApp({
      bucket,
      config: {
        maxFileSizeBytes: 8,
        allowedMimeTypes: new Set(['text/plain']),
      },
      database,
    }),
    files,
  };
}

async function authenticatedRequest(app, email = 'person@example.com') {
  const client = request.agent(app);
  const registration = await client.post('/api/auth/register').send({
    email,
    password: 'correct horse battery staple',
  });
  assert.equal(registration.status, 201);
  return { client, user: registration.body.user };
}

test('registers, logs in, logs out, and protects account routes', async () => {
  const { app } = createTestApp();
  const client = request.agent(app);
  const credentials = { email: 'Person@Example.com', password: 'correct horse battery staple' };

  const registration = await client.post('/api/auth/register').send(credentials);
  assert.equal(registration.status, 201);
  assert.equal(registration.body.user.email, 'person@example.com');
  assert.match(registration.headers['set-cookie'][0], /HttpOnly/);
  assert.match(registration.headers['set-cookie'][0], /SameSite=Lax/);
  assert.equal((await client.get('/api/auth/me')).body.user.id, registration.body.user.id);

  const duplicate = await request(app).post('/api/auth/register').send(credentials);
  assert.equal(duplicate.status, 409);

  const wrongPassword = await request(app).post('/api/auth/login').send({
    email: credentials.email,
    password: 'incorrect password',
  });
  assert.equal(wrongPassword.status, 401);

  const loggedOut = await client.post('/api/auth/logout');
  assert.equal(loggedOut.status, 200);
  assert.equal((await client.get('/api/auth/me')).status, 401);

  const signedIn = request.agent(app);
  const login = await signedIn.post('/api/auth/login').send(credentials);
  assert.equal(login.status, 200);
  assert.equal((await signedIn.get('/api/auth/me')).body.user.email, 'person@example.com');

  assert.equal((await request(app).get('/api/files')).status, 401);
  assert.equal((await request(app).post('/api/files/upload')).status, 401);
});

test('enforces the registration password length boundaries', async () => {
  const { app } = createTestApp();
  const shortPassword = await request(app).post('/api/auth/register').send({
    email: 'short@example.com',
    password: '12345678901',
  });
  assert.equal(shortPassword.status, 400);
  assert.equal(shortPassword.body.error.code, 'INVALID_PASSWORD');

  const tooLongPassword = await request(app).post('/api/auth/register').send({
    email: 'long@example.com',
    password: 'a'.repeat(129),
  });
  assert.equal(tooLongPassword.status, 400);
  assert.equal(tooLongPassword.body.error.code, 'INVALID_PASSWORD');

  const minimumPassword = await request(app).post('/api/auth/register').send({
    email: 'minimum@example.com',
    password: 'a'.repeat(12),
  });
  assert.equal(minimumPassword.status, 201);
});

test('uploads, retrieves, and deletes a GridFS file', async () => {
  const { app, files } = createTestApp();
  const { client } = await authenticatedRequest(app);
  const uploaded = await client
    .post('/api/files/upload')
    .attach('file', Buffer.from('hello'), { filename: 'hello.data', contentType: 'text/plain' });

  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.filename, 'hello.data');
  assert.equal(uploaded.body.size, 5);
  assert.ok(uploaded.body.id);
  assert.ok(uploaded.body.uploadDate);

  const downloaded = await client.get(`/api/files/${uploaded.body.id}`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(downloaded.headers['content-disposition'], /^attachment;/);
  assert.equal(downloaded.text, 'hello');

  const preview = await client.get(`/api/files/${uploaded.body.id}?preview=1`);
  assert.equal(preview.headers['content-disposition'], 'inline');
  assert.equal(preview.text, 'hello');

  const listing = await client.get('/api/files');
  assert.equal(listing.status, 200);
  assert.deepEqual(Object.keys(listing.body.files[0]).sort(), [
    'contentType', 'filename', 'id', 'size', 'uploadDate',
  ]);
  assert.deepEqual(listing.body.files[0], {
    id: uploaded.body.id,
    filename: 'hello.data',
    size: 5,
    uploadDate: '2026-01-01T00:00:00.000Z',
    contentType: 'text/plain',
  });

  const config = await client.get('/api/config');
  assert.deepEqual(config.body, {
    allowedMimeTypes: ['text/plain'],
    maxFileSizeBytes: 8,
  });

  const deleted = await client.delete(`/api/files/${uploaded.body.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(files.size, 0);

  const emptyListing = await client.get('/api/files');
  assert.deepEqual(emptyListing.body, { files: [] });
});

test('serves the file desk from the same Express origin', async () => {
  const { app } = createTestApp();
  const response = await request(app).get('/');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.text, /FIELDNOTE/);
});

test('does not inline active-content files when preview is requested', async () => {
  const { app, files } = createTestApp();
  const { client, user } = await authenticatedRequest(app);
  const id = '0123456789abcdef01234567';
  files.set(id, {
    _id: { toHexString: () => id },
    filename: 'page.html',
    length: 18,
    uploadDate: new Date('2026-01-01T00:00:00.000Z'),
    metadata: { contentType: 'text/html', ownerId: new ObjectId(user.id) },
    data: Buffer.from('<h1>unsafe</h1>'),
  });

  const response = await client.get(`/api/files/${id}?preview=1`);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-disposition'], /^attachment;/);
});

test('reports missing files, unexpected fields, invalid IDs, and unsupported MIME types', async () => {
  const { app } = createTestApp();
  const { client } = await authenticatedRequest(app);
  const missing = await client.post('/api/files/upload');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'FILE_REQUIRED');

  const unexpected = await client
    .post('/api/files/upload')
    .attach('other', Buffer.from('hello'), 'hello.txt');
  assert.equal(unexpected.status, 400);

  const multiple = await client
    .post('/api/files/upload')
    .attach('file', Buffer.from('one'), 'one.txt')
    .attach('file', Buffer.from('two'), 'two.txt');
  assert.equal(multiple.status, 400);

  const unsupported = await client
    .post('/api/files/upload')
    .attach('file', Buffer.from('hello'), { filename: 'hello.bin', contentType: 'application/octet-stream' });
  assert.equal(unsupported.status, 415);

  const invalidId = await client.get('/api/files/not-an-object-id');
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.body.error.code, 'INVALID_FILE_ID');
});

test('rejects uploads over the configured size limit and missing stored files', async () => {
  const { app } = createTestApp();
  const { client } = await authenticatedRequest(app);
  const tooLarge = await client
    .post('/api/files/upload')
    .attach('file', Buffer.from('123456789'), { filename: 'large.txt', contentType: 'text/plain' });
  assert.equal(tooLarge.status, 413);

  const absent = await client.get('/api/files/0123456789abcdef01234567');
  assert.equal(absent.status, 404);
});

test('keeps each account file library private', async () => {
  const { app } = createTestApp();
  const first = await authenticatedRequest(app, 'first@example.com');
  const second = await authenticatedRequest(app, 'second@example.com');
  const uploaded = await first.client.post('/api/files/upload')
    .attach('file', Buffer.from('private'), { filename: 'private.txt', contentType: 'text/plain' });

  assert.equal(uploaded.status, 201);
  assert.deepEqual((await second.client.get('/api/files')).body, { files: [] });
  assert.equal((await second.client.get(`/api/files/${uploaded.body.id}`)).status, 404);
  assert.equal((await second.client.delete(`/api/files/${uploaded.body.id}`)).status, 404);
});
