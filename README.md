# order-shipment-sync

A small Node.js service that receives `orders/create` webhooks from a store and creates a
shipment for each order with an unreliable courier API, exactly once.

The courier rate-limits, returns 5xx, and sometimes times out after it has already created the
shipment. The store can deliver the same webhook more than once. The service has to survive all
of that without ever shipping an order twice.

## Run it

Needs Node.js 20 or newer. No database server, no Redis: SQLite is a file and the queue lives in it.

```bash
npm install
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
npm run dev                 # mock courier on :4000, API + worker on :3000
```

In a second terminal:

```bash
npm run send-webhook        # one signed webhook, the same one again, then the same order with a new webhook id
```

You should see three `200` responses (the last two with `"duplicate": true`) and, in the first
terminal, `[worker] order ...: created shipment shp_1`. With the default failure rates you may see
retries first.

`npm run dev` refuses to start if `WEBHOOK_SECRET` is missing. That is on purpose (see below).

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Mock courier and API + worker together. Ctrl+C stops both. |
| `npm start` | API + worker only (port `PORT`, default 3000) |
| `npm run courier` | Mock courier only (port `COURIER_PORT`, default 4000) |
| `npm run send-webhook` | Sends a signed webhook and two duplicates |
| `npm run reconcile` | Finds orders with no confirmed shipment and fixes them. Safe to run from cron. |
| `npm run dead:list` | Lists jobs that gave up |
| `npm run dead:replay -- <jobId>` | Puts a dead job back in the queue with fresh attempts |
| `npm test` | Runs the tests (`node --test`) |

### Settings (`.env`)

| Variable | Default | Used by |
|---|---|---|
| `PORT` | `3000` | API |
| `DB_PATH` | `data.db` | API, worker, scripts |
| `WEBHOOK_SECRET` | none, required | API, `send-webhook` |
| `COURIER_URL` | `http://localhost:4000` | worker, reconcile |
| `MAX_ATTEMPTS` | `5` | worker |
| `COURIER_PORT` | `4000` | mock courier |
| `FAIL_RATE` / `RATE_LIMIT_RATE` / `HANG_RATE` | `0.2` / `0.1` / `0.1` | mock courier. Set all to `0` for a predictable demo. |

## Send a signed webhook by hand

The signature is the base64 HMAC-SHA256 of the raw body, in the `X-Shop-Hmac-Sha256` header.

```bash
SECRET=$(grep '^WEBHOOK_SECRET=' .env | cut -d= -f2-)
BODY='{"id":1001,"shipping_address":{"city":"Jaipur"},"line_items":[{"sku":"A1","quantity":1}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

curl -i -X POST localhost:3000/webhooks/orders-create \
  -H "Content-Type: application/json" \
  -H "X-Shop-Hmac-Sha256: $SIG" \
  -H "X-Shop-Webhook-Id: wh-1001" \
  --data "$BODY"
```

Run the same `curl` again for the duplicate: `200 {"ok":true,"duplicate":true}`. Change one
character of `$BODY` without re-signing and you get `401`.

Windows PowerShell 5.1 has no `openssl` by default. This does the same (it signs the exact file
bytes it sends):

```powershell
$secret = (Select-String -Path .env -Pattern '^WEBHOOK_SECRET=(.*)$').Matches[0].Groups[1].Value
$f = "$env:TEMP\order.json"; [IO.File]::WriteAllText($f, '{"id":1001}')
$sig = [Convert]::ToBase64String([Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($secret)).ComputeHash([IO.File]::ReadAllBytes($f)))
curl.exe -i -X POST localhost:3000/webhooks/orders-create -H "Content-Type: application/json" -H "X-Shop-Hmac-Sha256: $sig" -H "X-Shop-Webhook-Id: wh-1001" --data-binary "@$f"
```

## How it works

```
store --webhook--> POST /webhooks/orders-create
                     1. check HMAC over the raw bytes          -> 401 if wrong
                     2. parse JSON, need order id + webhook id -> 400 if missing
                     3. one transaction: webhook_events + orders + jobs
                     4. 200 (duplicate: true if nothing new was stored)

worker (same process, polls every 1s)
                     claim one due job (single UPDATE ... RETURNING)
                     GET /shipments?reference=<orderId>
                       1 found     -> adopt it, order shipped
                       2+ found    -> order needs_review, log loudly
                       none        -> POST /shipments, order shipped
                     on error      -> retry with backoff / wait Retry-After / dead

reconcile (cron)     release jobs stuck in processing
                     look up orders with no confirmed shipment, adopt or re-queue
                     never POSTs
```

