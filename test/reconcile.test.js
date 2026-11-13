const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { reconcile } = require('../scripts/reconcile');

const now = Date.now();
const LONG_AGO = now - 60 * 60 * 1000;

function addOrder(db, orderId, orderStatus, jobStatus, { lockedAt = null, updatedAt = LONG_AGO } = {}) {
  db.prepare('INSERT INTO orders (order_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(orderId, '{}', orderStatus, updatedAt, updatedAt);
  db.prepare('INSERT INTO jobs (order_id, status, attempts, run_at, locked_at, created_at, updated_at) VALUES (?, ?, 3, ?, ?, ?, ?)')
    .run(orderId, jobStatus, updatedAt, lockedAt, updatedAt, updatedAt);
}

// Reconcile may only look up. Any POST is a test failure.
function fakeCourier(atCourier) {
  const calls = { find: [] };
  return {
    calls,
    async findShipments(reference) {
      calls.find.push(reference);
      return atCourier[reference] ?? [];
    },
    async createShipment() {
      throw new Error('reconcile must never create a shipment');
    },
  };
}

function row(db, orderId) {
  return db.prepare(`
    SELECT o.status AS order_status, o.shipment_id, j.status AS job_status, j.attempts, j.locked_at
    FROM orders o JOIN jobs j USING (order_id) WHERE order_id = ?`).get(orderId);
}

test('failed order whose shipment exists at the courier is adopted without a POST', async () => {
  const db = openDb(':memory:');
  addOrder(db, 'A', 'failed', 'dead');

  const summary = await reconcile(db, fakeCourier({ A: [{ shipmentId: 'shp_a', reference: 'A' }] }), now);

  assert.strictEqual(summary.adopted, 1);
  assert.deepStrictEqual(row(db, 'A'), { order_status: 'shipped', shipment_id: 'shp_a', job_status: 'done', attempts: 3, locked_at: null });
});

test('pending order with nothing at the courier and no active job is re-queued', async () => {
  const db = openDb(':memory:');
  addOrder(db, 'B', 'pending', 'done');

  const summary = await reconcile(db, fakeCourier({}), now);

  assert.strictEqual(summary.requeued, 1);
  assert.deepStrictEqual(row(db, 'B'), { order_status: 'pending', shipment_id: null, job_status: 'queued', attempts: 0, locked_at: null });
});

test('failed order with nothing at the courier stays dead for a human to replay', async () => {
  const db = openDb(':memory:');
  addOrder(db, 'C', 'failed', 'dead');

  const summary = await reconcile(db, fakeCourier({}), now);

  assert.strictEqual(summary.stillFailed, 1);
  assert.strictEqual(row(db, 'C').job_status, 'dead');
});

test('job stuck in processing is released, a recently locked one is not', async () => {
  const db = openDb(':memory:');
  addOrder(db, 'D', 'pending', 'processing', { lockedAt: LONG_AGO });
  addOrder(db, 'E', 'pending', 'processing', { lockedAt: now - 1000, updatedAt: now - 1000 });
  const courier = fakeCourier({});

  const summary = await reconcile(db, courier, now);

  assert.strictEqual(summary.released, 1);
  assert.strictEqual(row(db, 'D').job_status, 'queued');
  assert.strictEqual(row(db, 'D').locked_at, null);
  assert.strictEqual(row(db, 'E').job_status, 'processing');
  // Both now have an active job, so the worker owns them and reconcile does not look them up.
  assert.deepStrictEqual(courier.calls.find, []);
});
