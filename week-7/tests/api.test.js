const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PORT = 15000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'week7-'));
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
    DB_PATH: path.join(tmpDir, 'reports.db'),
    PORT: String(PORT),
    POLL_MS: '200',
    LEASE_SECONDS: '10',
    HEARTBEAT_MS: '500',
    BOOKS_DATA: path.join(ROOT, 'data', 'sample-books.jsonl'),
  };
  for (const file of ['import.js', 'server.js', 'worker.js']) {
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
  const { res, job } = await postJob({ type: 'report', payload: {} });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 202);
  assert.ok(job.id);
  assert.equal(job.status, 'queued');
  assert.match(res.headers.get('location'), new RegExp(`^/jobs/${job.id}$`));
  assert.ok(elapsed < 1000, `expected fast accept, took ${elapsed}ms`);
});

test('job runs in the background, completes with a stored-artifact link, and the PDF downloads', async () => {
  const { job } = await postJob({ type: 'report', payload: {} });
  const done = await waitFor(async () => {
    const j = await getJob(job.id);
    return j && j.status === 'completed' ? j : null;
  }, { timeout: 30000 });
  assert.ok(done.attempts >= 1);
  assert.equal(done.progress, 100);

  const { artifact, book_count } = done.result;
  assert.ok(book_count > 0, 'SQL aggregation returned books');
  assert.ok(artifact.artifact_id);
  assert.equal(artifact.mime_type, 'application/pdf');
  assert.ok(artifact.size_bytes > 500, `PDF too small: ${artifact.size_bytes}`);
  assert.match(artifact.download_url, /^\/artifacts\//);

  const res = await fetch(`${BASE}${artifact.download_url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(Number(res.headers.get('content-length')), artifact.size_bytes);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF', 'body is a PDF file');
  assert.equal(bytes.length, artifact.size_bytes, 'stored bytes match the linked size');
});

test('a category-scoped report filters the aggregation', async () => {
  const { job } = await postJob({ type: 'report', payload: { category: 'Art' } });
  const done = await waitFor(async () => {
    const j = await getJob(job.id);
    return j && j.status === 'completed' ? j : null;
  });
  assert.equal(done.result.scope, 'Art');
  assert.ok(done.result.book_count > 0);
});

test('replaying the same Idempotency-Key returns the existing job, no duplicate', async () => {
  const key = crypto.randomUUID();
  const body = { type: 'report', payload: {} };
  const a = await postJob(body, { 'Idempotency-Key': key });
  const b = await postJob(body, { 'Idempotency-Key': key });
  assert.equal(a.res.status, 202);
  assert.equal(b.res.status, 202);
  assert.equal(a.job.id, b.job.id);
  const { job: sameAgain } = await postJob(body, { 'Idempotency-Key': key });
  assert.equal(sameAgain.id, a.job.id);
});

test('a failing job is retried with backoff and succeeds on the second attempt', async () => {
  const { job } = await postJob({ type: 'report', payload: { failOnce: true } });
  const done = await waitFor(async () => {
    const j = await getJob(job.id);
    return j && j.status === 'completed' ? j : null;
  }, { timeout: 20000 });
  assert.ok(done.attempts >= 2, `expected a retry, got attempts=${done.attempts}`);
  assert.ok(done.result.artifact.download_url);
});

test('a job that always fails exhausts retries, ends failed and raises an alert', async () => {
  const { job } = await postJob({ type: 'report', payload: { failAlways: true } });
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
  assert.match(alerts.find((a) => a.job_id === job.id).message, /failed after 3\/3 attempts/i);
});

test('validation and 404s', async () => {
  const badType = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'summarize', payload: {} }),
  });
  assert.equal(badType.status, 400);

  const noPayload = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'report' }),
  });
  assert.equal(noPayload.status, 400);

  const badCategory = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'report', payload: { category: '' } }),
  });
  assert.equal(badCategory.status, 400);

  const notFound = await fetch(`${BASE}/jobs/nope`);
  assert.equal(notFound.status, 404);

  const noArtifact = await fetch(`${BASE}/artifacts/nope`);
  assert.equal(noArtifact.status, 404);
});

test('a recurring schedule auto-enqueues report jobs (stretch)', async () => {
  const res = await fetch(`${BASE}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'report', every: 1, payload: {} }),
  });
  assert.equal(res.status, 201);
  const sched = await res.json();
  assert.ok(sched.id);
  assert.equal(sched.every_seconds, 1);

  const fired = await waitFor(async () => {
    const list = await (await fetch(`${BASE}/jobs`)).json();
    const mine = list.find((j) => j.type === 'report' && String(j.idempotency_key || '').startsWith(`sched:${sched.id}:`));
    return mine && mine.status === 'completed' ? mine : null;
  }, { timeout: 20000 });
  assert.ok(fired.result.artifact.download_url, 'scheduled report completed with an artifact');

  const scheds = await (await fetch(`${BASE}/schedules`)).json();
  const mine = scheds.find((s) => s.id === sched.id);
  assert.ok(mine.last_enqueued_at, 'last_enqueued_at stamped after firing');
});

test('an empty database yields a coherent report (guard against no data)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'week7-empty-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(tmp, 'reports.db'),
    PORT: String(PORT + 1),
    POLL_MS: '200',
    LEASE_SECONDS: '10',
    HEARTBEAT_MS: '500',
    BOOKS_DATA: path.join(tmp, 'nope.jsonl'),
  };
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  const worker = spawn(process.execPath, [path.join(ROOT, 'worker.js')], { env, stdio: 'ignore' });
  children.push(server, worker);
  try {
    await waitFor(async () => {
      const r = await fetch(`http://localhost:${PORT + 1}/health`);
      return r.ok;
    });
    const r = await fetch(`http://localhost:${PORT + 1}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'report', payload: {} }),
    });
    assert.equal(r.status, 202);
    const job = await r.json();
    const done = await waitFor(async () => {
      const j = await (await fetch(`http://localhost:${PORT + 1}/jobs/${job.id}`)).json();
      return j && j.status === 'completed' ? j : null;
    }, { timeout: 30000 });
    assert.equal(done.result.book_count, 0, 'empty corpus reported as zero books, not a crash');
    assert.equal(done.result.artifact.size_bytes > 500, true);
  } finally {
    server.kill('SIGKILL');
    worker.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
