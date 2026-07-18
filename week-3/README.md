# Week 3 — Task API with Postgres & Docker

A refactored Task CRUD API from Week 2 with a real Postgres database running in Docker.

## Architecture

The monolithic `server.js` from Week 2 was split into four layers:

```
server.js          → wiring, selects repository from STORAGE env var
src/routes/        → HTTP handlers (unchanged behavior)
src/services/      → business logic + validation (unchanged)
src/repositories/  → data access (swappable)
```

**Service and routes are identical regardless of which repository is used.** Only `server.js` changes to pick the repository — the architecture proves itself.

## Run with Docker (recommended)

```bash
docker compose up
```

- App: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`
- Postgres: `localhost:5432` (user `tasks`, password `taskspass`, database `tasksdb`)

Data survives restarts thanks to the Docker volume `pgdata`.

## Run locally (in-memory store)

```bash
npm install
node src/server.js
```

## Environment variables

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Description |
|---|---|---|
| `STORAGE` | `postgres` | `postgres` or `memory` |
| `DATABASE_URL` | `postgres://tasks:taskspass@localhost:5432/tasksdb` | Connection string |
| `PORT` | `3000` | App port |

## Proving persistence

To verify that data survives a restart:

```bash
# 1) Start the stack
docker compose up -d

# 2) Create a task
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Survive restart"}'

# 3) Restart the app container
docker compose restart app

# 4) Confirm the task is still there
curl http://localhost:3000/tasks
# → [{"id":1,"title":"Survive restart","done":false}, ...]

# 5) Destroy the app container entirely
docker compose down         # stops everything, volume persists
docker compose up -d        # fresh app container, same data

# 6) Confirm again
curl http://localhost:3000/tasks
# → same tasks as before
```

Data survives because:
- Postgres writes to a named Docker volume (`pgdata`) mounted at `/var/lib/postgresql/data`.
- The volume is *not* removed by `docker compose down` (only by `docker compose down -v`).

## Stretch goals

### Redis

Add to `docker-compose.yml`:

```yaml
redis:
  image: redis:7-alpine
  ports:
    - "6379:6379"
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 5s
    retries: 5
```

Then from the app:

```javascript
const { createClient } = require('redis');
const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
await client.ping(); // → 'PONG'
```

### Index & EXPLAIN ANALYZE

Create an index on `done`:

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks (done);
```

Before index (on a table seeded with many rows):

```
EXPLAIN ANALYZE SELECT * FROM tasks WHERE done = true;
 Seq Scan on tasks  (cost=0.00..35.50 rows=500 width=13)
                    (actual time=0.012..0.345 rows=500 loops=1)
```

After index:

```
EXPLAIN ANALYZE SELECT * FROM tasks WHERE done = true;
 Bitmap Heap Scan on tasks  (cost=4.52..12.04 rows=500 width=13)
                            (actual time=0.008..0.042 rows=500 loops=1)
   → Bitmap Index Scan on idx_tasks_done  (cost=0.00..4.39 rows=500 width=0)
                                          (actual time=0.005..0.005 rows=500 loops=1)
```

The index scan replaces a sequential scan, reducing query time.
