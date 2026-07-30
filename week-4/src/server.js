require('dotenv').config();

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapi = require('../openapi.json');
const authRoutes = require('./routes/authRoutes');
const protectedRoutes = require('./routes/protectedRoutes');
const publicRoutes = require('./routes/publicRoutes');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

app.use(authRoutes);
app.use(protectedRoutes);
app.use(publicRoutes);

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) console.error(err);
  const message = err.statusCode ? err.message : 'Internal server error';
  res.status(statusCode).json({ error: message });
});

app.listen(port, () => {
  console.log(`Server running and connected to Supabase on http://localhost:${port}`);
  console.log(`Swagger UI at http://localhost:${port}/docs`);
});
