const config = require('./config');

const TIMEOUT_MS = 3000;

// kind is one of: retryable (5xx, network), rate_limited (429), timeout, fatal (other 4xx).
function courierError(kind, message, extra = {}) {
  return Object.assign(new Error(message), { kind }, extra);
}

async function request(path, options = {}) {
  let res;
  let text;
  try {
    // AbortSignal.timeout is AbortController with a built-in timer. It also covers reading
    // the body, so a courier that sends headers and then stalls still times out.
    res = await fetch(config.courierUrl + path, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = await res.text();
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw courierError('timeout', `no response within ${TIMEOUT_MS}ms`);
    }
    throw courierError('retryable', `network error: ${err.cause?.code ?? err.message}`);
  }

  if (res.ok) return JSON.parse(text);
  if (res.status === 429) {
    // Only the seconds form of Retry-After is handled. A missing or HTTP-date value waits 1s.
    const seconds = Number(res.headers.get('Retry-After')) || 1;
    throw courierError('rate_limited', '429 rate limited', { retryAfterMs: seconds * 1000 });
  }
  if (res.status >= 500) {
    throw courierError('retryable', `${res.status} ${text}`);
  }
  throw courierError('fatal', `${res.status} ${text}`);
}

function findShipments(reference) {
  return request(`/shipments?reference=${encodeURIComponent(reference)}`);
}

function createShipment(reference, order) {
  return request('/shipments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference, address: order.shipping_address, items: order.line_items }),
  });
}

module.exports = { findShipments, createShipment };
