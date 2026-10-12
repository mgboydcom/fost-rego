const express = require('express');
const { db, now, transaction } = require('../db');
const { requireLogin, flash, hashPassword, verifyPassword } = require('../auth');
const { formatDate, safeUrl } = require('../view-helpers');
const { COUNTRIES, isCountryCode } = require('../countries');
const {
  LEVELS, listConferences, getConference, getProposal, publicStatus, canSpeakerEdit, editDeadline, editWindow, logHistory,
} = require('../model');

const router = express.Router();

const PROFILE_FIELDS = ['first_name', 'last_name', 'organization', 'job_title', 'bio', 'linkedin_profile_url', 'phone', 'country', 'photo_url'];
// What speakers can set. The same title, abstract, level, co-speakers and notes go to every
// conference a speaker picks; format and topic are chosen per conference from that conference's lists.
const COMMON_FIELDS = ['title', 'abstract', 'level', 'co_speakers', 'notes'];
const PER_CONFERENCE_FIELDS = ['format', 'topic'];
const PROPOSAL_FIELDS = [...COMMON_FIELDS, ...PER_CONFERENCE_FIELDS];

// ---------- Profile ----------

// Returns an https linkedin.com URL, or null if the value isn't a LinkedIn address.
function normalizeLinkedIn(value) {
  const url = safeUrl(value);
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    u.protocol = 'https:';
    return u.toString();
  } catch {
    return null;
  }
}

router.get('/profile', requireLogin, (req, res) => {
  res.render('profile', { title: 'Your speaker profile', values: req.user, error: null });
});

router.post('/profile', requireLogin, (req, res) => {
  const values = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, String(req.body[f] || '').trim()]));
  if (values.linkedin_profile_url) values.linkedin_profile_url = normalizeLinkedIn(values.linkedin_profile_url);
  let error = null;
  if (!values.first_name) error = 'First name is required.';
  else if (values.country && !isCountryCode(values.country)) error = 'Please choose a country from the list.';
  else if (values.linkedin_profile_url === null) error = 'LinkedIn profile URL must be a linkedin.com address, like https://www.linkedin.com/in/your-name.';
  if (error) {
    return res.status(400).render('profile', { title: 'Your speaker profile', values: { ...req.user, ...values, linkedin_profile_url: String(req.body.linkedin_profile_url || '') }, error });
  }
  const sets = PROFILE_FIELDS.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...PROFILE_FIELDS.map((f) => values[f]), now(), req.user.id);
  // Touch the speaker's proposals so "updated since" exports pick up the new speaker details.
  db.prepare('UPDATE proposals SET updated_at = ? WHERE speaker_id = ?').run(now(), req.user.id);
  flash(req, 'success', 'Profile saved.');
  res.redirect('/profile');
});

router.post('/profile/password', requireLogin, (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (!verifyPassword(current, req.user.password_hash)) flash(req, 'error', 'Current password is incorrect.');
  else if (next.length < 8) flash(req, 'error', 'New password must be at least 8 characters.');
  else {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(next), now(), req.user.id);
    flash(req, 'success', 'Password changed.');
  }
  res.redirect('/profile');
});

// ---------- Proposals ----------

function readCommon(body) {
  const values = Object.fromEntries(COMMON_FIELDS.map((f) => [f, String(body[f] || '').trim()]));
  const errors = [];
  if (!values.title) errors.push('Title is required.');
  if (values.title.length > 200) errors.push('Title must be 200 characters or fewer.');
  if (!values.abstract) errors.push('Abstract is required.');
  if (values.abstract.length > 3000) errors.push('Abstract must be 3000 characters or fewer.');
  if (values.level && !LEVELS.includes(values.level)) errors.push('Please choose a valid audience level.');
  return { values, errors };
}

// Format and topic for one conference, posted as format_<id> and topic_<id>.
// `current` is the proposal being edited, so a topic an organiser set can be kept even if it's no longer listed.
function readConferenceChoice(body, conf, { label = '', current = null } = {}) {
  const pick = {
    format: String(body[`format_${conf.id}`] || '').trim(),
    topic: String(body[`topic_${conf.id}`] || '').trim(),
  };
  const errors = [];
  const where = label ? ` for ${conf.name}` : '';
  if (!conf.formatList.includes(pick.format) && !(current && pick.format === current.format)) {
    errors.push(`Please choose a session format${where}.`);
  }
  if (conf.topicList.length) {
    if (!conf.topicList.includes(pick.topic) && !(current && pick.topic && pick.topic === current.topic)) {
      errors.push(`Please choose a topic${where}.`);
    }
  } else if (!(current && pick.topic === current.topic)) {
    pick.topic = '';
  }
  return { pick, errors };
}

