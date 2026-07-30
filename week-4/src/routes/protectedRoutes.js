const express = require('express');
const authenticate = require('../middleware/auth');

const router = express.Router();

router.get('/protected/profile', authenticate, (req, res) => {
  res.status(200).json({
    id: req.user.id,
    email: req.user.email,
    created_at: req.user.created_at,
  });
});

module.exports = router;
