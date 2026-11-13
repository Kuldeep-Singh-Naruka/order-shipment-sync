// npm run dead:list             shows jobs that gave up
// npm run dead:replay -- <id>   puts one back in the queue with a fresh set of attempts
const { openDb } = require('../src/db');

function listDeadJobs(db) {
  return db.prepare(`
    SELECT id, order_id, attempts, last_error, datetime(updated_at / 1000, 'unixepoch') AS died_at
    FROM jobs WHERE status = 'dead' ORDER BY id`).all();
}

// Safe to replay even if the courier did create the shipment: the worker looks up first.
function replayJob(db, id, now = Date.now()) {
  return db.transaction(() => {
    const job = db.prepare(`
      UPDATE jobs SET status = 'queued', attempts = 0, rate_limit_waits = 0, run_at = ?, updated_at = ?
      WHERE id = ? AND status = 'dead'
      RETURNING order_id`).get(now, now, id);
    if (!job) return false;
    db.prepare("UPDATE orders SET status = 'pending', updated_at = ? WHERE order_id = ?").run(now, job.order_id);
    return true;
  })();
}

function main() {
  const [command, id] = process.argv.slice(2);
  const db = openDb();

  if (command === 'list') {
    const jobs = listDeadJobs(db);
    if (jobs.length === 0) console.log('[dead-jobs] no dead jobs');
    else console.table(jobs);
  } else if (command === 'replay' && id) {
    if (replayJob(db, Number(id))) {
      console.log(`[dead-jobs] job ${id} is queued again`);
    } else {
      console.error(`[dead-jobs] job ${id} not found or not dead`);
      process.exitCode = 1;
    }
  } else {
    console.error('usage: node scripts/dead-jobs.js list | replay <jobId>');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { replayJob };
