const { db, now } = require('./db');

const DEFAULT_FORMATS = ['Talk (30 min)', 'Lightning talk (10 min)', 'Workshop (90 min)', 'Panel (45 min)'];
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'All levels'];
const STATUSES = ['submitted', 'accepted', 'waitlisted', 'rejected', 'withdrawn'];
const DECISIONS = ['submitted', 'accepted', 'waitlisted', 'rejected'];
const RECOMMENDATIONS = ['accept', 'maybe', 'reject'];

const lines = (text) => String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function decorateConference(conf) {
  if (!conf) return conf;
  conf.trackList = lines(conf.tracks);
  conf.formatList = lines(conf.formats).length ? lines(conf.formats) : DEFAULT_FORMATS;
  conf.cfpState = cfpState(conf);
  conf.cfpOpen = conf.cfpState === 'open';
  return conf;
}

// Dates are stored as YYYY-MM-DD (inclusive). Empty opens = open now, empty closes = never closes.
function cfpState(conf, today = new Date().toISOString().slice(0, 10)) {
  if (conf.archived) return 'archived';
  if (conf.cfp_opens && today < conf.cfp_opens) return 'upcoming';
  if (conf.cfp_closes && today > conf.cfp_closes) return 'closed';
  return 'open';
}

function getConference(idOrSlug) {
  const conf = /^\d+$/.test(String(idOrSlug))
    ? db.prepare('SELECT * FROM conferences WHERE id = ?').get(Number(idOrSlug))
    : db.prepare('SELECT * FROM conferences WHERE slug = ?').get(String(idOrSlug));
  return decorateConference(conf);
}

function listConferences({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM conferences ORDER BY start_date DESC, id DESC'
    : 'SELECT * FROM conferences WHERE archived = 0 ORDER BY start_date ASC, id ASC';
  return db.prepare(sql).all().map(decorateConference);
}

function getProposal(id) {
  return db.prepare(`
    SELECT p.*, u.name AS speaker_name, u.email AS speaker_email, u.organization AS speaker_organization,
           u.job_title AS speaker_job_title, u.bio AS speaker_bio, u.website AS speaker_website,
           u.linkedin_profile_url AS speaker_linkedin_profile_url, u.location AS speaker_location, u.photo_url AS speaker_photo_url,
           c.name AS conference_name, c.slug AS conference_slug
    FROM proposals p
    JOIN users u ON u.id = p.speaker_id
    JOIN conferences c ON c.id = p.conference_id
    WHERE p.id = ?`).get(Number(id));
}

// What the speaker is allowed to see: decisions stay "under review" until the organisers publish them.
function publicStatus(proposal, conf) {
  if (proposal.status === 'withdrawn') return 'withdrawn';
  if (!conf.decisions_published || proposal.status === 'submitted') return 'under review';
  return proposal.status;
}

const DAY_MS = 86400000;
const todayUtc = () => new Date().toISOString().slice(0, 10);

// Speakers may keep editing after the call closes, right up to the conference:
// the last editing day is the day before start_date. No start date = no deadline.
function editDeadline(conf) {
  if (!conf.start_date) return '';
  return new Date(Date.parse(`${conf.start_date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

function canSpeakerEdit(proposal, conf, today = todayUtc()) {
  if (proposal.status === 'withdrawn' || conf.archived) return false;
  // Unpublished decisions must not change what the speaker can do, or the edit link would leak them.
  if (conf.decisions_published) {
    if (proposal.status === 'rejected') return false;
    if (proposal.speaker_confirmation === 'declined') return false;
  }
  const deadline = editDeadline(conf);
  return !deadline || today <= deadline;
}

// Everything the "time left to edit" label needs.
function editWindow(proposal, conf, today = todayUtc()) {
  const deadline = editDeadline(conf);
  const editable = canSpeakerEdit(proposal, conf, today);
  if (!editable) return { editable, deadline, daysLeft: null, label: 'Editing closed', tone: 'closed' };
  if (!deadline) return { editable, deadline, daysLeft: null, label: 'No edit deadline', tone: 'open' };
  const daysLeft = Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  const label = daysLeft === 0 ? 'Last day to edit' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left to edit`;
  return { editable, deadline, daysLeft, label, tone: daysLeft <= 7 ? 'soon' : 'open' };
}

function isReviewerFor(user, conferenceId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'reviewer') return false;
  return !!db.prepare('SELECT 1 FROM conference_reviewers WHERE conference_id = ? AND user_id = ?')
    .get(Number(conferenceId), user.id);
}

function logHistory(proposalId, userId, action, detail = '') {
  db.prepare('INSERT INTO proposal_history (proposal_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(proposalId, userId, action, detail, now());
}

function slugify(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conference';
}

module.exports = {
  DEFAULT_FORMATS, LEVELS, STATUSES, DECISIONS, RECOMMENDATIONS,
  lines, cfpState, decorateConference, getConference, listConferences, getProposal,
  publicStatus, canSpeakerEdit, editDeadline, editWindow, isReviewerFor, logHistory, slugify,
};
