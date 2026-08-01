# Background Jobs API

Move the slow operation — an AI summarization call — out of the request. The endpoint answers instantly with `202 Accepted`, a separate worker process does the work in the background, and a status endpoint reports the result.

This is the professional pattern for anything slow: **accept fast, work in the background, report status.**

## How it works

```
POST /jobs ──202──> SQLite queue (jobs table) ──poll──> worker.js (separate process)
        <── Location: /jobs/:id                        │
GET /jobs/:id ──status + result<───────────────────────┘
```

1. `POST /jobs` validates, inserts a row into the `jobs` table (`status = queued`), and replies `202 Accepted` with the job id and a `Location` header. The HTTP request never waits for the AI call.
2. `worker.js` (a separate process) polls the queue, atomically **claims** one job (`UPDATE ... RETURNING *`), runs the slow AI call, and writes the result.
3. `GET /jobs/:id` reports the current status, progress (0–100), attempt count, and the final result or error.

## The non-negotiables (all implemented and tested)

### 1. Jobs will run twice — idempotency
- **Idempotency key**: submit `Idempotency-Key: <key>` (or `idempotency_key` in the body) and a replay returns the existing job instead of enqueueing a duplicate. Enforced by a `UNIQUE` constraint, so even racing requests can't double-enqueue.
- **Crash recovery**: a worker holds a lease (`claimed_at`). If the worker dies mid-job, the lease expires and another worker **reclaims the job and runs it again** — the job runs twice. The result write is guarded with `WHERE ... AND status = 'running'`, so the second run's result is discarded if the first already completed. This is demonstrated by a test that plants a stale `running` job and watches it get reclaimed, re-run, and completed exactly once.

### 2. Jobs will fail — retries
- Each run increments `attempts`. On failure the job is requeued with **exponential backoff** (`2^attempts` seconds) and re-run, up to `max_attempts` (default 3).
- Demo it: `payload: { "failOnce": true }` fails the first attempt and succeeds on the retry.

### 3. Someone must find out — alerts
- When a job exhausts its retries it ends `failed` and an **alert** is raised: recorded in the `alerts` table (see `GET /alerts`), printed to stderr, and optionally POSTed to a webhook if `ALERT_WEBHOOK_URL` is set.
- Demo it: `payload: { "failAlways": true }` always fails.

## Install & run

```bash
npm install
npm start        # API server on http://localhost:3000
npm run worker   # worker process (run in a second terminal)
```

Or both at once: `npm run dev`.

### Env vars

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3000` | API port |
| `DB_PATH` | `./jobs.db` | SQLite database file |
| `AI_LATENCY_MS` | `2500` | Mock AI call duration |
| `OPENAI_API_KEY` | unset | Set to use the real OpenAI API instead of the mock |
| `POLL_MS` | `500` | Worker poll interval |
| `LEASE_SECONDS` | `30` | Job lease; longer than this without a heartbeat = dead worker |
| `HEARTBEAT_MS` | `2000` | Lease heartbeat interval |
| `ALERT_WEBHOOK_URL` | unset | Alert webhook (e.g. Slack/Teams) |

The AI call: with `OPENAI_API_KEY` set it streams a real chat completion. Without it, a mock that sleeps `AI_LATENCY_MS` and reports progress — same shape, zero cost.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jobs` | Submit a job → `202 Accepted` + `Location` header |
| GET | `/jobs/:id` | Status, progress, attempts, result/error |
| GET | `/jobs?status=queued\|running\|completed\|failed` | List jobs |
| GET | `/alerts` | Alerts (job failures past retries) |
| GET | `/docs` | Swagger UI |

### Example

```bash
# accept fast (returns in ms, not in the AI call's seconds)
curl -i -X POST http://localhost:3000/jobs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-key-1' \
  -d '{"type":"summarize","payload":{"prompt":"Summarize Dune in one paragraph."}}'
# HTTP/1.1 202 Accepted
# Location: /jobs/<uuid>

# poll for the result
curl http://localhost:3000/jobs/<uuid>
# { "id": "...", "status": "completed", "attempts": 1, "progress": 100,
#   "result": { "model": "mock-llm-1", "summary": "..." } }

# same key again → same job, no duplicate
curl -X POST http://localhost:3000/jobs -H 'Idempotency-Key: my-key-1' -d '{...}'
```

## Queue design notes

- **SQLite as the queue** — the `jobs` table *is* the queue: `queued` rows are claimable, `running` rows carry a lease, retries wait until `next_run_at`. No extra infrastructure. (At real scale you would swap this for Redis/BullMQ — same shapes: queue, worker, lease, retry, dead-letter → alert.)
- **Atomic claim** — one `UPDATE ... RETURNING *` moves a job to `running` and bumps `attempts`, so multiple workers can run safely.
- **WAL mode + busy timeout** — the API server and the worker are separate processes sharing one SQLite file; SQLite's locking keeps them safe.
- **Heartbeat** — the worker refreshes `heartbeat` while the AI call streams, so a slow-but-alive job isn't mistaken for a dead one.

## Tests

```bash
npm test
```

End-to-end tests spawn the real server + worker on a temp database and verify: instant `202`, background completion, idempotency-key dedupe, retry-then-succeed, fail-then-alert, stale-lease reclaim (double-run), and stale-lease exhaustion.
