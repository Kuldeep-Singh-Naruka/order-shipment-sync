const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { openDb } = require('../src/db');
const { runOnce } = require('../src/worker');
const { replayJob } = require('../scripts/dead-jobs');

const order = { id: 5001, shipping_address: { city: 'Jaipur' }, line_items: [{ sku: 'A1', quantity: 1 }] };
const LATER = 61000; // longer than the biggest backoff, so the job is due again

function setup() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO orders (order_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('5001', JSON.stringify(order), now, now);
  db.prepare('INSERT INTO jobs (order_id, run_at, created_at, updated_at) VALUES (?, ?, ?, ?)').run('5001', now, now, now);
  return db;
}

function courierError(kind, extra = {}) {
  return Object.assign(new Error(`fake ${kind}`), { kind }, extra);
}

// Records every call so tests can check how many times the courier was asked to create.
function fakeCourier({ find = async () => [], create = async (reference) => ({ shipmentId: 'shp_new', reference }) } = {}) {
  const calls = { find: [], create: [] };
  return {
    calls,
    findShipments(reference) {
      calls.find.push(reference);
      return find(reference);
    },
    createShipment(reference, payload) {
      calls.create.push({ reference, payload });
      return create(reference, payload);
    },
  };
}

function state(db) {
  return {
    order: db.prepare("SELECT status, shipment_id FROM orders WHERE order_id = '5001'").get(),
    job: db.prepare("SELECT status, attempts, rate_limit_waits, run_at, last_error FROM jobs WHERE order_id = '5001'").get(),
  };
}

test('queued job creates a shipment and finishes', async () => {
  const db = setup();
  const courier = fakeCourier();

  assert.strictEqual(await runOnce(db, courier), true);

  assert.deepStrictEqual(courier.calls.find, ['5001']);
  assert.deepStrictEqual(courier.calls.create, [{ reference: '5001', payload: order }]);
  assert.deepStrictEqual(state(db).order, { status: 'shipped', shipment_id: 'shp_new' });
  assert.strictEqual(state(db).job.status, 'done');
  assert.strictEqual(await runOnce(db, courier), false);
});

test('shipment already at the courier is adopted without a new POST', async () => {
  const db = setup();
  const courier = fakeCourier({ find: async () => [{ shipmentId: 'shp_old', reference: '5001' }] });

  await runOnce(db, courier);

  assert.strictEqual(courier.calls.create.length, 0);
  assert.deepStrictEqual(state(db).order, { status: 'shipped', shipment_id: 'shp_old' });
  assert.strictEqual(state(db).job.status, 'done');
});

test('more than one shipment at the courier marks the order for review', async () => {
  const db = setup();
  const courier = fakeCourier({
    find: async () => [
      { shipmentId: 'shp_a', reference: '5001' },
      { shipmentId: 'shp_b', reference: '5001' },
    ],
  });

  await runOnce(db, courier);

  assert.strictEqual(courier.calls.create.length, 0);
  assert.deepStrictEqual(state(db).order, { status: 'needs_review', shipment_id: null });
  assert.strictEqual(state(db).job.status, 'done');
});

test('courier creates the shipment then times out: next attempt adopts it, POST is called once', async () => {
  const db = setup();
  const atCourier = [];
  const courier = fakeCourier({
    find: async () => atCourier,
    create: async (reference) => {
      atCourier.push({ shipmentId: 'shp_1', reference });
      throw courierError('timeout');
    },
  });
  const now = Date.now();

  await runOnce(db, courier, () => now);
  assert.strictEqual(state(db).job.status, 'queued');
  assert.strictEqual(state(db).job.attempts, 1);

  await runOnce(db, courier, () => now + LATER);
  assert.strictEqual(courier.calls.create.length, 1);
  assert.deepStrictEqual(state(db).order, { status: 'shipped', shipment_id: 'shp_1' });
  assert.strictEqual(state(db).job.status, 'done');
});

test('429 waits for Retry-After and does not use up an attempt', async () => {
  const db = setup();
  const courier = fakeCourier({
    find: async () => {
      throw courierError('rate_limited', { retryAfterMs: 2000 });
    },
  });
  const now = Date.now();

  await runOnce(db, courier, () => now);

  const { job } = state(db);
  assert.strictEqual(job.status, 'queued');
  assert.strictEqual(job.attempts, 0);
  assert.strictEqual(job.rate_limit_waits, 1);
  assert.strictEqual(job.run_at, now + 2000);
});

test('always 500: backs off, then the job is dead after MAX_ATTEMPTS', async () => {
  const db = setup();
  const courier = fakeCourier({
    find: async () => {
      throw courierError('retryable');
    },
  });
  let now = Date.now();

  await runOnce(db, courier, () => now);
  const firstDelay = state(db).job.run_at - now;
  assert.ok(firstDelay >= 1600 && firstDelay <= 2400, `first backoff was ${firstDelay}ms`);

  for (let attempt = 2; attempt <= config.maxAttempts; attempt++) {
    assert.strictEqual(state(db).job.status, 'queued');
    now += LATER;
    await runOnce(db, courier, () => now);
  }

  const { order: o, job } = state(db);
  assert.strictEqual(job.status, 'dead');
  assert.strictEqual(job.attempts, config.maxAttempts);
  assert.strictEqual(job.last_error, 'fake retryable');
  assert.strictEqual(o.status, 'failed');
  assert.strictEqual(await runOnce(db, courier, () => now + LATER), false);
});

test('fatal error makes the job dead on the first attempt', async () => {
  const db = setup();
  const courier = fakeCourier({
    create: async () => {
      throw courierError('fatal');
    },
  });

  await runOnce(db, courier);

  assert.strictEqual(state(db).job.status, 'dead');
  assert.strictEqual(state(db).order.status, 'failed');
});

test('replay puts a dead job back to queued and it can then ship', async () => {
  const db = setup();
  await runOnce(db, fakeCourier({ create: async () => { throw courierError('fatal'); } }));
  const jobId = db.prepare("SELECT id FROM jobs WHERE order_id = '5001'").pluck().get();
  const now = Date.now();

  assert.strictEqual(replayJob(db, jobId, now), true);
  assert.deepStrictEqual(
    db.prepare('SELECT status, attempts, run_at FROM jobs WHERE id = ?').get(jobId),
    { status: 'queued', attempts: 0, run_at: now },
  );
  assert.strictEqual(state(db).order.status, 'pending');
  assert.strictEqual(replayJob(db, jobId, now), false); // only dead jobs can be replayed

  await runOnce(db, fakeCourier(), () => now);
  assert.deepStrictEqual(state(db).order, { status: 'shipped', shipment_id: 'shp_new' });
});
