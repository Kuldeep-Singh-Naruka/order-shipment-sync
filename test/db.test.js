const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');

const now = Date.now();

function insertEvent(db, webhookId, orderId) {
  db.prepare('INSERT INTO webhook_events (webhook_id, order_id, received_at) VALUES (?, ?, ?)').run(webhookId, orderId, now);
}

function insertOrder(db, orderId) {
  db.prepare('INSERT INTO orders (order_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)').run(orderId, '{}', now, now);
}

function insertJob(db, orderId) {
  db.prepare('INSERT INTO jobs (order_id, run_at, created_at, updated_at) VALUES (?, ?, ?, ?)').run(orderId, now, now, now);
}

test('creates the three tables', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
  assert.deepStrictEqual(names, ['jobs', 'orders', 'webhook_events']);
});

test('same webhook id cannot be stored twice', () => {
  const db = openDb(':memory:');
  insertEvent(db, 'wh-1', 'order-1');
  assert.throws(() => insertEvent(db, 'wh-1', 'order-1'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
});

test('same order id cannot be stored twice', () => {
  const db = openDb(':memory:');
  insertOrder(db, 'order-1');
  assert.throws(() => insertOrder(db, 'order-1'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
});

test('an order can have only one job', () => {
  const db = openDb(':memory:');
  insertJob(db, 'order-1');
  assert.throws(() => insertJob(db, 'order-1'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
});

test('new order and job get their default status', () => {
  const db = openDb(':memory:');
  insertOrder(db, 'order-1');
  insertJob(db, 'order-1');
  assert.strictEqual(db.prepare('SELECT status FROM orders').pluck().get(), 'pending');
  assert.deepStrictEqual(db.prepare('SELECT status, attempts FROM jobs').get(), { status: 'queued', attempts: 0 });
});