Files:

```
mock-courier.js         the flaky courier from the assignment, with failure rates from env
src/config.js           env + defaults
src/db.js               opens SQLite (WAL), creates the three tables
src/hmac.js             verifySignature(rawBody, header, secret)
src/app.js              express app: /health and the webhook route
src/courier.js          findShipments, createShipment, 3s timeout, error kinds
src/worker.js           claim -> look up -> adopt or create -> done / retry / dead
src/server.js           opens the DB, starts the API and the worker
scripts/                send-webhook, reconcile, dead-jobs, dev
test/                   db, webhook, worker, reconcile
```

Tables:

- `webhook_events(webhook_id PK, order_id, received_at)`: every delivery we accepted
- `orders(order_id PK, payload, status, shipment_id, ...)`: `pending`, `shipped`, `failed`, `needs_review`
- `jobs(id, order_id UNIQUE, status, attempts, rate_limit_waits, run_at, locked_at, last_error, ...)`: `queued`, `processing`, `done`, `dead`

## Design decisions

**Queue: a `jobs` table in the same SQLite DB, polled by an in-process worker.**
The order row and its job row are inserted in one transaction, so a crash can never leave an order
stored with nothing to ship it. With Redis or BullMQ that gap exists: the DB write and the queue
push are two separate systems. It also means zero setup for whoever runs this.
Trade-off: one process, up to 1s polling delay, and SQLite allows one writer at a time. That is fine
for one store's order volume and not fine for many workers (see "What I'd do next").

**Incoming idempotency: two unique keys, not "check then insert".**
`webhook_events.webhook_id` catches the store redelivering the same webhook. `orders.order_id`
catches the same order arriving under a new webhook id. The second one matters because
`X-Shop-Webhook-Id` is not covered by the signature, so someone could replay a captured, validly
signed body with a fresh id. Inserts use `ON CONFLICT DO NOTHING` and check `changes`, so two
identical requests arriving at the same moment cannot both get through. A check-then-insert can
let both through.
Duplicates get `200`, not `409`. Any non-2xx would make the store keep redelivering something we
already have.

**Outgoing idempotency: look up before every create.**
The courier is not idempotent and can create a shipment and then time out. So a timeout tells us
nothing. Before every `POST /shipments` the worker calls `GET /shipments?reference=<orderId>` and
adopts what it finds. A retry never POSTs blindly. If the courier already has two or more shipments
for one order, we do not guess: the order goes to `needs_review`.

**HMAC over the raw bytes, compared with `crypto.timingSafeEqual`.**
The webhook route uses `express.raw`, not `express.json`. Parsing and re-serializing JSON can change
spacing or key order, and then a genuine webhook would fail the check. The signature is checked
before the body is parsed. `timingSafeEqual` takes the same time whether the first character is
wrong or the last, so the signature cannot be guessed by timing. Lengths are compared first because
`timingSafeEqual` throws on different lengths, and that would turn a junk header into a 500.

**The webhook handler does no courier work.** It does three inserts and returns, in about 1ms. The
assignment asks for under 1 second. All courier calls happen in the worker.

**Retries.**

| What the courier did | What the worker does |
|---|---|
| 5xx or network error | attempt + 1, retry after 2s, 4s, 8s, 16s... (+/-20% jitter, max 60s) |
| No answer in 3s | Same as 5xx. We do not know if the shipment was created, and the next attempt's lookup finds out. |
| 429 | Wait exactly `Retry-After`. Does not count as an attempt, up to 20 waits per job. After that a 429 counts like a 5xx, so a courier that rate-limits forever cannot keep a job alive forever. |
| Other 4xx | Our request is wrong and retrying will not help. The job is dead at once. |
| `MAX_ATTEMPTS` (5) used up | Job `dead`, order `failed`, `last_error` kept |

Jitter stops a batch of orders that failed together (for example during a courier outage) from all
retrying at the same moment.

**Dead jobs are parked, never deleted.** `jobs.status = 'dead'` with the last error. `dead:list`
shows them and `dead:replay` puts one back with attempts reset. Replay is safe even if the courier
did create the shipment, because the worker looks up first.

