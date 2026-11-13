const express = require('express');
const { verifySignature } = require('./hmac');

function createApp({ db, secret }) {
  const insertEvent = db.prepare(`
    INSERT INTO webhook_events (webhook_id, order_id, received_at) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING`);
  const insertOrder = db.prepare(`
    INSERT INTO orders (order_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING`);
  const insertJob = db.prepare(`
    INSERT INTO jobs (order_id, run_at, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING`);

  // One transaction, so a crash can never leave an order stored without the job that ships it.
  // Returns false when nothing new was stored.
  const storeOrder = db.transaction((webhookId, orderId, payload, now) => {
    if (insertEvent.run(webhookId, orderId, now).changes === 0) return false; // same delivery again
    if (insertOrder.run(orderId, payload, now, now).changes === 0) return false; // same order, new webhook id
    insertJob.run(orderId, now, now, now);
    return true;
  });

  const app = express();

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // Raw bytes, not parsed JSON: the signature is over the exact body sent, and parsing then
  // re-serializing can change spacing or key order.
  app.post('/webhooks/orders-create', express.raw({ type: 'application/json' }), (req, res) => {
    if (!verifySignature(req.body, req.get('X-Shop-Hmac-Sha256'), secret)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    let order;
    try {
      order = JSON.parse(req.body);
    } catch {
      return res.status(400).json({ error: 'body is not valid JSON' });
    }
    if (!order?.id) {
      return res.status(400).json({ error: 'order id is missing' });
    }
    const webhookId = req.get('X-Shop-Webhook-Id');
    if (!webhookId) {
      return res.status(400).json({ error: 'X-Shop-Webhook-Id header is missing' });
    }

    const stored = storeOrder(webhookId, String(order.id), req.body.toString('utf8'), Date.now());
    // A duplicate still gets 200: an error status would only make the store send it again.
    res.json({ ok: true, duplicate: !stored });
  });

  return app;
}

module.exports = { createApp };
