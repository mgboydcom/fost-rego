const crypto = require('node:crypto');
const { db } = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Loads the signed-in user (if any) and a per-session CSRF token into res.locals.
function loadUser(req, res, next) {
  const id = req.session && req.session.userId;
  req.user = id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null : null;
  if (!req.user && req.session) req.session.userId = undefined;
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  res.locals.user = req.user;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  req.session.flash = undefined;
  next();
}

function csrfCheck(req, res, next) {
  if (req.method !== 'POST') return next();
  const token = req.body && req.body._csrf;
  if (!token || token !== req.session.csrf) {
    return res.status(403).render('error', { title: 'Form expired', message: 'Your form session expired. Go back, reload the page and try again.' });
  }
  next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function requireLogin(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return [requireLogin, (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have access to this page.' });
    }
    next();
  }];
}

module.exports = { hashPassword, verifyPassword, loadUser, csrfCheck, flash, requireLogin, requireRole };
