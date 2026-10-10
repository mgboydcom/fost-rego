// Loads demo data: npm run seed
// Accounts (password for all: password123):
//   admin@example.com (organiser), reviewer1@example.com, reviewer2@example.com,
//   ada@example.com, grace@example.com, linus@example.com (speakers)
const { db, now } = require('../src/db');
const { hashPassword } = require('../src/auth');

if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  console.log('Database already has data; skipping seed. Delete data/cfp.db to start fresh.');
  process.exit(0);
}

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const pw = hashPassword('password123');

const user = (email, name, role, extra = {}) => Number(db.prepare(`
  INSERT INTO users (email, password_hash, first_name, last_name, role, organization, job_title, bio, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(email, pw, name.split(' ')[0], name.split(' ').slice(1).join(' '), role, extra.organization || '', extra.job_title || '', extra.bio || '', now(), now()).lastInsertRowid);

const admin = user('admin@example.com', 'Olive Organiser', 'admin');
const r1 = user('reviewer1@example.com', 'Rhea Reviewer', 'reviewer', { organization: 'Acme' });
const r2 = user('reviewer2@example.com', 'Ravi Reviewer', 'reviewer', { organization: 'Globex' });
const ada = user('ada@example.com', 'Ada Lovelace', 'speaker', { organization: 'Analytical Engines Ltd', job_title: 'Principal Engineer', bio: 'Ada writes programs for machines that do not exist yet.' });
const grace = user('grace@example.com', 'Grace Hopper', 'speaker', { organization: 'US Navy', job_title: 'Rear Admiral', bio: 'Grace popularised the idea of machine-independent programming languages.' });
const linus = user('linus@example.com', 'Linus Torvalds', 'speaker', { organization: 'Linux Foundation', job_title: 'Fellow', bio: 'Linus maintains a small hobby kernel.' });

const conf = (name, slug, opts) => Number(db.prepare(`
  INSERT INTO conferences (name, slug, description, location, start_date, end_date, cfp_opens, cfp_closes, tracks, blind_review, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(name, slug, opts.description, opts.location, opts.start, opts.end, opts.opens, opts.closes, opts.tracks, opts.blind ? 1 : 0, now(), now()).lastInsertRowid);

const apiConf = conf('APIDays Europe 2027', 'apidays-europe-2027', {
  description: 'Two days of talks and workshops on API design, platforms and AI integrations.',
  location: 'Paris, France', start: iso(120), end: iso(121), opens: iso(-30), closes: iso(30),
  tracks: 'API Design\nPlatform Engineering\nAI & Agents\nSecurity',
});
const osConf = conf('Open Source Summit 2027', 'oss-summit-2027', {
  description: 'Community-driven conference for open source maintainers and contributors.',
  location: 'Online', start: iso(200), end: iso(202), opens: iso(-10), closes: iso(60),
  tracks: 'Maintainership\nCommunity\nTooling', blind: true,
});

for (const [c, u] of [[apiConf, r1], [apiConf, r2], [osConf, r1]]) {
  db.prepare('INSERT INTO conference_reviewers (conference_id, user_id) VALUES (?, ?)').run(c, u);
}

const proposal = (c, speaker, title, format, track, abstract) => Number(db.prepare(`
  INSERT INTO proposals (conference_id, speaker_id, title, abstract, description, format, track, level, submitted_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'Intermediate', ?, ?)`)
  .run(c, speaker, title, abstract, 'Outline:\n1. Problem\n2. Approach\n3. Results', format, track, now(), now()).lastInsertRowid);

const p1 = proposal(apiConf, ada, 'Designing APIs for engines that do not exist yet', 'Talk (30 min)', 'API Design', 'How to design interfaces that outlive their first implementation.');
const p2 = proposal(apiConf, grace, 'Compilers, contracts and the OpenAPI spec', 'Talk (30 min)', 'Platform Engineering', 'Treat your API description as a compiler input and generate everything else.');
const p3 = proposal(apiConf, linus, 'Saying no to API changes', 'Lightning talk (10 min)', 'API Design', 'A short guide to not breaking userspace.');
proposal(apiConf, ada, 'Hands-on: agents calling your API safely', 'Workshop (90 min)', 'AI & Agents', 'Build a tool-using agent against a sandboxed API.');
proposal(osConf, linus, 'Maintainer burnout and how to avoid it', 'Talk (30 min)', 'Maintainership', 'Lessons from three decades of reviewing patches.');

const review = (p, r, score, rec, comments) => db.prepare(`
  INSERT INTO reviews (proposal_id, reviewer_id, score, recommendation, comments, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run(p, r, score, rec, comments, now(), now());
review(p1, r1, 5, 'accept', 'Great fit for the design track.');
review(p1, r2, 4, 'accept', 'Strong speaker, clear outline.');
review(p2, r1, 3, 'maybe', 'Interesting but overlaps with last year.');
review(p3, r2, 2, 'reject', 'Too short to be useful.');

db.prepare("UPDATE proposals SET status = 'accepted', decided_at = ? WHERE id = ?").run(now(), p1);

console.log(`Seeded demo data (admin user id ${admin}). Sign in as admin@example.com / password123`);
