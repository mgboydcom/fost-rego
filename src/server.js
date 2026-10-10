const path = require('node:path');
const express = require('express');
const cookieSession = require('cookie-session');
const { ensureSecret } = require('./db');
const { loadUser, csrfCheck } = require('./auth');
const helpers = require('./view-helpers');
const { COUNTRIES } = require('./countries');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(cookieSession({
    name: 'cfp_session',
    secret: process.env.SESSION_SECRET || ensureSecret('session_secret'),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && !process.env.ALLOW_INSECURE_COOKIES,
    maxAge: 14 * 24 * 60 * 60 * 1000,
  }));
  app.use((req, res, next) => { Object.assign(res.locals, helpers, { COUNTRIES, path: req.path, title: '' }); next(); });
  app.use(loadUser);
  app.use(csrfCheck);

  app.use(require('./routes/public'));
  app.use(require('./routes/speaker'));
  app.use('/review', require('./routes/review'));
  app.use('/admin', require('./routes/admin'));
  app.use(require('./routes/export'));

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred.' });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`CFP app listening on http://localhost:${port}`));
}

module.exports = { createApp };
