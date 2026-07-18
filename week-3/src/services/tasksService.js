class TasksService {
  constructor(repository) {
    this.repository = repository;
  }

  async getAll() {
    return this.repository.getAll();
  }

  async getById(id) {
    return this.repository.getById(id);
  }

  async create(title) {
    if (!title || typeof title !== 'string' || title.trim() === '') {
      const err = new Error('Title is required and must be a non-empty string');
      err.statusCode = 400;
      throw err;
    }
    return this.repository.create(title);
  }

  async update(id, { title, done } = {}) {
    if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
      const err = new Error('Title must be a non-empty string');
      err.statusCode = 400;
      throw err;
    }
    if (done !== undefined && typeof done !== 'boolean') {
      const err = new Error('Done must be a boolean');
      err.statusCode = 400;
      throw err;
    }
    const task = await this.repository.update(id, { title, done });
    if (!task) {
      const err = new Error(`Task ${id} not found`);
      err.statusCode = 404;
      throw err;
    }
    return task;
  }

  async delete(id) {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      const err = new Error(`Task ${id} not found`);
      err.statusCode = 404;
      throw err;
    }
  }
}

module.exports = TasksService;
