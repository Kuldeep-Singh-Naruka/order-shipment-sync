const POLL_MS = 1000;

// One UPDATE both picks and locks the job, so two pollers can never claim the same one.
function claimJob(db, now) {
  return db.prepare(`
    UPDATE jobs SET status = 'processing', locked_at = ?, updated_at = ?
    WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at LIMIT 1)
    RETURNING id, order_id`).get(now, now, now);
}

function finish(db, job, orderStatus, shipmentId) {
  const now = Date.now();
  db.transaction(() => {
    db.prepare('UPDATE orders SET status = ?, shipment_id = ?, updated_at = ? WHERE order_id = ?')
      .run(orderStatus, shipmentId, now, job.order_id);
    db.prepare("UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(now, job.id);
  })();
}

async function processJob(db, courier, job) {
  // Look up before creating, every time. An earlier attempt may have created the shipment and
  // then timed out, and the courier would happily create a second one.
  const existing = await courier.findShipments(job.order_id);

  if (existing.length > 1) {
    const ids = existing.map((s) => s.shipmentId).join(', ');
    console.error(`[worker] NEEDS REVIEW: order ${job.order_id} has ${existing.length} shipments (${ids})`);
    return finish(db, job, 'needs_review', null);
  }

  let shipment = existing[0];
  if (shipment) {
    console.log(`[worker] order ${job.order_id}: adopted existing shipment ${shipment.shipmentId}`);
  } else {
    const order = JSON.parse(db.prepare('SELECT payload FROM orders WHERE order_id = ?').pluck().get(job.order_id));
    shipment = await courier.createShipment(job.order_id, order);
    console.log(`[worker] order ${job.order_id}: created shipment ${shipment.shipmentId}`);
  }
  finish(db, job, 'shipped', shipment.shipmentId);
}

// Returns true if a job was claimed, so the loop can drain the queue before sleeping.
async function runOnce(db, courier) {
  const job = claimJob(db, Date.now());
  if (!job) return false;

  try {
    await processJob(db, courier, job);
  } catch (err) {
    // Placeholder until chunk 6 adds attempts, backoff, Retry-After and dead jobs:
    // put the job back for the next poll (which looks up first, so no duplicate).
    console.error(`[worker] order ${job.order_id}: ${err.kind ?? 'error'}: ${err.message}`);
    const now = Date.now();
    db.prepare("UPDATE jobs SET status = 'queued', run_at = ?, locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ?")
      .run(now + POLL_MS, err.message, now, job.id);
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
  console.log(`[worker] polling every ${POLL_MS}ms`);
  tick();
}

module.exports = { runOnce, startWorker };
