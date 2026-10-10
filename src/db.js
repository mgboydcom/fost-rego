const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { guessCountryCode } = require('./countries');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL DEFAULT '',
  -- Full name, kept up to date by SQLite from first_name and last_name (read-only).
  name          TEXT GENERATED ALWAYS AS (trim(first_name || ' ' || last_name)) VIRTUAL,
  role          TEXT NOT NULL DEFAULT 'speaker' CHECK (role IN ('speaker','reviewer','admin')),
  organization  TEXT NOT NULL DEFAULT '',
  job_title     TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  linkedin_profile_url TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT '', -- ISO 3166-1 alpha-2 code (see countries.js), '' = not given
  photo_url     TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS conferences (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL UNIQUE,
  description          TEXT NOT NULL DEFAULT '',
  location             TEXT NOT NULL DEFAULT '',
  website              TEXT NOT NULL DEFAULT '',
  start_date           TEXT NOT NULL DEFAULT '',
  end_date             TEXT NOT NULL DEFAULT '',
  cfp_opens            TEXT NOT NULL DEFAULT '',
  cfp_closes           TEXT NOT NULL DEFAULT '',
  tracks               TEXT NOT NULL DEFAULT '',
  formats              TEXT NOT NULL DEFAULT '',
  blind_review         INTEGER NOT NULL DEFAULT 0,
  decisions_published  INTEGER NOT NULL DEFAULT 0,
  archived             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS conference_reviewers (
  conference_id INTEGER NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conference_id, user_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  conference_id         INTEGER NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
  speaker_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  abstract              TEXT NOT NULL,
  format                TEXT NOT NULL DEFAULT '',
  track                 TEXT NOT NULL DEFAULT '',
  level                 TEXT NOT NULL DEFAULT '',
  co_speakers           TEXT NOT NULL DEFAULT '',
  notes                 TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted','accepted','waitlisted','rejected','withdrawn')),
  speaker_confirmation  TEXT NOT NULL DEFAULT ''
                        CHECK (speaker_confirmation IN ('','confirmed','declined')),
  feedback_to_speaker   TEXT NOT NULL DEFAULT '',
  internal_notes        TEXT NOT NULL DEFAULT '',
  version               INTEGER NOT NULL DEFAULT 1,
  submitted_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  decided_at            TEXT NOT NULL DEFAULT '',
  confirmed_at          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_proposals_conf ON proposals(conference_id);
CREATE INDEX IF NOT EXISTS idx_proposals_speaker ON proposals(speaker_id);

CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id     INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  reviewer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score           INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  recommendation  TEXT NOT NULL CHECK (recommendation IN ('accept','maybe','reject')),
  comments        TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (proposal_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS proposal_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id  INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Upgrades older databases. Each step runs once. Columns that were removed from the model
// (users.website, users.location, proposals.description) are left in place so no data is lost.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_xinfo(users)').all().map((c) => c.name);
  if (cols.includes('social')) db.exec('ALTER TABLE users RENAME COLUMN social TO linkedin_profile_url');
  if (!cols.includes('country')) {
    db.exec("ALTER TABLE users ADD COLUMN country TEXT NOT NULL DEFAULT ''");
    // Fill country from the old free-text location ("Paris, France") where it names one clearly.
    if (cols.includes('location')) {
      const set = db.prepare('UPDATE users SET country = ? WHERE id = ?');
      for (const u of db.prepare("SELECT id, location FROM users WHERE location != ''").all()) {
        const code = guessCountryCode(u.location);
        if (code) set.run(code, u.id);
      }
    }
  }
  if (!cols.includes('first_name')) splitNames(db);
}

// users.name was split into first_name and last_name; name became a generated full name.
function splitNames(db) {
  db.exec('BEGIN');
  try {
    db.exec("ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT ''");
    // Everything before the first space is the first name; the rest is the last name.
    db.exec(`UPDATE users SET
      first_name = CASE WHEN instr(trim(name), ' ') > 0 THEN substr(trim(name), 1, instr(trim(name), ' ') - 1) ELSE trim(name) END,
      last_name  = CASE WHEN instr(trim(name), ' ') > 0 THEN trim(substr(trim(name), instr(trim(name), ' ') + 1)) ELSE '' END`);
    db.exec('ALTER TABLE users DROP COLUMN name');
    db.exec("ALTER TABLE users ADD COLUMN name TEXT GENERATED ALWAYS AS (trim(first_name || ' ' || last_name)) VIRTUAL");
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const db = open(process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'cfp.db'));

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// Returns the stored value, generating and persisting a random one on first use.
function ensureSecret(key) {
  let value = getSetting(key);
  if (!value) {
    value = crypto.randomBytes(24).toString('hex');
    setSetting(key, value);
  }
  return value;
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { migrate, db, now, getSetting, setSetting, ensureSecret, transaction };
