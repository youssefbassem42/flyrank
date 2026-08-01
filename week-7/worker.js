const { init, run, get, all, DB_PATH } = require('./db');
const { buildReport } = require('./reports');
const { alert } = require('./alert');
const crypto = require('crypto');

const POLL_MS = Number(process.env.POLL_MS || 500);
const LEASE_SECONDS = Number(process.env.LEASE_SECONDS || 30);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 2000);

const REPORT_TYPES = new Set(['report']);

async function claim() {
  return get(`
    UPDATE jobs
    SET status = 'running',
        attempts = attempts + 1,
        started_at = COALESCE(started_at, datetime('now')),
        claimed_at = datetime('now'),
        heartbeat = datetime('now')
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued'
        AND (next_run_at IS NULL OR next_run_at <= datetime('now'))
      ORDER BY created_at, id
      LIMIT 1
    )
    RETURNING *
  `);
}

async function reclaimStale() {
  const stale = await all(
    "SELECT * FROM jobs WHERE status = 'running' AND claimed_at < datetime('now', ?)",
    [`-${LEASE_SECONDS} seconds`]
  );
  for (const job of stale) {
    if (job.attempts >= job.max_attempts) {
      await run(
        "UPDATE jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ? AND status = 'running'",
        ['Worker died mid-run and lease expired; no attempts left.', job.id]
      );
      alert(job, `Stale job reclaimed after lease expiry, attempts exhausted (${job.attempts}/${job.max_attempts})`);
    } else {
      await run(
        "UPDATE jobs SET status = 'queued', claimed_at = NULL, heartbeat = NULL, error = 'Worker died mid-run; requeued', next_run_at = datetime('now') WHERE id = ? AND status = 'running'",
        [job.id]
      );
      console.log(`[worker] job ${job.id} reclaimed (lease expired) — it will run again; artifact write is idempotent`);
    }
  }
}

async function handleFailure(job, err) {
  const message = err.message;
  if (job.attempts >= job.max_attempts) {
    const res = await run(
      "UPDATE jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ? AND status = 'running'",
      [message, job.id]
    );
    if (res.changes === 0) return;
    alert({ id: job.id, type: job.type }, `Job failed after ${job.attempts}/${job.max_attempts} attempts: ${message}`);
  } else {
    const backoff = Math.pow(2, job.attempts);
    const res = await run(
      "UPDATE jobs SET status = 'queued', claimed_at = NULL, heartbeat = NULL, next_run_at = datetime('now', ?) WHERE id = ? AND status = 'running'",
      [`+${backoff} seconds`, job.id]
    );
    if (res.changes === 0) return;
    console.log(`[worker] job ${job.id} failed on attempt ${job.attempts}/${job.max_attempts} — retrying in ${backoff}s: ${message}`);
  }
}

async function runReport(job, payload, onProgress) {
  const { artifact, summary } = await buildReport(payload, onProgress);

  const artifactId = crypto.randomUUID();
  await run(
    'INSERT INTO artifacts (id, job_id, filename, mime_type, size_bytes, content) VALUES (?, ?, ?, ?, ?, ?)',
    [artifactId, job.id, artifact.filename, artifact.mime_type, artifact.size_bytes, artifact.content]
  );

  const result = {
    ...summary,
    artifact: {
      artifact_id: artifactId,
      filename: artifact.filename,
      mime_type: artifact.mime_type,
      size_bytes: artifact.size_bytes,
      download_url: `/artifacts/${artifactId}`,
    },
  };
  return result;
}

async function processJob(job) {
  const payload = JSON.parse(job.payload);
  const heartbeat = setInterval(() => {
    run("UPDATE jobs SET heartbeat = datetime('now') WHERE id = ? AND status = 'running'", [job.id]);
  }, HEARTBEAT_MS);

  try {
    if (payload.failAlways) throw new Error('Simulated permanent failure (failAlways=true)');
    if (payload.failOnce && job.attempts === 1) throw new Error('Simulated one-time failure (failOnce=true)');

    if (job.type === 'report') {
      const result = await runReport(job, payload, (progress) => {
        run("UPDATE jobs SET progress = ?, heartbeat = datetime('now') WHERE id = ? AND status = 'running'", [
          progress,
          job.id,
        ]);
      });
      const written = await run(
        "UPDATE jobs SET status = 'completed', progress = 100, result = ?, error = NULL, finished_at = datetime('now') WHERE id = ? AND status = 'running'",
        [JSON.stringify(result), job.id]
      );
      if (written.changes === 0) {
        console.log(`[worker] job ${job.id} result discarded — already completed by another run (idempotency)`);
      } else {
        console.log(`[worker] job ${job.id} completed on attempt ${job.attempts} — artifact ${result.artifact.filename} (${result.artifact.size_bytes} bytes)`);
      }
      return;
    }

    throw new Error(`Unknown job type: ${job.type}`);
  } catch (err) {
    await handleFailure(job, err);
  } finally {
    clearInterval(heartbeat);
  }
}

// ---- stretch: schedules ------------------------------------------------
// A schedule is a "recurring job": kind + payload + every_seconds. When it
// becomes due (last_enqueued_at + every_seconds <= now) the worker enqueues
// a new job and stamps last_enqueued_at. The same queue machinery then runs
// it, with the same retries/alerting as on-demand jobs.
async function tickSchedules() {
  const due = await all(`
    SELECT * FROM schedules
    WHERE last_enqueued_at IS NULL
       OR datetime(last_enqueued_at, '+' || every_seconds || ' seconds') <= datetime('now')
  `);
  for (const sched of due) {
    const id = crypto.randomUUID();
    await run(
      "INSERT INTO jobs (id, type, payload, idempotency_key) VALUES (?, 'report', ?, ?)",
      [id, sched.payload, `sched:${sched.id}:${Date.now()}`]
    );
    await run("UPDATE schedules SET last_enqueued_at = datetime('now') WHERE id = ?", [sched.id]);
    console.log(`[worker] schedule ${sched.id} due — enqueued report job ${id}`);
  }
}

async function tick() {
  await reclaimStale();
  await tickSchedules();
  const job = await claim();
  if (!job) return;
  try {
    await processJob(job);
  } catch (err) {
    console.error(`[worker] unexpected error processing ${job.id}:`, err);
  }
}

init()
  .then(() => {
    tick();
    setInterval(tick, POLL_MS);
    console.log(`[worker] watching ${DB_PATH} — poll ${POLL_MS}ms, lease ${LEASE_SECONDS}s, types: ${[...REPORT_TYPES].join(', ')}`);
  })
  .catch((err) => {
    console.error('Failed to open database:', err);
    process.exit(1);
  });

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

module.exports = { tickSchedules };