function renderForm(res, status, { title, confs, selected, values, picks, errors, proposal = null, edit = null }) {
  res.status(status).render('proposal-form', { title, confs, selected, values, picks, errors, proposal, edit, LEVELS });
}

function loadOwnProposal(req, res) {
  const proposal = getProposal(req.params.id);
  if (!proposal || proposal.speaker_id !== req.user.id) {
    res.status(404).render('error', { title: 'Not found', message: 'Proposal not found.' });
    return null;
  }
  return { proposal, conf: getConference(proposal.conference_id) };
}

router.get('/proposals', requireLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, c.name AS conference_name, c.slug AS conference_slug
    FROM proposals p JOIN conferences c ON c.id = p.conference_id
    WHERE p.speaker_id = ? ORDER BY p.submitted_at DESC`).all(req.user.id);
  const proposals = rows.map((p) => {
    const conf = getConference(p.conference_id);
    const edit = editWindow(p, conf);
    return { ...p, shownStatus: publicStatus(p, conf), editable: edit.editable, edit };
  });
  const openConfs = listConferences().filter((c) => c.cfpOpen);
  res.render('proposals', { title: 'My proposals', proposals, openConfs });
});

router.get('/proposals/new', requireLogin, (req, res) => {
  const openConfs = listConferences().filter((c) => c.cfpOpen);
  if (!openConfs.length) return res.render('choose-conference', { title: 'Submit a proposal', openConfs });
  const wanted = req.query.conference ? getConference(req.query.conference) : null;
  let selected = [];
  if (wanted && wanted.cfpOpen) selected = [wanted.id];
  else if (openConfs.length === 1) selected = [openConfs[0].id];
  renderForm(res, 200, { title: 'Submit a proposal', confs: openConfs, selected, values: { level: '' }, picks: {}, errors: [] });
});

router.post('/proposals', requireLogin, (req, res) => {
  const openConfs = listConferences().filter((c) => c.cfpOpen);
  const ids = [...new Set([].concat(req.body.conference_ids || []).map(Number))];
  const confs = ids.map((id) => getConference(id)).filter(Boolean);
  const closed = confs.filter((c) => !c.cfpOpen);
  const chosen = confs.filter((c) => c.cfpOpen);

  const { values, errors } = readCommon(req.body);
  const picks = {};
  if (!chosen.length) errors.unshift(closed.length ? 'That conference is no longer accepting proposals.' : 'Choose at least one conference to submit to.');
  for (const c of closed) errors.push(`${c.name} is no longer accepting proposals.`);
  for (const conf of chosen) {
    const r = readConferenceChoice(req.body, conf, { label: chosen.length > 1 });
    picks[conf.id] = r.pick;
    errors.push(...r.errors);
  }
  if (errors.length) {
    if (!openConfs.length) {
      flash(req, 'error', errors[0]);
      return res.redirect('/proposals');
    }
    return renderForm(res, 400, { title: 'Submit a proposal', confs: openConfs, selected: chosen.map((c) => c.id), values, picks, errors });
  }

  const newIds = transaction(() => chosen.map((conf) => {
    const row = { ...values, ...picks[conf.id] };
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO proposals (conference_id, speaker_id, ${PROPOSAL_FIELDS.join(', ')}, submitted_at, updated_at)
      VALUES (?, ?, ${PROPOSAL_FIELDS.map(() => '?').join(', ')}, ?, ?)`)
      .run(conf.id, req.user.id, ...PROPOSAL_FIELDS.map((f) => row[f]), now(), now());
    logHistory(Number(lastInsertRowid), req.user.id, 'submitted');
    return Number(lastInsertRowid);
  }));
  if (chosen.length === 1) {
    const deadline = editDeadline(chosen[0]);
    flash(req, 'success', `Thanks! Your proposal has been submitted. You can keep editing it${deadline ? ` until ${formatDate(deadline)}, the day before the conference` : ''}.`);
    return res.redirect(`/proposals/${newIds[0]}`);
  }
  flash(req, 'success', `Thanks! Your proposal has been submitted to ${chosen.length} conferences: ${chosen.map((c) => c.name).join(', ')}. Each one is reviewed separately, and you can edit each one on its own.`);
  res.redirect('/proposals');
});

