const express = require('express');
const { verifySignature } = require('./hmac');

function createApp({ secret }) {
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

    res.json({ ok: true });
  });

  return app;
}

module.exports = { createApp };
