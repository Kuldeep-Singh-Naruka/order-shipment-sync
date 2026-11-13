const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');

const secret = 'test-secret';
const body = JSON.stringify({ id: 1001, line_items: [{ sku: 'A1', quantity: 1 }] });
let server;
let url;

function sign(payload, key = secret) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64');
}

function post(payload, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: payload,
  });
}

before(async () => {
  server = createApp({ secret }).listen(0);
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
