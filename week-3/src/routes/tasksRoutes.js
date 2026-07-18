const { Router } = require('express');

function createTasksRoutes(tasksService) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ name: 'Task API', version: '1.0', endpoints: ['/tasks'] });
  });

  router.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/tasks', async (req, res, next) => {
    try {
      const tasks = await tasksService.getAll();
      res.json(tasks);
    } catch (err) { next(err); }
  });

  router.get('/tasks/:id', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const task = await tasksService.getById(id);
      if (!task) {
        return res.status(404).json({ error: `Task ${id} not found` });
      }
      res.json(task);
    } catch (err) { next(err); }
  });

  router.post('/tasks', async (req, res, next) => {
    try {
      const { title } = req.body;
      const task = await tasksService.create(title);
      res.status(201).json(task);
    } catch (err) { next(err); }
  });

  router.put('/tasks/:id', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { title, done } = req.body;
      const task = await tasksService.update(id, { title, done });
      res.json(task);
    } catch (err) { next(err); }
  });

  router.delete('/tasks/:id', async (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      await tasksService.delete(id);
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = createTasksRoutes;