router.get('/proposals/:id', requireLogin, (req, res) => {
  const proposal = getProposal(req.params.id);
  if (proposal && proposal.speaker_id !== req.user.id && ['admin', 'reviewer'].includes(req.user.role)) {
    return res.redirect(`/review/proposals/${proposal.id}`);
  }
  const found = loadOwnProposal(req, res);
  if (!found) return;
  const { conf } = found;
  const history = db.prepare(`
    SELECT h.*, u.name AS user_name FROM proposal_history h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.proposal_id = ? AND h.action IN ('submitted','edited','withdrawn','confirmed','declined')
    ORDER BY h.id DESC`).all(found.proposal.id);
  res.render('proposal', {
    title: found.proposal.title,
    p: found.proposal,
    conf,
    shownStatus: publicStatus(found.proposal, conf),
    editable: canSpeakerEdit(found.proposal, conf),
    edit: editWindow(found.proposal, conf),
    history,
  });
});

router.get('/proposals/:id/edit', requireLogin, (req, res) => {
  const found = loadOwnProposal(req, res);
  if (!found) return;
  const { proposal, conf } = found;
  if (!canSpeakerEdit(proposal, conf)) {
    flash(req, 'error', 'This proposal can no longer be edited.');
    return res.redirect(`/proposals/${proposal.id}`);
  }
  renderForm(res, 200, {
    title: 'Edit proposal', confs: [conf], selected: [conf.id], values: proposal,
    picks: { [conf.id]: { format: proposal.format, topic: proposal.topic } }, errors: [], proposal, edit: editWindow(proposal, conf),
  });
});

router.post('/proposals/:id/edit', requireLogin, (req, res) => {
  const found = loadOwnProposal(req, res);
  if (!found) return;
  const { proposal, conf } = found;
  if (!canSpeakerEdit(proposal, conf)) {
    flash(req, 'error', 'This proposal can no longer be edited.');
    return res.redirect(`/proposals/${proposal.id}`);
  }
  const common = readCommon(req.body);
  const choice = readConferenceChoice(req.body, conf, { current: proposal });
  const errors = [...common.errors, ...choice.errors];
  if (errors.length) {
    return renderForm(res, 400, {
      title: 'Edit proposal', confs: [conf], selected: [conf.id], values: common.values,
      picks: { [conf.id]: choice.pick }, errors, proposal, edit: editWindow(proposal, conf),
    });
  }
  const values = { ...common.values, ...choice.pick };
  const changed = PROPOSAL_FIELDS.filter((f) => String(values[f] ?? '') !== String(proposal[f] ?? ''));
  if (changed.length) {
    transaction(() => {
      db.prepare(`UPDATE proposals SET ${PROPOSAL_FIELDS.map((f) => `${f} = ?`).join(', ')},
                  version = version + 1, updated_at = ? WHERE id = ?`)
        .run(...PROPOSAL_FIELDS.map((f) => values[f]), now(), proposal.id);
      logHistory(proposal.id, req.user.id, 'edited', `Changed: ${changed.join(', ')}`);
    });
    flash(req, 'success', 'Proposal updated.');
  } else {
    flash(req, 'info', 'No changes to save.');
  }
  res.redirect(`/proposals/${proposal.id}`);
});

router.post('/proposals/:id/withdraw', requireLogin, (req, res) => {
  const found = loadOwnProposal(req, res);
  if (!found) return;
  const { proposal } = found;
  if (proposal.status === 'withdrawn') return res.redirect(`/proposals/${proposal.id}`);
  transaction(() => {
    db.prepare("UPDATE proposals SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(now(), proposal.id);
    logHistory(proposal.id, req.user.id, 'withdrawn', `Previous status: ${proposal.status}`);
  });
  flash(req, 'success', 'Your proposal has been withdrawn.');
  res.redirect(`/proposals/${proposal.id}`);
});

router.post('/proposals/:id/confirm', requireLogin, (req, res) => {
  const found = loadOwnProposal(req, res);
  if (!found) return;
  const { proposal, conf } = found;
  const answer = req.body.answer === 'decline' ? 'declined' : 'confirmed';
  if (proposal.status !== 'accepted' || !conf.decisions_published) {
    flash(req, 'error', 'Only accepted proposals can be confirmed.');
    return res.redirect(`/proposals/${proposal.id}`);
  }
  transaction(() => {
    db.prepare('UPDATE proposals SET speaker_confirmation = ?, confirmed_at = ?, updated_at = ? WHERE id = ?')
      .run(answer, now(), now(), proposal.id);
    logHistory(proposal.id, req.user.id, answer);
  });
  flash(req, 'success', answer === 'confirmed'
    ? 'Thank you for confirming! The organisers will be in touch with next steps.'
    : 'You have declined this speaking slot. The organisers have been notified.');
  res.redirect(`/proposals/${proposal.id}`);
});

module.exports = router;
