process.env.DATABASE_FILE = ':memory:';
process.env.BASE_URL = 'http://cfp.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createApp } = require('../src/server');
const { db, getSetting } = require('../src/db');

let server;
let base;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// Minimal browser: keeps cookies and the latest CSRF token.
function browser() {
  let cookie = '';
  let csrf = '';
  async function req(method, path, form) {
    const headers = { cookie };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...form })) {
        for (const item of [].concat(v)) params.append(k, item);
      }
      body = params.toString();
    }
    const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const set = res.headers.getSetCookie();
    if (set.length) {
      const jar = Object.fromEntries(cookie.split('; ').filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2)));
      for (const c of set) { const [kv] = c.split(';'); const [k, v] = kv.split(/=(.*)/s); jar[k] = v; }
      cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const type = res.headers.get('content-type') || '';
    const text = type.includes('text/html') ? await res.text() : null;
    if (text) { const m = /name="_csrf" value="([^"]+)"/.exec(text); if (m) csrf = m[1]; }
    return { status: res.status, location: res.headers.get('location'), text, res };
  }
  return {
    get: (p) => req('GET', p),
    post: async (p, form) => { if (!csrf) await req('GET', '/login'); return req('POST', p, form); },
  };
}

async function register(name, email) {
  const b = browser();
  const [first_name, ...rest] = name.split(' ');
  const r = await b.post('/register', { first_name, last_name: rest.join(' '), email, password: 'password123' });
  assert.equal(r.status, 302, `register ${email}`);
  return b;
}

