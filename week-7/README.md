# Week 7 — Report Pipeline as a Background Job

"Generate a report" — the classic SaaS background job. This week's pipeline ties the last four weeks into one feature: **query your data with SQL (week 3)**, **render a PDF report (week 5's corpus)**, and **generate it as a background job (week 6's A7 pattern)** — on demand now, on a schedule for stretch.

```
POST /jobs ──202──> SQLite queue ──claim──> worker.js
        <── Location: /jobs/:id                    │
GET /jobs/:id ──completed: { summary, artifact: { download_url } }
GET /artifacts/:id ──the PDF───────────────────────┘
```

## The three lessons, in one feature

### 1. SQL aggregation (week 3)
The worker answers the report with real `GROUP BY` queries over the week-5 books corpus (1,000 books, 50 categories, imported from `../week-5/data/books.jsonl`):

- totals: book count, category count, avg/min/max price, avg rating, stock
- books per category (count, avg price, avg rating)
- rating distribution and a £10 price histogram
- top-10 most expensive, cheapest, and 5-star priciest lists

Scoping works too: `payload: { "category": "Fiction" }` filters every query to one category.

### 2. Artifacts: store and link, don't pass 20 MB around (week 5's lesson applied to jobs)
The PDF is **stored** in an `artifacts` table the moment it's rendered. The job result never carries the bytes — it carries a link:

```json
"result": {
  "summary": { "scope": "all", "book_count": 1000, "avg_price": 35.07, ... },
  "artifact": {
    "artifact_id": "0f9c...",
    "filename": "books-report-all-books-1785620662769.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 13891,
    "download_url": "/artifacts/0f9c..."
  }
}
```

`GET /artifacts/:id` streams the file with `Content-Disposition: attachment`. Small JSON in, big bytes stored once.

### 3. Background jobs (week 6's A7 pattern, unchanged)
- `POST /jobs` validates, inserts a `queued` row, answers `202 Accepted` instantly
- `worker.js` atomically **claims** one job (`UPDATE ... RETURNING *`), renders with progress (0–100), writes the result guarded by `WHERE status = 'running'`
- **Idempotency**: replay an `Idempotency-Key` and you get the existing job back (UNIQUE constraint)
- **Retries**: failures requeue with exponential backoff, `max_attempts` (default 3)
- **Alerts**: exhausted retries → `alerts` table + stderr (+ optional webhook)
- **Crash recovery**: a dead worker's lease expires; another worker reclaims and re-runs the job — the artifact write is idempotent
- Demo failures with `payload: { "failOnce": true }` (retry succeeds) and `{ "failAlways": true }` (ends failed + alerts)

## Install & run

```bash
npm install
npm run import    # load ../week-5/data/books.jsonl into SQLite (books table)
npm start         # API on http://localhost:3000
npm run worker    # worker process (second terminal)
```

Or all in one: `npm run dev`.

### Env vars

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3000` | API port |
| `DB_PATH` | `./reports.db` | SQLite database file (queue + books + artifacts + schedules) |
| `BOOKS_DATA` | `../week-5/data/books.jsonl` | Corpus to import |
| `POLL_MS` | `500` | Worker poll interval |
| `LEASE_SECONDS` | `30` | Job lease; longer without a heartbeat = dead worker |
| `HEARTBEAT_MS` | `2000` | Lease heartbeat interval |
| `ALERT_WEBHOOK_URL` | unset | Alert webhook (e.g. Slack/Teams) |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jobs` | Submit a report job → `202 Accepted` + `Location` header |
| GET | `/jobs/:id` | Status, progress, attempts, result (summary + artifact link) |
| GET | `/jobs?status=queued\|running\|completed\|failed` | List jobs |
| GET | `/artifacts/:id` | Download the stored PDF |
| POST | `/schedules` | Create a recurring report schedule (stretch) |
| GET | `/schedules` | List schedules + `last_enqueued_at` |
| GET | `/alerts` | Job failures past retries |
| GET | `/docs` | Swagger UI |

### Example

```bash
# accept fast (the whole report — SQL + PDF — runs in the worker)
curl -i -X POST http://localhost:3000/jobs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: weekly-1' \
  -d '{"type":"report","payload":{}}'
# HTTP/1.1 202 Accepted
# Location: /jobs/<uuid>

# poll for the result
curl http://localhost:3000/jobs/<uuid>
# { "status": "completed", "attempts": 1, "progress": 100,
#   "result": { "book_count": 1000, ...,
#               "artifact": { "download_url": "/artifacts/<uuid>", ... } } }

# download the PDF — store and link, not pass-the-bytes
curl -OJ http://localhost:3000/artifacts/<uuid>
```

Category-scoped report:

```bash
curl -X POST http://localhost:3000/jobs -H 'Content-Type: application/json' \
  -d '{"type":"report","payload":{"category":"Fiction"}}'
```

## Stretch: recurring reports

`POST /schedules` with `{ "kind": "report", "every": 3600, "payload": {} }` registers a recurring report. On every tick the worker checks `schedules` for rows whose `last_enqueued_at + every_seconds` is in the past, enqueues a report job through the **same** queue (so scheduled runs get the same retries, idempotency and alerting as on-demand ones), and stamps `last_enqueued_at`.

```bash
curl -X POST http://localhost:3000/schedules -H 'Content-Type: application/json' \
  -d '{"kind":"report","every":3600,"payload":{"category":"Fiction"}}'
```

## Tests

```bash
npm test
```

End-to-end tests spawn the real server + worker + importer on a temp database with a bundled fixture (`data/sample-books.jsonl`, a slice of the real corpus) and verify: instant `202`, background completion with a stored artifact, PDF download bytes match the linked size, category-scoped aggregation, idempotency-key dedupe, retry-then-succeed, fail-then-alert, scheduler auto-enqueue, and a no-data guard.

## Project structure

```
week-7/
├── db.js          # queue schema (week 6) + books, artifacts, schedules tables
├── server.js      # API: /jobs, /jobs/:id, /artifacts/:id, /schedules, /alerts
├── worker.js      # claim → SQL aggregation → PDF → artifact → result; schedules
├── reports.js     # the week-3 lesson: GROUP BY queries + pdfkit rendering
├── import.js      # week-5 books.jsonl → SQLite books table
├── alert.js       # week-6 alerting (table + stderr + webhook)
├── openapi.json   # Swagger spec
├── data/          # test fixture (slice of the real corpus)
└── tests/         # 9 end-to-end tests
```

The report renders: a cover header with generated-at/scope, key metrics, top-15 categories table, rating and price bar charts, and most-expensive / cheapest / 5-star top-10 tables — with page numbers and a footer on every page.
