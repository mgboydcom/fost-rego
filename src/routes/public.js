const express = require('express');
const { db, now } = require('../db');
const { hashPassword, verifyPassword, flash } = require('../auth');
const { listConferences, getConference } = require('../model');

const router = express.Router();

router.get('/', (req, res) => {
  const conferences = listConferences();
  res.render('home', { title: 'Call for proposals', conferences });
});

router.get('/cfp/:slug', (req, res) => {
  const conf = getConference(req.params.slug);
  if (!conf || conf.archived) return res.status(404).render('error', { title: 'Not found', message: 'Conference not found.' });
  res.render('conference', { title: conf.name, conf });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/proposals');
  res.render('register', { title: 'Create an account', values: {}, error: null });
});

router.post('/register', (req, res) => {
  const values = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    organization: String(req.body.organization || '').trim(),
  };
  const password = String(req.body.password || '');
  let error = null;
  if (!values.name) error = 'Please enter your name.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) error = 'Please enter a valid email address.';
  else if (password.length < 8) error = 'Password must be at least 8 characters.';
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) error = 'An account with that email already exists. Try signing in.';
  if (error) return res.status(400).render('register', { title: 'Create an account', values, error });

  // The very first account becomes the organiser (admin) so a fresh install can be set up from the browser.
  const isFirst = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO users (email, password_hash, name, organization, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(values.email, hashPassword(password), values.name, values.organization, isFirst ? 'admin' : 'speaker', now(), now());
  req.session.userId = Number(lastInsertRowid);
  flash(req, 'success', isFirst
    ? 'Welcome! As the first user you are the organiser (admin). Create your first conference below.'
    : 'Welcome! Complete your speaker profile, then submit a proposal.');
  const back = req.session.returnTo;
  req.session.returnTo = undefined;
  res.redirect(isFirst ? '/admin' : back || '/profile');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/proposals');
  res.render('login', { title: 'Sign in', email: '', error: null });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('login', { title: 'Sign in', email, error: 'Incorrect email or password.' });
  }
  req.session.userId = user.id;
  const back = req.session.returnTo;
  req.session.returnTo = undefined;
  const home = user.role === 'admin' ? '/admin' : user.role === 'reviewer' ? '/review' : '/proposals';
  res.redirect(back && back.startsWith('/') && !back.startsWith('//') ? back : home);
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

module.exports = router;
