const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapi = require('./openapi.json');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const port = 3000;

const db = new Database(path.join(__dirname, 'tasks.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const count = db.prepare('SELECT COUNT(*) AS count FROM tasks').get();
if (count.count === 0) {
  const insert = db.prepare('INSERT INTO tasks (title, done) VALUES (?, ?)');
  insert.run('Buy groceries', 0);
  insert.run('Walk the dog', 1);
  insert.run('Write report', 0);
}

app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

app.get('/', (req, res) => {
  res.json({ name: 'Task API', version: '1.0', endpoints: ['/tasks', '/stats'] });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS value FROM tasks').get();
  const done = db.prepare('SELECT COUNT(*) AS value FROM tasks WHERE done = 1').get();
  const pending = db.prepare('SELECT COUNT(*) AS value FROM tasks WHERE done = 0').get();
  res.json({ total: total.value, done: done.value, pending: pending.value });
});

app.get('/tasks', (req, res) => {
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (req.query.search) {
    sql += ' AND title LIKE ?';
    params.push(`%${req.query.search}%`);
  }

  if (req.query.done !== undefined) {
    const val = req.query.done === 'true' ? 1 : 0;
    sql += ' AND done = ?';
    params.push(val);
  }

  if (req.query.sort === 'title') {
    sql += ' ORDER BY title';
  } else {
    sql += ' ORDER BY id';
  }

  const tasks = db.prepare(sql).all(...params);
  res.json(tasks.map(t => ({ ...t, done: t.done === 1 })));
});

app.get('/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return res.status(404).json({ error: `Task ${id} not found` });
  }
  res.json({ ...task, done: task.done === 1 });
});

app.post('/tasks', (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'Title is required and must be a non-empty string' });
  }
  const result = db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title.trim());
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ ...task, done: task.done === 1 });
});

app.put('/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: `Task ${id} not found` });
  }
  const { title, done } = req.body;
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    return res.status(400).json({ error: 'Title must be a non-empty string' });
  }
  if (done !== undefined && typeof done !== 'boolean') {
    return res.status(400).json({ error: 'Done must be a boolean' });
  }
  const newTitle = title !== undefined ? title.trim() : existing.title;
  const newDone = done !== undefined ? (done ? 1 : 0) : existing.done;
  db.prepare(
    "UPDATE tasks SET title = ?, done = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(newTitle, newDone, id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json({ ...task, done: task.done === 1 });
});

app.delete('/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: `Task ${id} not found` });
  }
  res.status(204).send();
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
