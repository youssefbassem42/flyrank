const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..');
const PORT = 14000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'week6-'));
const children = [];

async function waitFor(fn, { timeout = 20000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw lastErr || new Error('waitFor timed out');
}

async function postJob(body, headers = {}) {
  const res = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { res, job: await res.json() };
}

async function getJob(id) {
  const res = await fetch(`${BASE}/jobs/${id}`);
  return res.ok ? await res.json() : null;
}

before(async () => {
  const env = {
    ...process.env,
    DB_PATH: path.join(tmpDir, 'jobs.db'),
    PORT: String(PORT),
    POLL_MS: '200',
    LEASE_SECONDS: '10',
    HEARTBEAT_MS: '500',
    AI_LATENCY_MS: '500',
  };
  for (const file of ['server.js', 'worker.js']) {
    const child = spawn(process.execPath, [path.join(ROOT, file)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(`[${file}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${file}] ${d}`));
    children.push(child);
  }
  await waitFor(async () => {
    const res = await fetch(`${BASE}/health`);
    return res.ok && (await res.json()).status === 'ok';
  });
});

after(async () => {
  for (const child of children) child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /jobs answers instantly with 202 Accepted and a job id', async () => {
  const start = Date.now();
  const { res, job } = await postJob({ type: 'summarize', payload: { prompt: 'Explain queues' } });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 202);
  assert.ok(job.id);
  assert.equal(job.status, 'queued');
  assert.match(res.headers.get('location'), new RegExp(`^/jobs/${job.id}$`));
  assert.ok(elapsed < 1000, `expected fast accept, took ${elapsed}ms`);
});

test('job runs in the background and the status endpoint reports the result', async () => {
  const { job } = await postJob({ type: 'summarize', payload: { prompt: 'Why background jobs?' } });
  const done = await waitFor(async () => {
    const j = await getJob(job.id);
    return j && j.status === 'completed' ? j : null;
  });
  assert.ok(done.attempts >= 1);
  assert.equal(done.progress, 100);
  assert.ok(done.result.summary.length > 0);
});

test('replaying the same Idempotency-Key returns the existing job, no duplicate', async () => {
  const key = crypto.randomUUID();
  const body = { type: 'summarize', payload: { prompt: 'Dedupe me' } };
  const a = await postJob(body, { 'Idempotency-Key': key });
  const b = await postJob(body, { 'Idempotency-Key': key });
  assert.equal(a.res.status, 202);
  assert.equal(b.res.status, 202);
  assert.equal(a.job.id, b.job.id);
  const { job: sameAgain } = await postJob(body, { 'Idempotency-Key': key });
  assert.equal(sameAgain.id, a.job.id);
});

test('a failing job is retried with backoff and succeeds on the second attempt', async () => {
  const { job } = await postJob({
    type: 'summarize',
    payload: { prompt: 'Flaky network', failOnce: true },
  });
  const done = await waitFor(async () => {
    const j = await getJob(job.id);
    return j && j.status === 'completed' ? j : null;
  }, { timeout: 20000 });
  assert.ok(done.attempts >= 2, `expected a retry, got attempts=${done.attempts}`);
  assert.ok(done.result.summary.length > 0);
});

test('a job that always fails exhausts retries, ends failed and raises an alert', async () => {
  const { job } = await postJob({
    type: 'summarize',
    payload: { prompt: 'Broken input', failAlways: true },
  });
  const failed = await waitFor(async () => {
    const j = await getJob(job.id);
    return j && j.status === 'failed' ? j : null;
  }, { timeout: 30000 });
  assert.equal(failed.attempts, 3, `expected 3 attempts with max_attempts=3`);
  assert.match(failed.error, /failAlways/);
  const alerts = await waitFor(async () => {
    const res = await fetch(`${BASE}/alerts`);
    const list = await res.json();
    return list.some((a) => a.job_id === job.id) ? list : null;
  });
  const mine = alerts.find((a) => a.job_id === job.id);
  assert.match(mine.message, /failed after 3\/3 attempts/i);
});

test('validation and 404s', async () => {
  const res = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'summarize' }),
  });
  assert.equal(res.status, 400);
  const notFound = await fetch(`${BASE}/jobs/nope`);
  assert.equal(notFound.status, 404);
});

function rawInsert(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(tmpDir, 'jobs.db'));
    db.run(sql, params, (err) => {
      db.close();
      err ? reject(err) : resolve();
    });
  });
}

test('a job whose worker crashed (stale lease) is reclaimed and runs again — idempotent double-run', async () => {
  await rawInsert(
    "INSERT INTO jobs (id, type, payload, status, attempts, claimed_at, heartbeat) VALUES (?, 'summarize', ?, 'running', 1, datetime('now', '-120 seconds'), datetime('now', '-120 seconds'))",
    ['stale-requeue', JSON.stringify({ prompt: 'I was mid-flight' })]
  );
  const done = await waitFor(async () => {
    const j = await getJob('stale-requeue');
    return j && j.status === 'completed' ? j : null;
  });
  assert.ok(done.attempts >= 2, `reclaimed job should run again, attempts=${done.attempts}`);
  assert.ok(done.result.summary.length > 0);
});

test('a stale job with no attempts left is failed and alerts', async () => {
  await rawInsert(
    "INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, claimed_at, heartbeat) VALUES (?, 'summarize', ?, 'running', 3, 3, datetime('now', '-120 seconds'), datetime('now', '-120 seconds'))",
    ['stale-exhausted', JSON.stringify({ prompt: 'dead' })]
  );
  const failed = await waitFor(async () => {
    const j = await getJob('stale-exhausted');
    return j && j.status === 'failed' ? j : null;
  });
  assert.match(failed.error, /lease expired/);
  const alerts = await waitFor(async () => {
    const res = await fetch(`${BASE}/alerts`);
    const list = await res.json();
    return list.some((a) => a.job_id === 'stale-exhausted') ? list : null;
  });
  assert.match(alerts.find((a) => a.job_id === 'stale-exhausted').message, /attempts exhausted/);
});
