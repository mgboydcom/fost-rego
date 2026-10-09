const express = require('express');
const crypto = require('node:crypto');
const { db, now, setSetting, ensureSecret } = require('../db');
const { requireRole, flash } = require('../auth');
const { listConferences, getConference, slugify } = require('../model');

const router = express.Router();
router.use(requireRole('admin'));

const CONF_FIELDS = ['name', 'description', 'location', 'website', 'start_date', 'end_date', 'cfp_opens', 'cfp_closes', 'tracks', 'formats'];
const DATE_FIELDS = ['start_date', 'end_date', 'cfp_opens', 'cfp_closes'];

function readConference(body) {
  const values = Object.fromEntries(CONF_FIELDS.map((f) => [f, String(body[f] || '').trim()]));
  values.blind_review = body.blind_review ? 1 : 0;
  values.slug = slugify(body.slug || values.name);
  const errors = [];
  if (!values.name) errors.push('Name is required.');
  for (const f of DATE_FIELDS) {
    if (values[f] && !/^\d{4}-\d{2}-\d{2}$/.test(values[f])) errors.push(`${f.replace('_', ' ')} must be a date.`);
  }
  if (values.cfp_opens && values.cfp_closes && values.cfp_closes < values.cfp_opens) errors.push('The CFP must close after it opens.');
  if (values.start_date && values.end_date && values.end_date < values.start_date) errors.push('The conference must end after it starts.');
  return { values, errors };
}

router.get('/', (req, res) => {
  const conferences = listConferences({ includeArchived: true }).map((c) => ({
    ...c,
    stats: db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'accepted') AS accepted,
                       SUM(speaker_confirmation = 'confirmed') AS confirmed,
                       SUM(status = 'submitted') AS pending
                       FROM proposals WHERE conference_id = ? AND status != 'withdrawn'`).get(c.id),
    reviewers: db.prepare('SELECT COUNT(*) AS n FROM conference_reviewers WHERE conference_id = ?').get(c.id).n,
  }));
  res.render('admin-home', { title: 'Organiser dashboard', conferences });
});

router.get('/conferences/new', (req, res) => {
  res.render('admin-conference-form', { title: 'New conference', values: { blind_review: 0 }, errors: [], conf: null });
});

router.post('/conferences', (req, res) => {
  const { values, errors } = readConference(req.body);
  if (db.prepare('SELECT 1 FROM conferences WHERE slug = ?').get(values.slug)) errors.push('Another conference already uses that URL slug.');
  if (errors.length) return res.status(400).render('admin-conference-form', { title: 'New conference', values, errors, conf: null });
  const cols = [...CONF_FIELDS, 'blind_review', 'slug'];
  const { lastInsertRowid } = db.prepare(`INSERT INTO conferences (${cols.join(', ')}, created_at, updated_at)
    VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`).run(...cols.map((c) => values[c]), now(), now());
  flash(req, 'success', 'Conference created. Add program committee members below.');
  res.redirect(`/admin/conferences/${lastInsertRowid}`);
});

function loadConf(req, res) {
  const conf = getConference(req.params.id);
  if (!conf) res.status(404).render('error', { title: 'Not found', message: 'Conference not found.' });
  return conf;
}

router.get('/conferences/:id', (req, res) => {
  const conf = loadConf(req, res);
  if (!conf) return;
  const reviewers = db.prepare(`
    SELECT u.id, u.name, u.email, u.role,
           (SELECT COUNT(*) FROM reviews r JOIN proposals p ON p.id = r.proposal_id
            WHERE r.reviewer_id = u.id AND p.conference_id = ?) AS reviews_done
    FROM conference_reviewers cr JOIN users u ON u.id = cr.user_id
    WHERE cr.conference_id = ? ORDER BY u.name`).all(conf.id, conf.id);
  res.render('admin-conference-form', { title: `Edit ${conf.name}`, values: conf, errors: [], conf, reviewers });
});

router.post('/conferences/:id', (req, res) => {
  const conf = loadConf(req, res);
  if (!conf) return;
  const { values, errors } = readConference(req.body);
  if (db.prepare('SELECT 1 FROM conferences WHERE slug = ? AND id != ?').get(values.slug, conf.id)) errors.push('Another conference already uses that URL slug.');
  if (errors.length) {
    return res.status(400).render('admin-conference-form', { title: `Edit ${conf.name}`, values: { ...values, id: conf.id }, errors, conf, reviewers: [] });
  }
  const cols = [...CONF_FIELDS, 'blind_review', 'slug'];
  db.prepare(`UPDATE conferences SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => values[c]), now(), conf.id);
  flash(req, 'success', 'Conference saved.');
  res.redirect(`/admin/conferences/${conf.id}`);
});

