let nextId = 4;
let tasks = [
  { id: 1, title: 'Buy groceries', done: false },
  { id: 2, title: 'Walk the dog', done: true },
  { id: 3, title: 'Write report', done: false },
];

class InMemoryTasksRepository {
  async getAll() {
    return [...tasks];
  }

  async getById(id) {
    return tasks.find(t => t.id === id) || null;
  }

  async create(title) {
    const task = { id: nextId++, title: title.trim(), done: false };
    tasks.push(task);
    return task;
  }

  async update(id, { title, done } = {}) {
    const task = tasks.find(t => t.id === id);
    if (!task) return null;
    if (title !== undefined) task.title = title.trim();
    if (done !== undefined) task.done = done;
    return task;
  }

  async delete(id) {
    const index = tasks.findIndex(t => t.id === id);
    if (index === -1) return false;
    tasks.splice(index, 1);
    return true;
  }
}

module.exports = InMemoryTasksRepository;
