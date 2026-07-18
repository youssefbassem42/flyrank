require('dotenv').config();

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapi = require('../openapi.json');
const createTasksRoutes = require('./routes/tasksRoutes');
const TasksService = require('./services/tasksService');
const InMemoryTasksRepository = require('./repositories/inMemoryTasksRepository');
const PostgresTasksRepository = require('./repositories/postgresTasksRepository');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

let repository;
if (process.env.STORAGE === 'postgres') {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required when STORAGE=postgres');
    process.exit(1);
  }
  repository = new PostgresTasksRepository(connectionString);
  console.log('Using Postgres repository');
} else {
  repository = new InMemoryTasksRepository();
  console.log('Using in-memory repository');
}

const tasksService = new TasksService(repository);
const router = createTasksRoutes(tasksService);
app.use(router);

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) console.error(err);
  const message = err.statusCode ? err.message : 'Internal server error';
  res.status(statusCode).json({ error: message });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