test('full CFP lifecycle', async () => {
  const admin = await register('Olive Organiser', 'admin@example.com');
  assert.equal(db.prepare("SELECT role FROM users WHERE email = 'admin@example.com'").get().role, 'admin');

  // Admin creates a conference with tracks.
  let r = await admin.post('/admin/conferences', {
    name: 'API Conf 2027', description: 'Talks about APIs', start_date: '2027-03-01', end_date: '2027-03-02',
    tracks: 'Design\nSecurity', cfp_opens: '', cfp_closes: '',
  });
  assert.equal(r.status, 302);
  const conf = db.prepare('SELECT * FROM conferences').get();
  assert.equal(conf.slug, 'api-conf-2027');

  // CSRF is enforced.
  const raw = await fetch(`${base}/admin/conferences`, { method: 'POST', body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(raw.status, 403);

  // Speaker submits, with validation.
  const speaker = await register('Ada Lovelace', 'ada@example.com');
  r = await speaker.get('/proposals/new');
  assert.match(r.text, /API Conf 2027/);
  r = await speaker.post('/proposals', { conference_id: conf.id, title: '', abstract: '', format: 'nope' });
  assert.equal(r.status, 400);
  assert.match(r.text, /Title is required/);
  r = await speaker.post('/proposals', {
    conference_id: conf.id, title: 'Designing APIs', abstract: '=HYPERLINK("evil")', format: 'Talk (30 min)', track: 'Design', level: 'Beginner',
  });
  assert.equal(r.status, 302);
  const pid = Number(r.location.split('/').pop());

  // Speaker edits; version bumps and history recorded.
  r = await speaker.post(`/proposals/${pid}/edit`, {
    conference_id: conf.id, title: 'Designing durable APIs', abstract: '=HYPERLINK("evil")', format: 'Talk (30 min)', track: 'Design', level: 'Beginner',
  });
  assert.equal(r.status, 302);
  let p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(pid);
  assert.equal(p.title, 'Designing durable APIs');
  assert.equal(p.version, 2);

  // Another speaker cannot see it.
  const other = await register('Grace Hopper', 'grace@example.com');
  r = await other.get(`/proposals/${pid}`);
  assert.equal(r.status, 404);
  r = await other.get('/review');
  assert.equal(r.status, 403);

  // Admin adds Grace to the committee; she reviews.
  r = await admin.post(`/admin/conferences/${conf.id}/reviewers`, { email: 'grace@example.com' });
  assert.equal(db.prepare("SELECT role FROM users WHERE email = 'grace@example.com'").get().role, 'reviewer');
  r = await other.get(`/review/conferences/${conf.id}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Designing durable APIs/);
  r = await other.post(`/review/proposals/${pid}/review`, { score: '4', recommendation: 'accept', comments: 'Solid' });
  assert.equal(r.status, 302);
  // Reviewers cannot make decisions.
  r = await other.post(`/review/proposals/${pid}/decision`, { status: 'accepted' });
  assert.equal(r.status, 403);

  // Admin accepts; speaker still sees "under review" until published.
  r = await admin.post(`/review/proposals/${pid}/decision`, { status: 'accepted', feedback_to_speaker: 'Welcome aboard!', internal_notes: '' });
  assert.equal(r.status, 302);
  r = await speaker.get(`/proposals/${pid}`);
  assert.match(r.text, /Under review/);
  assert.doesNotMatch(r.text, /Welcome aboard/);

  await admin.post(`/admin/conferences/${conf.id}/flags`, { flag: 'decisions_published', value: '1' });
  r = await speaker.get(`/proposals/${pid}`);
  assert.match(r.text, /Welcome aboard/);
  r = await speaker.post(`/proposals/${pid}/confirm`, { answer: 'confirm' });
  p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(pid);
  assert.equal(p.speaker_confirmation, 'confirmed');

  // Exports: admin download, token API, filters, formula escaping.
  r = await admin.get(`/admin/export/submissions.csv?conference=${conf.slug}`);
  assert.equal(r.status, 200);
  const csv = await r.res.text();
  const [header, row] = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.match(header, /^proposal_id,conference,conference_slug,title/);
  assert.match(row, /Designing durable APIs/);
  assert.match(row, /"'=HYPERLINK\(""evil""\)"/);
  assert.match(row, /,accepted,yes,confirmed,Welcome aboard!,/);
  assert.match(row, /,1,4,1,0,0,2,/); // review_count, average_score, votes, version

  r = await fetch(`${base}/api/export/wrong/program.csv`);
  assert.equal(r.status, 401);
  const token = getSetting('export_token');
  r = await fetch(`${base}/api/export/${token}/program.json`);
  const program = await r.json();
  assert.equal(program.length, 1);
  assert.equal(program[0].speaker_email, 'ada@example.com');
  assert.equal(program[0].speaker_confirmation, 'confirmed');

  r = await fetch(`${base}/api/export/${token}/submissions.json?updated_since=2999-01-01`);
  assert.deepEqual(await r.json(), []);

  r = await fetch(`${base}/api/export/${token}/workbook.xlsx?conference=${conf.slug}`);
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((s) => s.name), ['Submissions', 'Program', 'Speakers', 'Reviews', 'Conferences']);
  const reviewsSheet = wb.getWorksheet('Reviews');
  const scoreCol = reviewsSheet.getRow(1).values.indexOf('score');
  assert.equal(reviewsSheet.getRow(2).getCell(scoreCol).value, 4);

  // Withdrawn proposals cannot be edited.
  await speaker.post(`/proposals/${pid}/withdraw`, {});
  r = await speaker.get(`/proposals/${pid}/edit`);
  assert.equal(r.status, 302);
});

test('closed CFP rejects new submissions', async () => {
  const admin = browser();
  await admin.post('/login', { email: 'admin@example.com', password: 'password123' });
  await admin.post('/admin/conferences', { name: 'Old Conf', cfp_opens: '2020-01-01', cfp_closes: '2020-02-01' });
  const conf = db.prepare("SELECT * FROM conferences WHERE name = 'Old Conf'").get();
  const s = browser();
  await s.post('/login', { email: 'ada@example.com', password: 'password123' });
  const r = await s.post('/proposals', { conference_id: conf.id, title: 'Late', abstract: 'x', format: 'Talk (30 min)' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/proposals/new');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE conference_id = ?').get(conf.id).n, 0);
});

test('edit window runs to the day before the conference, not the CFP close', () => {
  const { editWindow, canSpeakerEdit, editDeadline } = require('../src/model');
  const conf = { start_date: '2027-03-10', cfp_closes: '2027-01-01', decisions_published: 0, archived: 0 };
  const p = { status: 'submitted', speaker_confirmation: '' };
  assert.equal(editDeadline(conf), '2027-03-09');
  assert.deepEqual(editWindow(p, conf, '2027-02-01'), { editable: true, deadline: '2027-03-09', daysLeft: 36, label: '36 days left to edit', tone: 'open' });
  assert.equal(editWindow(p, conf, '2027-03-08').label, '1 day left to edit');
  assert.equal(editWindow(p, conf, '2027-03-08').tone, 'soon');
  assert.equal(editWindow(p, conf, '2027-03-09').label, 'Last day to edit');
  assert.equal(editWindow(p, conf, '2027-03-10').label, 'Editing closed');
  assert.equal(editWindow(p, { ...conf, start_date: '' }, '2030-01-01').label, 'No edit deadline');
  // A hidden rejection must not lock the speaker out (that would leak the decision); a published one does.
  assert.equal(canSpeakerEdit({ status: 'rejected' }, conf, '2027-02-01'), true);
  assert.equal(canSpeakerEdit({ status: 'rejected' }, { ...conf, decisions_published: 1 }, '2027-02-01'), false);
  assert.equal(canSpeakerEdit({ status: 'accepted', speaker_confirmation: 'declined' }, { ...conf, decisions_published: 1 }, '2027-02-01'), false);
  assert.equal(canSpeakerEdit({ status: 'withdrawn' }, conf, '2027-02-01'), false);
});

test('speakers can still edit after the CFP closes and see the time left', async () => {
  const admin = browser();
  await admin.post('/login', { email: 'admin@example.com', password: 'password123' });
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  await admin.post('/admin/conferences', { name: 'Closed Call Conf', cfp_opens: '2020-01-01', start_date: future });
  const conf = db.prepare("SELECT * FROM conferences WHERE name = 'Closed Call Conf'").get();
  const ada = db.prepare("SELECT id FROM users WHERE email = 'ada@example.com'").get();
  const { lastInsertRowid: pid } = db.prepare(`INSERT INTO proposals (conference_id, speaker_id, title, abstract, format)
    VALUES (?, ?, 'Before close', 'x', 'Talk (30 min)')`).run(conf.id, ada.id);
  db.prepare("UPDATE conferences SET cfp_closes = '2020-02-01' WHERE id = ?").run(conf.id);

  const s = browser();
  await s.post('/login', { email: 'ada@example.com', password: 'password123' });
  let r = await s.get('/proposals');
  assert.match(r.text, /29 days left to edit/);
  r = await s.post(`/proposals/${pid}/edit`, { title: 'After close', abstract: 'x', format: 'Talk (30 min)' });
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT title FROM proposals WHERE id = ?').get(pid).title, 'After close');

  // Once the conference starts, editing stops.
  db.prepare("UPDATE conferences SET start_date = '2020-03-01' WHERE id = ?").run(conf.id);
  r = await s.post(`/proposals/${pid}/edit`, { title: 'Too late', abstract: 'x', format: 'Talk (30 min)' });
  assert.equal(db.prepare('SELECT title FROM proposals WHERE id = ?').get(pid).title, 'After close');
  r = await s.get('/proposals');
  assert.match(r.text, /Editing closed/);
});

test('migrates older databases: name split into first/last, social renamed', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { migrate } = require('../src/db');
  const old = new DatabaseSync(':memory:');
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password_hash TEXT, name TEXT NOT NULL, social TEXT NOT NULL DEFAULT '');
            INSERT INTO users (email, password_hash, name, social) VALUES
              ('a@x', 'h', 'Ada King Lovelace', '@ada'), ('c@x', 'h', 'Cher', ''), ('g@x', 'h', '  Grace Hopper ', '')`);
  migrate(old);
  const rows = old.prepare('SELECT first_name, last_name, name, linkedin_profile_url FROM users ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { first_name: 'Ada', last_name: 'King Lovelace', name: 'Ada King Lovelace', linkedin_profile_url: '@ada' },
    { first_name: 'Cher', last_name: '', name: 'Cher', linkedin_profile_url: '' },
    { first_name: 'Grace', last_name: 'Hopper', name: 'Grace Hopper', linkedin_profile_url: '' },
  ]);
  migrate(old); // safe to run again
});

test('profile takes first and last name and a LinkedIn URL, and exports them', async () => {
  const s = browser();
  await s.post('/login', { email: 'ada@example.com', password: 'password123' });
  let r = await s.post('/profile', { first_name: 'Ada', last_name: 'Lovelace', linkedin_profile_url: 'https://mastodon.social/@ada' });
  assert.equal(r.status, 400);
  assert.match(r.text, /must be a linkedin\.com address/);
  r = await s.post('/profile', { first_name: 'Ada', last_name: 'King-Lovelace', linkedin_profile_url: 'linkedin.com/in/ada' });
  assert.equal(r.status, 302);
  const u = db.prepare("SELECT first_name, last_name, name, linkedin_profile_url FROM users WHERE email = 'ada@example.com'").get();
  assert.equal(u.name, 'Ada King-Lovelace');
  assert.equal(u.linkedin_profile_url, 'https://linkedin.com/in/ada');
  r = await s.get('/proposals');
  assert.match(r.text, />Ada<\/a>/); // first name in the nav

  const token = getSetting('export_token');
  const speakers = await (await fetch(`${base}/api/export/${token}/speakers.json`)).json();
  const ada = speakers.find((x) => x.email === 'ada@example.com');
  assert.equal(ada.first_name, 'Ada');
  assert.equal(ada.last_name, 'King-Lovelace');
  assert.equal(ada.linkedin_profile_url, 'https://linkedin.com/in/ada');
  const subs = await (await fetch(`${base}/api/export/${token}/submissions.json`)).json();
  const row = subs.find((x) => x.speaker_email === 'ada@example.com');
  assert.equal(row.speaker_first_name, 'Ada');
  assert.equal(row.speaker_last_name, 'King-Lovelace');
  assert.equal(row.speaker_name, 'Ada King-Lovelace');
  assert.ok('speaker_linkedin_profile_url' in row);
});
