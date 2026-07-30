const express = require('express');
const supabase = require('../supabaseClient');
const authenticate = require('../middleware/auth');

const router = express.Router();

router.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(201).json(data.user);
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return res.status(401).json({ error: 'Invalid login credentials' });
  }

  res.status(200).json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
});

router.post('/auth/logout', authenticate, async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader.split(' ')[1];

  const { error: sessionError } = await supabase.auth.setSession({
    access_token: token,
    refresh_token: '',
  });

  if (sessionError) {
    return res.status(400).json({ error: sessionError.message });
  }

  const { error: signOutError } = await supabase.auth.signOut();

  if (signOutError) {
    return res.status(400).json({ error: signOutError.message });
  }

  res.status(204).send();
});

module.exports = router;
