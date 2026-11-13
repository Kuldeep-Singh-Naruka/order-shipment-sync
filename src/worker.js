const config = require('./config');

const POLL_MS = 1000;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;
// 429s do not use up attempts, but a courier that rate-limits forever must not keep a job alive
// forever. After this many waits a 429 counts as a normal failed attempt.
const MAX_RATE_LIMIT_WAITS = 20;

// One UPDATE both picks and locks the job, so two pollers can never claim the same one.
function claimJob(db, now) {
  return db.prepare(`
    UPDATE jobs SET status = 'processing', locked_at = ?, updated_at = ?
    WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at LIMIT 1)
    RETURNING id, order_id, attempts, rate_limit_waits`).get(now, now, now);
}

// 2s, 4s, 8s, 16s... capped at 60s, with +/-20% jitter so jobs that failed together
// do not all retry at the same moment.
function backoff(attempts) {
  const delay = BASE_DELAY_MS * 2 ** (attempts - 1);
  return Math.round(Math.min(delay, MAX_DELAY_MS) * (0.8 + Math.random() * 0.4));
}

function finish(db, job, orderStatus, shipmentId, now) {
  db.transaction(() => {
    db.prepare('UPDATE orders SET status = ?, shipment_id = ?, updated_at = ? WHERE order_id = ?')
      .run(orderStatus, shipmentId, now, job.order_id);
    db.prepare("UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(now, job.id);
  })();
}

function requeue(db, job, { attempts, rateLimitWaits, runAt, error, now }) {
  db.prepare(`
    UPDATE jobs SET status = 'queued', attempts = ?, rate_limit_waits = ?, run_at = ?,
      locked_at = NULL, last_error = ?, updated_at = ?
    WHERE id = ?`).run(attempts, rateLimitWaits, runAt, error, now, job.id);
}

function handleFailure(db, job, err, now) {
  const tag = `[worker] order ${job.order_id}`;

  if (err.kind === 'rate_limited' && job.rate_limit_waits < MAX_RATE_LIMIT_WAITS) {
    console.log(`${tag}: rate limited, waiting ${err.retryAfterMs}ms (attempt not counted)`);
    return requeue(db, job, {
      attempts: job.attempts,
      rateLimitWaits: job.rate_limit_waits + 1,
      runAt: now + err.retryAfterMs,
      error: err.message,
      now,
    });
  }

  const attempts = job.attempts + 1;
  if (err.kind === 'fatal' || attempts >= config.maxAttempts) {
    console.error(`${tag}: DEAD after ${attempts} attempt(s): ${err.message}`);
    return db.transaction(() => {
      db.prepare("UPDATE jobs SET status = 'dead', attempts = ?, locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, err.message, now, job.id);
      db.prepare("UPDATE orders SET status = 'failed', updated_at = ? WHERE order_id = ?").run(now, job.order_id);
    })();
  }

  // A timeout is retried like a 5xx, but we do not know if the shipment was created.
  // That is fine: the next attempt starts with a lookup and adopts it if it exists.
  const delay = backoff(attempts);
  console.error(`${tag}: ${err.kind ?? 'error'} (attempt ${attempts}/${config.maxAttempts}), retry in ${delay}ms: ${err.message}`);
  requeue(db, job, { attempts, rateLimitWaits: job.rate_limit_waits, runAt: now + delay, error: err.message, now });
}

async function processJob(db, courier, job, clock) {
  // Look up before creating, every time. An earlier attempt may have created the shipment and
  // then timed out, and the courier would happily create a second one.
  const existing = await courier.findShipments(job.order_id);

  if (existing.length > 1) {
    const ids = existing.map((s) => s.shipmentId).join(', ');
    console.error(`[worker] NEEDS REVIEW: order ${job.order_id} has ${existing.length} shipments (${ids})`);
    return finish(db, job, 'needs_review', null, clock());
  }

  let shipment = existing[0];
  if (shipment) {
    console.log(`[worker] order ${job.order_id}: adopted existing shipment ${shipment.shipmentId}`);
  } else {
    const order = JSON.parse(db.prepare('SELECT payload FROM orders WHERE order_id = ?').pluck().get(job.order_id));
    shipment = await courier.createShipment(job.order_id, order);
    console.log(`[worker] order ${job.order_id}: created shipment ${shipment.shipmentId}`);
  }
  finish(db, job, 'shipped', shipment.shipmentId, clock());
}

// Returns true if a job was claimed, so the loop can drain the queue before sleeping.
// The clock is a parameter so tests can move time forward instead of waiting. It is read again
// after the courier call: after a 3s timeout, "now + 2s backoff" must not already be in the past.
async function runOnce(db, courier, clock = Date.now) {
  const job = claimJob(db, clock());
  if (!job) return false;

  try {
    await processJob(db, courier, job, clock);
  } catch (err) {
    handleFailure(db, job, err, clock());
  }
  return true;
}

function startWorker(db, courier) {
  async function tick() {
    try {
      while (await runOnce(db, courier));
    } catch (err) {
      // A DB error (e.g. locked by a script for too long) must not kill the loop.
      console.error(`[worker] poll failed: ${err.message}`);
    }
    setTimeout(tick, POLL_MS);
  }
  console.log(`[worker] polling every ${POLL_MS}ms, max ${config.maxAttempts} attempts`);
  tick();
}

module.exports = { runOnce, startWorker };
