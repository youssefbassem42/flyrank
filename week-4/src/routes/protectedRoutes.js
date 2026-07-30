const express = require('express');

const router = express.Router();

router.get('/protected/profile', (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  res.status(200).json({ message: 'Token received but not yet verified' });
});

module.exports = router;
