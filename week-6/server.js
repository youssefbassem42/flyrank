const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapi = require('./openapi.json');
const crypto = require('crypto');
const { init, run, get, all } = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '100kb' }));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

function publicJob(job) {
  const out = { ...job, payload: JSON.parse(job.payload) };
  if (out.result) out.result = JSON.parse(out.result);
  return out;
}

app.get('/', (req, res) => {
  res.json({
    name: 'Background Jobs API',
    version: '1.0',
    pattern: 'accept fast (202) → worker does the slow work → poll status',
    endpoints: ['/jobs', '/jobs/:id', '/alerts', '/docs'],
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
  if (!type || typeof type !== 'string') {
    return res.status(400).json({ error: 'type is required and must be a string' });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'payload is required and must be an object' });
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
