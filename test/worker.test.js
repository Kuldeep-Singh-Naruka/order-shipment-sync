const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { runOnce } = require('../src/worker');

const order = { id: 5001, shipping_address: { city: 'Jaipur' }, line_items: [{ sku: 'A1', quantity: 1 }] };

function setup() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO orders (order_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('5001', JSON.stringify(order), now, now);
  db.prepare('INSERT INTO jobs (order_id, run_at, created_at, updated_at) VALUES (?, ?, ?, ?)').run('5001', now, now, now);
  return db;
}

// Records every call so tests can check how many times the courier was asked to create.
function fakeCourier(existing = []) {
  const calls = { find: [], create: [] };
  return {
    calls,
    async findShipments(reference) {
      calls.find.push(reference);
      return existing;
    },
    async createShipment(reference, payload) {
      calls.create.push({ reference, payload });
      return { shipmentId: 'shp_new', reference };
    },
  };
}

function state(db) {
  return {
    order: db.prepare("SELECT status, shipment_id FROM orders WHERE order_id = '5001'").get(),
    job: db.prepare("SELECT status FROM jobs WHERE order_id = '5001'").pluck().get(),
  };
}

test('queued job creates a shipment and finishes', async () => {
  const db = setup();
  const courier = fakeCourier();

  assert.strictEqual(await runOnce(db, courier), true);

  assert.deepStrictEqual(courier.calls.find, ['5001']);
  assert.deepStrictEqual(courier.calls.create, [{ reference: '5001', payload: order }]);
  assert.deepStrictEqual(state(db), { order: { status: 'shipped', shipment_id: 'shp_new' }, job: 'done' });
  assert.strictEqual(await runOnce(db, courier), false);
});

test('shipment already at the courier is adopted without a new POST', async () => {
  const db = setup();
  const courier = fakeCourier([{ shipmentId: 'shp_old', reference: '5001' }]);

  await runOnce(db, courier);

  assert.strictEqual(courier.calls.create.length, 0);
  assert.deepStrictEqual(state(db), { order: { status: 'shipped', shipment_id: 'shp_old' }, job: 'done' });
});

test('more than one shipment at the courier marks the order for review', async () => {
  const db = setup();
  const courier = fakeCourier([
    { shipmentId: 'shp_a', reference: '5001' },
    { shipmentId: 'shp_b', reference: '5001' },
  ]);

  await runOnce(db, courier);

  assert.strictEqual(courier.calls.create.length, 0);
  assert.deepStrictEqual(state(db), { order: { status: 'needs_review', shipment_id: null }, job: 'done' });
});
