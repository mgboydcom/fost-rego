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
           u.social AS speaker_social, u.location AS speaker_location, u.photo_url AS speaker_photo_url,
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

function canSpeakerEdit(proposal, conf) {
  if (proposal.status === 'withdrawn' || proposal.status === 'rejected') return false;
  if (proposal.status === 'accepted' && conf.decisions_published) return proposal.speaker_confirmation !== 'declined';
  return conf.cfpOpen;
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
  publicStatus, canSpeakerEdit, isReviewerFor, logHistory, slugify,
};
