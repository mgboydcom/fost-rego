// Spreadsheet exports. Every export is a flat table with stable, snake_case column
// headers so it can be fed straight into mail merges, Zapier/Make, Google Sheets
// IMPORTDATA, Airtable syncs, etc.
const ExcelJS = require('exceljs');
const { db } = require('./db');
const { countryName } = require('./countries');

const BASE_URL = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// Where to get a speaker's headshot: their own photo URL if given, otherwise their LinkedIn profile photo.
const headshotSource = (photoUrl, linkedinUrl) => (photoUrl ? 'photo_url' : linkedinUrl ? 'linkedin' : 'missing');

function where(filters, alias = 'p') {
  const clauses = [];
  const params = [];
  if (filters.conferenceId) { clauses.push(`${alias}.conference_id = ?`); params.push(filters.conferenceId); }
  if (filters.status) { clauses.push(`${alias}.status = ?`); params.push(filters.status); }
  if (filters.updatedSince) { clauses.push(`${alias}.updated_at >= ?`); params.push(filters.updatedSince); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function submissions(filters = {}) {
  const w = where(filters);
  const rows = db.prepare(`
    SELECT p.id AS proposal_id, c.name AS conference, c.slug AS conference_slug,
           p.title, p.format, p.track, p.level, p.duration_minutes, p.abstract,
           p.co_speakers, p.notes AS notes_to_committee,
           p.status, c.decisions_published, p.speaker_confirmation, p.feedback_to_speaker, p.internal_notes,
           u.id AS speaker_id, u.name AS speaker_name, u.first_name AS speaker_first_name, u.last_name AS speaker_last_name,
           u.email AS speaker_email, u.organization AS speaker_organization,
           u.job_title AS speaker_job_title, u.phone AS speaker_phone, u.country AS speaker_country, u.country AS speaker_country_code,
           u.linkedin_profile_url AS speaker_linkedin_profile_url, u.photo_url AS speaker_photo_url, u.bio AS speaker_bio,
           (SELECT COUNT(*) FROM reviews r WHERE r.proposal_id = p.id) AS review_count,
           (SELECT ROUND(AVG(score), 2) FROM reviews r WHERE r.proposal_id = p.id) AS average_score,
           (SELECT COUNT(*) FROM reviews r WHERE r.proposal_id = p.id AND r.recommendation = 'accept') AS votes_accept,
           (SELECT COUNT(*) FROM reviews r WHERE r.proposal_id = p.id AND r.recommendation = 'maybe') AS votes_maybe,
           (SELECT COUNT(*) FROM reviews r WHERE r.proposal_id = p.id AND r.recommendation = 'reject') AS votes_reject,
           p.version, p.submitted_at, p.updated_at, p.decided_at, p.confirmed_at
    FROM proposals p
    JOIN users u ON u.id = p.speaker_id
    JOIN conferences c ON c.id = p.conference_id
    ${w.sql}
    ORDER BY c.id, p.id`).all(...w.params);
  return rows.map((r) => ({
    ...r,
    speaker_country: countryName(r.speaker_country),
    speaker_headshot_source: headshotSource(r.speaker_photo_url, r.speaker_linkedin_profile_url),
    decisions_published: r.decisions_published ? 'yes' : 'no',
    average_score: r.average_score ?? '',
    duration_minutes: r.duration_minutes ?? '',
    proposal_url: `${BASE_URL()}/proposals/${r.proposal_id}`,
    review_url: `${BASE_URL()}/review/proposals/${r.proposal_id}`,
  }));
}

function program(filters = {}) {
  return submissions({ ...filters, status: 'accepted' }).map((r) => ({
    proposal_id: r.proposal_id,
    conference: r.conference,
    title: r.title,
    format: r.format,
    track: r.track,
    level: r.level,
    duration_minutes: r.duration_minutes,
    abstract: r.abstract,
    speaker_name: r.speaker_name,
    speaker_first_name: r.speaker_first_name,
    speaker_last_name: r.speaker_last_name,
    speaker_email: r.speaker_email,
    speaker_organization: r.speaker_organization,
    speaker_job_title: r.speaker_job_title,
    speaker_country: r.speaker_country,
    speaker_bio: r.speaker_bio,
    speaker_photo_url: r.speaker_photo_url,
    speaker_headshot_source: r.speaker_headshot_source,
    speaker_linkedin_profile_url: r.speaker_linkedin_profile_url,
    co_speakers: r.co_speakers,
    decisions_published: r.decisions_published,
    speaker_confirmation: r.speaker_confirmation || 'pending',
    confirmed_at: r.confirmed_at,
    decided_at: r.decided_at,
    updated_at: r.updated_at,
  }));
}

function speakers(filters = {}) {
  const w = where(filters);
  return db.prepare(`
    SELECT u.id AS speaker_id, u.name, u.first_name, u.last_name, u.email, u.organization, u.job_title, u.phone, u.country, u.country AS country_code,
           u.linkedin_profile_url, u.photo_url, u.bio,
           COUNT(p.id) AS proposals_total,
           SUM(p.status = 'accepted') AS proposals_accepted,
           SUM(p.status = 'waitlisted') AS proposals_waitlisted,
           SUM(p.status = 'rejected') AS proposals_rejected,
           SUM(p.status = 'submitted') AS proposals_pending,
           SUM(p.status = 'withdrawn') AS proposals_withdrawn,
           SUM(p.speaker_confirmation = 'confirmed') AS talks_confirmed,
           GROUP_CONCAT(DISTINCT c.name) AS conferences,
           u.created_at, u.updated_at
    FROM users u
    JOIN proposals p ON p.speaker_id = u.id
    JOIN conferences c ON c.id = p.conference_id
    ${w.sql}
    GROUP BY u.id
    ORDER BY u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE`).all(...w.params)
    .map((r) => ({ ...r, country: countryName(r.country), headshot_source: headshotSource(r.photo_url, r.linkedin_profile_url) }));
}

function reviews(filters = {}) {
  const w = where(filters);
  return db.prepare(`
    SELECT r.id AS review_id, p.id AS proposal_id, c.name AS conference, p.title, u.name AS speaker_name,
           rv.name AS reviewer_name, rv.email AS reviewer_email,
           r.score, r.recommendation, r.comments, r.created_at, r.updated_at
    FROM reviews r
    JOIN proposals p ON p.id = r.proposal_id
    JOIN users u ON u.id = p.speaker_id
    JOIN users rv ON rv.id = r.reviewer_id
    JOIN conferences c ON c.id = p.conference_id
    ${w.sql}
    ORDER BY p.id, r.id`).all(...w.params);
}

function conferences() {
  return db.prepare(`
    SELECT c.id AS conference_id, c.name, c.slug, c.location, c.website, c.start_date, c.end_date,
           c.cfp_opens, c.cfp_closes, c.blind_review, c.decisions_published, c.archived,
           COUNT(p.id) AS proposals_total,
           SUM(p.status = 'accepted') AS proposals_accepted,
           SUM(p.speaker_confirmation = 'confirmed') AS talks_confirmed
    FROM conferences c LEFT JOIN proposals p ON p.conference_id = c.id
    GROUP BY c.id ORDER BY c.start_date, c.id`).all()
    .map((r) => ({
      ...r,
      blind_review: r.blind_review ? 'yes' : 'no',
      decisions_published: r.decisions_published ? 'yes' : 'no',
      archived: r.archived ? 'yes' : 'no',
      proposals_accepted: r.proposals_accepted || 0,
      talks_confirmed: r.talks_confirmed || 0,
    }));
}

const DATASETS = { submissions, program, speakers, reviews, conferences };

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection from user-entered text.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\r\n') + '\r\n';
}

async function toXlsx(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'fost-rego';
  wb.created = new Date();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name.charAt(0).toUpperCase() + name.slice(1));
    const headers = rows.length ? Object.keys(rows[0]) : ['(no rows)'];
    ws.columns = headers.map((h) => ({
      header: h,
      key: h,
      width: Math.min(60, Math.max(12, h.length + 2, ...rows.slice(0, 50).map((r) => String(r[h] ?? '').length * 0.6))),
    }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { DATASETS, toCsv, toXlsx };
