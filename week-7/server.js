const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapi = require('./openapi.json');
const crypto = require('crypto');
const { init, run, get, all } = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '100kb' }));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

const ALLOWED_TYPES = new Set(['report']);

function publicJob(job) {
  const out = { ...job, payload: JSON.parse(job.payload) };
  if (out.result) out.result = JSON.parse(out.result);
  return out;
}

function publicSchedule(s) {
  return { ...s, payload: JSON.parse(s.payload) };
}

app.get('/', (req, res) => {
  res.json({
    name: 'Books Report Pipeline API',
    version: '1.0',
    pattern: 'accept fast (202) → worker aggregates with SQL → renders PDF → stores artifact → you download a link',
    endpoints: ['/jobs', '/jobs/:id', '/artifacts/:id', '/schedules', '/alerts', '/docs'],
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/jobs', async (req, res) => {
  const { status } = req.query;
  const jobs = status
    ? await all('SELECT * FROM jobs WHERE status = ? ORDER BY created_at, id', [status])
    : await all('SELECT * FROM jobs ORDER BY created_at, id');
  res.json(jobs.map(publicJob));
});

app.post('/jobs', async (req, res) => {
  const { type, payload, idempotency_key } = req.body;
  if (!type || typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: `type must be one of: ${[...ALLOWED_TYPES].join(', ')}` });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'payload is required and must be an object' });
  }
  if (payload.category !== undefined && (typeof payload.category !== 'string' || payload.category.trim() === '')) {
    return res.status(400).json({ error: 'payload.category, if set, must be a non-empty string' });
  }

  const idempotencyKey = req.get('Idempotency-Key') || idempotency_key || null;
  if (idempotencyKey) {
    const existing = await get('SELECT * FROM jobs WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) {
      return res.status(202).set('Location', `/jobs/${existing.id}`).json(publicJob(existing));
    }
  }

  const id = crypto.randomUUID();
  try {
    await run('INSERT INTO jobs (id, type, payload, idempotency_key) VALUES (?, ?, ?, ?)', [
      id,
      type,
      JSON.stringify(payload),
      idempotencyKey,
    ]);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      const existing = await get('SELECT * FROM jobs WHERE idempotency_key = ?', [idempotencyKey]);
      return res.status(202).set('Location', `/jobs/${existing.id}`).json(publicJob(existing));
    }
    throw err;
  }

  const job = await get('SELECT * FROM jobs WHERE id = ?', [id]);
  console.log(`[api] accepted job ${id} (${type})`);
  res.status(202).set('Location', `/jobs/${id}`).json(publicJob(job));
});

app.get('/jobs/:id', async (req, res) => {
  const job = await get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
  if (!job) {
    return res.status(404).json({ error: `Job ${req.params.id} not found` });
  }
  res.json(publicJob(job));
});

// store-and-link: the job result carries a link, the bytes stay here
app.get('/artifacts/:id', async (req, res) => {
  const artifact = await get('SELECT * FROM artifacts WHERE id = ?', [req.params.id]);
  if (!artifact) {
    return res.status(404).json({ error: `Artifact ${req.params.id} not found` });
  }
  res.set('Content-Type', artifact.mime_type);
  res.set('Content-Length', String(artifact.size_bytes));
  res.set('Content-Disposition', `attachment; filename="${artifact.filename}"`);
  res.send(artifact.content);
});

app.post('/schedules', async (req, res) => {
  const { kind, payload, every } = req.body;
  if (kind !== 'report') {
    return res.status(400).json({ error: 'kind must be "report"' });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'payload is required and must be an object' });
  }
  const everySeconds = Number(every);
  if (!Number.isInteger(everySeconds) || everySeconds < 1) {
    return res.status(400).json({ error: 'every must be a positive integer number of seconds' });
  }

  const id = crypto.randomUUID();
  await run('INSERT INTO schedules (id, kind, payload, every_seconds) VALUES (?, ?, ?, ?)', [
    id,
    kind,
    JSON.stringify(payload),
    everySeconds,
  ]);
  const sched = await get('SELECT * FROM schedules WHERE id = ?', [id]);
  console.log(`[api] created schedule ${id} — ${kind} every ${everySeconds}s`);
  res.status(201).json(publicSchedule(sched));
});

app.get('/schedules', async (req, res) => {
  const schedules = await all('SELECT * FROM schedules ORDER BY created_at, id');
  res.json(schedules.map(publicSchedule));
});

app.get('/alerts', async (req, res) => {
  const alerts = await all('SELECT * FROM alerts ORDER BY id DESC LIMIT 50');
  res.json(alerts);
});

init()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to open database:', err);
    process.exit(1);
  });