router.post('/conferences/:id/flags', (req, res) => {
  const conf = loadConf(req, res);
  if (!conf) return;
  const flag = req.body.flag;
  if (!['decisions_published', 'archived'].includes(flag)) return res.redirect(`/admin/conferences/${conf.id}`);
  const value = req.body.value === '1' ? 1 : 0;
  db.prepare(`UPDATE conferences SET ${flag} = ?, updated_at = ? WHERE id = ?`).run(value, now(), conf.id);
  if (flag === 'decisions_published') {
    // Mark every decided proposal as changed so incremental exports pick up the newly visible decisions.
    db.prepare("UPDATE proposals SET updated_at = ? WHERE conference_id = ? AND status IN ('accepted','waitlisted','rejected')")
      .run(now(), conf.id);
  }
  const messages = {
    decisions_published: value ? 'Decisions are now visible to speakers. Accepted speakers can confirm their slot.' : 'Decisions hidden from speakers.',
    archived: value ? 'Conference archived.' : 'Conference restored.',
  };
  flash(req, 'success', messages[flag]);
  res.redirect(`/admin/conferences/${conf.id}`);
});

router.post('/conferences/:id/reviewers', (req, res) => {
  const conf = loadConf(req, res);
  if (!conf) return;
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    flash(req, 'error', `No account found for ${email}. Ask them to register first, then add them here.`);
  } else {
    if (user.role === 'speaker') db.prepare("UPDATE users SET role = 'reviewer', updated_at = ? WHERE id = ?").run(now(), user.id);
    db.prepare('INSERT OR IGNORE INTO conference_reviewers (conference_id, user_id) VALUES (?, ?)').run(conf.id, user.id);
    flash(req, 'success', `${user.name} added to the program committee.`);
  }
  res.redirect(`/admin/conferences/${conf.id}#committee`);
});

router.post('/conferences/:id/reviewers/:userId/remove', (req, res) => {
  const conf = loadConf(req, res);
  if (!conf) return;
  db.prepare('DELETE FROM conference_reviewers WHERE conference_id = ? AND user_id = ?').run(conf.id, Number(req.params.userId));
  flash(req, 'success', 'Removed from the program committee.');
  res.redirect(`/admin/conferences/${conf.id}#committee`);
});

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const users = db.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM proposals p WHERE p.speaker_id = u.id) AS proposal_count
    FROM users u
    WHERE (? = '' OR u.name LIKE ? OR u.email LIKE ? OR u.organization LIKE ?)
    ORDER BY u.created_at DESC LIMIT 500`).all(q, `%${q}%`, `%${q}%`, `%${q}%`);
  res.render('admin-users', { title: 'People', users, q });
});

router.post('/users/:id/role', (req, res) => {
  const role = req.body.role;
  const id = Number(req.params.id);
  if (!['speaker', 'reviewer', 'admin'].includes(role)) return res.redirect('/admin/users');
  if (id === req.user.id && role !== 'admin') {
    flash(req, 'error', 'You cannot remove your own admin access.');
    return res.redirect('/admin/users');
  }
  db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, now(), id);
  if (role === 'speaker') db.prepare('DELETE FROM conference_reviewers WHERE user_id = ?').run(id);
  flash(req, 'success', 'Role updated.');
  res.redirect('/admin/users');
});

router.get('/exports', (req, res) => {
  const base = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.render('admin-exports', {
    title: 'Spreadsheet exports',
    conferences: listConferences({ includeArchived: true }),
    token: ensureSecret('export_token'),
    base,
  });
});

router.post('/exports/rotate-token', (req, res) => {
  setSetting('export_token', crypto.randomBytes(24).toString('hex'));
  flash(req, 'success', 'Export token regenerated. Update any automations that use the old links.');
  res.redirect('/admin/exports');
});

module.exports = router;
