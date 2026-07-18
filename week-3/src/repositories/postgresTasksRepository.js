const { Pool } = require('pg');

class PostgresTasksRepository {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString });
  }

  async query(text, params) {
    const client = await this.pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  async getAll() {
    const result = await this.query('SELECT * FROM tasks ORDER BY id');
    return result.rows;
  }

  async getById(id) {
    const result = await this.query('SELECT * FROM tasks WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async create(title) {
    const result = await this.query(
      'INSERT INTO tasks (title) VALUES ($1) RETURNING *',
      [title.trim()]
    );
    return result.rows[0];
  }

  async update(id, { title, done } = {}) {
    const fields = [];
    const values = [];
    let idx = 1;
    if (title !== undefined) {
      fields.push(`title = $${idx++}`);
      values.push(title.trim());
    }
    if (done !== undefined) {
      fields.push(`done = $${idx++}`);
      values.push(done);
    }
    if (fields.length === 0) {
      return this.getById(id);
    }
    values.push(id);
    const result = await this.query(
      `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async delete(id) {
    const result = await this.query('DELETE FROM tasks WHERE id = $1', [id]);
    return result.rowCount > 0;
  }
}

module.exports = PostgresTasksRepository;
