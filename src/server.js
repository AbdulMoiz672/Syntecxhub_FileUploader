const { MongoClient, GridFSBucket } = require('mongodb');
const { createApp } = require('./app');
const { createAuth } = require('./auth');
const { readConfig } = require('./config');

async function start() {
  const config = readConfig();
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is required.');
  }

  const client = new MongoClient(config.mongoUri);
  await client.connect();
  const database = client.db(config.databaseName);
  const bucket = new GridFSBucket(database, { bucketName: config.bucketName });
  const auth = createAuth(database);
  await auth.ensureIndexes();
  const server = createApp({ bucket, config, database, auth }).listen(config.port, () => {
    console.log(`File API listening at http://localhost:${config.port}`);
  });

  const shutdown = () => {
    server.close(async () => {
      await client.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch(() => {
  console.error('File API could not connect to MongoDB or start. Check the server configuration.');
  process.exitCode = 1;
});