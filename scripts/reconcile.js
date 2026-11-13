// Safe to run from cron. It only looks up shipments and re-queues jobs. It never POSTs, so the
// worker stays the single place that creates shipments.
const { openDb } = require('../src/db');
const courier = require('../src/courier');
const { finish } = require('../src/worker');

// Far above the longest a live worker holds a job (two 3s courier calls). Releasing a job that
// is still being worked on could let two attempts run the lookup-then-create at once.
const STUCK_MS = 5 * 60 * 1000;
const PENDING_MS = 5 * 60 * 1000;

async function reconcile(db, courierApi, now = Date.now()) {
  const summary = { released: 0, adopted: 0, requeued: 0, stillFailed: 0, needsReview: 0, lookupErrors: 0 };

  // The worker crashed mid-job: put it back so the worker picks it up (lookup first, as always).
  summary.released = db.prepare(`
    UPDATE jobs SET status = 'queued', locked_at = NULL, run_at = ?, updated_at = ?
    WHERE status = 'processing' AND locked_at < ?`).run(now, now, now - STUCK_MS).changes;

  // Orders with no confirmed shipment that the worker is not going to touch:
  // pending with no active job (should not happen, which is why we check), and failed (dead job),
  // which may still have a shipment if its last attempt created one and then timed out.
  const candidates = db.prepare(`
    SELECT o.order_id, o.status, j.id
    FROM orders o JOIN jobs j USING (order_id)
    WHERE (o.status = 'pending' AND j.status NOT IN ('queued', 'processing') AND o.updated_at < ?)
       OR (o.status = 'failed' AND j.status = 'dead')`).all(now - PENDING_MS);

  for (const order of candidates) {
    const job = { id: order.id, order_id: order.order_id };
    let found;
    try {
      found = await courierApi.findShipments(order.order_id);
    } catch (err) {
      // Leave it for the next run.
      console.error(`[reconcile] order ${order.order_id}: lookup failed: ${err.message}`);
      summary.lookupErrors++;
      continue;
    }

    if (found.length > 1) {
      console.error(`[reconcile] NEEDS REVIEW: order ${order.order_id} has ${found.length} shipments`);
      finish(db, job, 'needs_review', null, now);
      summary.needsReview++;
    } else if (found.length === 1) {
      console.log(`[reconcile] order ${order.order_id}: adopted shipment ${found[0].shipmentId}`);
      finish(db, job, 'shipped', found[0].shipmentId, now);
      summary.adopted++;
    } else if (order.status === 'pending') {
      db.prepare(`
        UPDATE jobs SET status = 'queued', attempts = 0, rate_limit_waits = 0, run_at = ?,
          locked_at = NULL, updated_at = ?
        WHERE id = ?`).run(now, now, job.id);
      summary.requeued++;
    } else {
      // A dead job stays parked. Re-queueing it here would make a cron job revive it forever.
      summary.stillFailed++;
    }
  }
  return summary;
}

async function main() {
  const s = await reconcile(openDb(), courier);
  console.log(
    `[reconcile] released ${s.released} stuck job(s), adopted ${s.adopted}, re-queued ${s.requeued}, ` +
      `still failed ${s.stillFailed}, needs review ${s.needsReview}, lookup errors ${s.lookupErrors}`,
  );
}

if (require.main === module) main();

module.exports = { reconcile };