**Reconciliation never creates shipments.** `reconcile` only looks up and re-queues, so the worker
stays the single place that POSTs. It:
- releases jobs stuck in `processing` for more than 5 minutes (the worker crashed mid-job)
- looks up `pending` orders with no active job (should not happen, which is why it checks) and
  `failed` orders. Found at the courier -> `shipped`. Nothing found -> a pending order is re-queued.
  A failed order stays dead for a human to replay, so a cron job does not revive parked jobs forever.

The `failed` case is the one the assignment hints at: the last attempt created the shipment, timed
out, and then the job ran out of attempts. Reconcile finds it and marks the order shipped without a
second POST. This happened for real in a 25-order test run with the default failure rates.

**Fail fast without `WEBHOOK_SECRET`.** Without a secret every webhook would get 401. A startup
error says why straight away, and there is no default secret in the code to leak.

**Small things.**
- Times are Unix milliseconds passed in from JS, not SQL defaults. The worker takes a clock
  function, so tests can move time forward instead of waiting for backoff.
- WAL mode lets `reconcile` and `dead-jobs` read the DB from another process while the server writes.
- `CHECK` constraints on the status columns, so a typo fails loudly instead of leaving a job no
  query will ever pick up.
- Three dependencies: `express`, `better-sqlite3`, `dotenv`. Courier calls use the built-in `fetch`
  with `AbortSignal.timeout`. `npm run dev` is a short `child_process` script, not `concurrently`.

## Tests

```bash
npm test
```

28 tests with `node:test`, no network. The worker and reconcile tests use a fake courier that
records every call, so they can assert that a POST did or did not happen.

- **Webhook** (`test/webhook.test.js`): valid signature, wrong secret, body changed by one byte,
  missing header, a different-length signature does not crash, bad JSON, missing order id, missing
  webhook id, same webhook id twice -> 1 order and 1 job, same order with a new webhook id -> 1 order
  and 1 job.
- **Worker** (`test/worker.test.js`): happy path; existing shipment adopted without a POST; 2+
  shipments -> `needs_review`; **courier creates then times out -> next attempt adopts it, POST
  called exactly once**; 429 waits `Retry-After` and does not use an attempt; always 500 -> backoff,
  then dead after `MAX_ATTEMPTS`; 4xx -> dead at once; replay puts a dead job back and it ships.
- **Reconcile** (`test/reconcile.test.js`): a failed order whose shipment exists is adopted without
  a POST, a pending order with nothing at the courier is re-queued, a failed order with nothing found
  stays dead, a stuck job is released but a recently locked one is not.
- **Schema** (`test/db.test.js`): tables exist and the unique constraints reject duplicates.

Manual end-to-end check with the real failure rates: run `npm run dev`, send 20 or so webhooks, wait
a minute, then confirm with `curl localhost:4000/shipments` that every reference has exactly one
shipment. To see a dead job, set `FAIL_RATE=1` and `MAX_ATTEMPTS=2`. To see reconcile adopt one, set
`HANG_RATE=1` and `MAX_ATTEMPTS=1` and do not restart the courier in between: it keeps shipments
in memory.

## Known gaps

- **Lookup-then-create is not atomic.** With one worker and one job per order (a unique key), only
  one attempt can be in flight for an order, so it is safe here. With many workers it needs a
  per-order lock, or an idempotency key on the courier side.
- **A job held longer than 5 minutes is treated as crashed.** A worker that is alive but stuck for
  that long could overlap with the released retry. Courier calls time out after 3s, so this would
  need something else to hang.
- **No replay window.** A captured, validly signed webhook can be sent again later. It cannot
  create a second shipment (the order id is unique), but there is no timestamp check.
- **`Retry-After` is read as seconds only.** The HTTP-date form falls back to 1 second.
- **Failed orders are looked up on every reconcile run** until someone replays them.
- **Webhook body limit is Express's default 100kb.** A very large order would get 413.

## What I'd do next with another day

- Postgres with `SELECT ... FOR UPDATE SKIP LOCKED` (or BullMQ on Redis) to run several workers
- A per-order lock around lookup + create, and an idempotency key if the courier supports one
- Metrics and alerts on dead jobs and `needs_review` orders, not just log lines
- Cancel duplicate shipments automatically if the courier allows it
- Reject webhooks with an old timestamp, to stop replays of old signed requests
- Structured JSON logs with the order id on every line
- A small `docker-compose.yml` for one-command runs without Node installed

## Deliberately left out

- Auth on the admin scripts, a UI, deployment
- Several stores or per-merchant secrets
- Order updates and cancellations (only `orders/create`)
- Full validation of address and line items. The courier gets what the store sent.
