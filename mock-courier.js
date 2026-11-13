// Fake courier API for local runs. It fails on purpose so the worker's retry logic gets exercised.
require('dotenv').config({ quiet: true });
const express = require('express');

// `Number(x) || fallback` would turn an explicit 0 into the fallback, and FAIL_RATE=0 must mean 0.
function rate(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : Number(value);
}

const port = Number(process.env.COURIER_PORT) || 4000;
const failRate = rate('FAIL_RATE', 0.2);
const rateLimitRate = rate('RATE_LIMIT_RATE', 0.1);
const hangRate = rate('HANG_RATE', 0.1);

const shipments = [];
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.on('finish', () => console.log(`[courier] ${req.method} ${req.originalUrl} -> ${res.statusCode}`));
  next();
});

// One roll decides the outcome, so the rates are exact shares of all requests.
function chaos(req, res, next) {
  const roll = Math.random();
  if (roll < failRate) {
    return res.status(500).json({ error: 'internal error' });
  }
  if (roll < failRate + rateLimitRate) {
    res.set('Retry-After', '2');
    return res.status(429).json({ error: 'rate limited' });
  }
  req.hang = roll < failRate + rateLimitRate + hangRate;
  next();
}

app.get('/shipments', chaos, (req, res) => {
  const { reference } = req.query;
  res.json(reference ? shipments.filter((s) => s.reference === reference) : shipments);
});

app.post('/shipments', chaos, (req, res) => {
  const { reference, address, items } = req.body ?? {};
  if (!reference) {
    return res.status(400).json({ error: 'reference is required' });
  }

  const shipment = { shipmentId: `shp_${shipments.length + 1}`, reference: String(reference), address, items };
  shipments.push(shipment);
  const body = { shipmentId: shipment.shipmentId, reference: shipment.reference };

  if (req.hang) {
    // The shipment already exists, but the caller times out first and cannot know that.
    console.log(`[courier] created ${shipment.shipmentId} for ${shipment.reference}, hanging 10s`);
    setTimeout(() => res.status(201).json(body), 10000);
    return;
  }
  res.status(201).json(body);
});

app.listen(port, () => {
  console.log(`[courier] listening on port ${port} (fail=${failRate} 429=${rateLimitRate} hang=${hangRate})`);
});
