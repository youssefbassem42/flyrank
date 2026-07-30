const express = require('express');

const router = express.Router();

router.get('/public/info', (req, res) => {
  res.status(200).json({ message: 'Welcome stranger! This info is public.' });
});

module.exports = router;
