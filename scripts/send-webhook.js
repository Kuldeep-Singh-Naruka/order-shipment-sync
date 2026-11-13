// Sends one signed orders/create webhook, the exact same delivery again, and then the same
// order under a new webhook id. Only the first should be stored.
const crypto = require('node:crypto');
const config = require('../src/config');

if (!config.webhookSecret) {
  console.error('[send-webhook] WEBHOOK_SECRET is not set. Copy .env.example to .env');
  process.exit(1);
}

const url = `http://localhost:${config.port}/webhooks/orders-create`;
const order = {
  id: Date.now(),
  shipping_address: { name: 'Asha Verma', address1: '12 MG Road', city: 'Jaipur', zip: '302001', country: 'IN' },
  line_items: [{ sku: 'TSHIRT-M', quantity: 2 }],
};
const body = JSON.stringify(order);
const signature = crypto.createHmac('sha256', config.webhookSecret).update(body).digest('base64');

async function send(label, webhookId) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shop-Hmac-Sha256': signature, 'X-Shop-Webhook-Id': webhookId },
    body,
  });
  console.log(`[send-webhook] ${label}: ${res.status} ${await res.text()}`);
}

async function main() {
  const webhookId = crypto.randomUUID();
  console.log(`[send-webhook] order ${order.id} to ${url}`);
  await send('first delivery      ', webhookId);
  await send('same webhook again  ', webhookId);
  await send('same order, new id  ', crypto.randomUUID());
}

main().catch((err) => {
  console.error(`[send-webhook] ${err.cause?.code ?? err.message} (is the server running?)`);
  process.exit(1);
});
