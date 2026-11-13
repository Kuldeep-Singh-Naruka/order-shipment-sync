const Database = require('better-sqlite3');
const config = require('./config');

// Times are Unix milliseconds passed in from JS (no SQL defaults), so tests can control "now".
const schema = `
  CREATE TABLE IF NOT EXISTS webhook_events (
    webhook_id  TEXT PRIMARY KEY,
    order_id    TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    order_id    TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'shipped', 'failed', 'needs_review')),
    shipment_id TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY,
    order_id   TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'processing', 'done', 'dead')),
    attempts   INTEGER NOT NULL DEFAULT 0,
    run_at     INTEGER NOT NULL,
    locked_at  INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

function openDb(path = config.dbPath) {
  const db = new Database(path);
  // The reconcile and dead-jobs scripts open the same file from another process while the
  // server runs. WAL lets readers and the writer work at the same time.
  db.pragma('journal_mode = WAL');
  db.exec(schema);
  return db;
}

module.exports = { openDb };
