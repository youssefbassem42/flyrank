const sqlite3 = require('sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'reports.db');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    progress INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    claimed_at TEXT,
    heartbeat TEXT,
    next_run_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS books (
    url TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT,
    upc TEXT,
    product_type TEXT,
    price_incl_tax REAL,
    price_excl_tax REAL,
    tax REAL,
    rating INTEGER,
    in_stock INTEGER,
    stock_quantity INTEGER,
    number_of_reviews INTEGER,
    description TEXT,
    image_url TEXT,
    scraped_at TEXT
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    content BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    every_seconds INTEGER NOT NULL,
    last_enqueued_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_books_category ON books(category);
  CREATE INDEX IF NOT EXISTS idx_books_rating ON books(rating);
`;

let db = null;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function init() {
  if (db) return db;
  db = new sqlite3.Database(DB_PATH);
  db.configure('busyTimeout', 5000);
  await new Promise((resolve, reject) => {
    db.exec('PRAGMA journal_mode = WAL;', (err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve, reject) => {
    db.exec(SCHEMA, (err) => (err ? reject(err) : resolve()));
  });
  return db;
}

module.exports = { init, run, get, all, DB_PATH };
