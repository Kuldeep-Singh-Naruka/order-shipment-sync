const config = require('./config');
const { createApp } = require('./app');
const { openDb } = require('./db');
const courier = require('./courier');
const { startWorker } = require('./worker');

// Without a secret every webhook would get 401, so fail at startup where the cause is obvious.
if (!config.webhookSecret) {
  console.error('[server] WEBHOOK_SECRET is not set. Copy .env.example to .env');
  process.exit(1);
}

const db = openDb();

createApp({ db, secret: config.webhookSecret }).listen(config.port, () => {
  console.log(`[server] listening on port ${config.port}`);
});
startWorker(db, courier);
