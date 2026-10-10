const express = require('express');
const { db, now, transaction } = require('../db');
const { requireLogin, flash, hashPassword, verifyPassword } = require('../auth');
const { formatDate } = require('../view-helpers');
const {
  LEVELS, listConferences, getConference, getProposal, publicStatus, canSpeakerEdit, editDeadline, editWindow, logHistory,
} = require('../model');

const router = express.Router();

const PROFILE_FIELDS = ['name', 'organization', 'job_title', 'bio', 'website', 'social', 'phone', 'location', 'photo_url'];
const PROPOSAL_FIELDS = ['title', 'abstract', 'description', 'format', 'track', 'level', 'duration_minutes', 'co_speakers', 'notes'];

// ---------- Profile ----------

router.get('/profile', requireLogin, (req, res) => {
  res.render('profile', { title: 'Your speaker profile', values: req.user, error: null });
});

router.post('/profile', requireLogin, (req, res) => {
  const values = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, String(req.body[f] || '').trim()]));
  if (!values.name) {
    return res.status(400).render('profile', { title: 'Your speaker profile', values: { ...req.user, ...values }, error: 'Name is required.' });
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

function readProposal(body, conf) {
  const values = Object.fromEntries(PROPOSAL_FIELDS.map((f) => [f, String(body[f] || '').trim()]));
  const errors = [];
  if (!values.title) errors.push('Title is required.');
  if (values.title.length > 200) errors.push('Title must be 200 characters or fewer.');
  if (!values.abstract) errors.push('Abstract is required.');
  if (values.abstract.length > 3000) errors.push('Abstract must be 3000 characters or fewer.');
  if (!conf.formatList.includes(values.format)) errors.push('Please choose a session format.');
  if (conf.trackList.length && !conf.trackList.includes(values.track)) errors.push('Please choose a track.');
  if (!conf.trackList.length) values.track = '';
  if (values.level && !LEVELS.includes(values.level)) errors.push('Please choose a valid audience level.');
  if (values.duration_minutes === '') values.duration_minutes = null;
  else {
    const n = Number(values.duration_minutes);
    if (!Number.isInteger(n) || n < 5 || n > 480) errors.push('Duration must be a whole number of minutes between 5 and 480.');
    else values.duration_minutes = n;
  }
  return { values, errors };
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
  const conf = req.query.conference ? getConference(req.query.conference) : null;
  if (!conf || !conf.cfpOpen) {
    return res.render('choose-conference', { title: 'Choose a conference', openConfs });
  }
  res.render('proposal-form', {
    title: `Submit to ${conf.name}`, conf, openConfs, values: { level: '' }, errors: [], proposal: null, LEVELS,
  });
});

router.post('/proposals', requireLogin, (req, res) => {
  const conf = getConference(req.body.conference_id);
  if (!conf || !conf.cfpOpen) {
    flash(req, 'error', 'That conference is not accepting proposals.');
    return res.redirect('/proposals/new');
  }
  const { values, errors } = readProposal(req.body, conf);
  if (errors.length) {
    return res.status(400).render('proposal-form', {
      title: `Submit to ${conf.name}`, conf, openConfs: [], values, errors, proposal: null, LEVELS,
    });
  }
  const id = transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO proposals (conference_id, speaker_id, ${PROPOSAL_FIELDS.join(', ')}, submitted_at, updated_at)
      VALUES (?, ?, ${PROPOSAL_FIELDS.map(() => '?').join(', ')}, ?, ?)`)
      .run(conf.id, req.user.id, ...PROPOSAL_FIELDS.map((f) => values[f]), now(), now());
    logHistory(Number(lastInsertRowid), req.user.id, 'submitted');
    return Number(lastInsertRowid);
  });
  const deadline = editDeadline(conf);
  flash(req, 'success', `Thanks! Your proposal has been submitted. You can keep editing it${deadline ? ` until ${formatDate(deadline)}, the day before the conference` : ''}.`);
  res.redirect(`/proposals/${id}`);
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
  if (!canSpeakerEdit(found.proposal, found.conf)) {
    flash(req, 'error', 'This proposal can no longer be edited.');
    return res.redirect(`/proposals/${found.proposal.id}`);
  }
  res.render('proposal-form', {
    title: 'Edit proposal', conf: found.conf, openConfs: [], values: found.proposal, errors: [], proposal: found.proposal, LEVELS,
    edit: editWindow(found.proposal, found.conf),
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
  const { values, errors } = readProposal(req.body, conf);
  if (errors.length) {
    return res.status(400).render('proposal-form', {
      title: 'Edit proposal', conf, openConfs: [], values, errors, proposal, LEVELS, edit: editWindow(proposal, conf),
    });
  }
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
