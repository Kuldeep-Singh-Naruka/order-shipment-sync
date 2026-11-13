const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');

const secret = 'test-secret';
const body = JSON.stringify({ id: 1001, line_items: [{ sku: 'A1', quantity: 1 }] });
const db = openDb(':memory:');
let server;
let url;

function sign(payload, key = secret) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64');
}

function post(payload, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shop-Webhook-Id': crypto.randomUUID(), ...headers },
    body: payload,
  });
}

function sendSigned(payload, webhookId) {
  return post(payload, { 'X-Shop-Hmac-Sha256': sign(payload), 'X-Shop-Webhook-Id': webhookId });
}

function count(table, orderId) {
  return db.prepare(`SELECT COUNT(*) FROM ${table} WHERE order_id = ?`).pluck().get(orderId);
}

before(async () => {
  server = createApp({ db, secret }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}/webhooks/orders-create`;
});

after(() => server.close());

test('valid signature is accepted', async () => {
  const res = await post(body, { 'X-Shop-Hmac-Sha256': sign(body) });
  assert.strictEqual(res.status, 200);
});

test('signature made with the wrong secret is rejected', async () => {
  const res = await post(body, { 'X-Shop-Hmac-Sha256': sign(body, 'other-secret') });
  assert.strictEqual(res.status, 401);
});

test('body changed by one byte after signing is rejected', async () => {
  const signature = sign(body);
  const tampered = body.replace('1001', '1002');
  const res = await post(tampered, { 'X-Shop-Hmac-Sha256': signature });
  assert.strictEqual(res.status, 401);
});

test('missing signature header is rejected', async () => {
  const res = await post(body);
  assert.strictEqual(res.status, 401);
});

test('signature of a different length is rejected without crashing', async () => {
  const res = await post(body, { 'X-Shop-Hmac-Sha256': 'c2hvcnQ=' });
  assert.strictEqual(res.status, 401);
});

test('validly signed body that is not JSON returns 400', async () => {
  const notJson = '{"id": 1001';
  const res = await post(notJson, { 'X-Shop-Hmac-Sha256': sign(notJson) });
  assert.strictEqual(res.status, 400);
});

test('validly signed JSON without an order id returns 400', async () => {
  const noId = JSON.stringify({ line_items: [] });
  const res = await post(noId, { 'X-Shop-Hmac-Sha256': sign(noId) });
  assert.strictEqual(res.status, 400);
});

test('missing webhook id header returns 400', async () => {
  const res = await post(body, { 'X-Shop-Hmac-Sha256': sign(body), 'X-Shop-Webhook-Id': '' });
  assert.strictEqual(res.status, 400);
});

test('new webhook stores the order with a queued job', async () => {
  const payload = JSON.stringify({ id: 2001 });
  const res = await sendSigned(payload, 'wh-2001');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, duplicate: false });

  const order = db.prepare('SELECT payload, status FROM orders WHERE order_id = ?').get('2001');
  assert.deepStrictEqual(order, { payload, status: 'pending' });
  const job = db.prepare('SELECT status, attempts FROM jobs WHERE order_id = ?').get('2001');
  assert.deepStrictEqual(job, { status: 'queued', attempts: 0 });
});

test('same webhook id delivered twice gives one order and one job', async () => {
  const payload = JSON.stringify({ id: 3001 });
  await sendSigned(payload, 'wh-3001');
  const res = await sendSigned(payload, 'wh-3001');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, duplicate: true });
  assert.strictEqual(count('orders', '3001'), 1);
  assert.strictEqual(count('jobs', '3001'), 1);
});

test('same order id with a new webhook id gives one order and one job', async () => {
  const payload = JSON.stringify({ id: 4001 });
  await sendSigned(payload, 'wh-4001-a');
  const res = await sendSigned(payload, 'wh-4001-b');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, duplicate: true });
  assert.strictEqual(count('orders', '4001'), 1);
  assert.strictEqual(count('jobs', '4001'), 1);
  assert.strictEqual(count('webhook_events', '4001'), 2);
});
