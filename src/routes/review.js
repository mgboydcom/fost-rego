const express = require('express');
const { db, now, transaction } = require('../db');
const { requireRole, flash } = require('../auth');
const {
  DECISIONS, RECOMMENDATIONS, STATUSES, listConferences, getConference, getProposal, isReviewerFor, logHistory,
} = require('../model');

const router = express.Router();
router.use(requireRole('reviewer', 'admin'));

function assignedConferences(user) {
  if (user.role === 'admin') return listConferences({ includeArchived: true });
  return db.prepare(`SELECT c.id FROM conferences c JOIN conference_reviewers cr ON cr.conference_id = c.id
                     WHERE cr.user_id = ? ORDER BY c.start_date DESC`).all(user.id)
    .map((c) => getConference(c.id));
}

const hideSpeaker = (user, conf) => conf.blind_review && user.role !== 'admin';

router.get('/', (req, res) => {
  const conferences = assignedConferences(req.user).map((conf) => {
    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(EXISTS (SELECT 1 FROM reviews r WHERE r.proposal_id = p.id AND r.reviewer_id = ?)) AS reviewed_by_me,
             SUM(p.status = 'accepted') AS accepted
      FROM proposals p WHERE p.conference_id = ? AND p.status != 'withdrawn' AND p.speaker_id != ?`)
      .get(req.user.id, conf.id, req.user.id);
    return { ...conf, stats };
  });
  res.render('review-home', { title: 'Program committee', conferences });
});

router.get('/conferences/:id', (req, res) => {
  const conf = getConference(req.params.id);
  if (!conf || !isReviewerFor(req.user, conf.id)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Conference not found or you are not on its committee.' });
  }
  const filter = {
    status: STATUSES.includes(req.query.status) ? req.query.status : '',
    track: conf.trackList.includes(req.query.track) ? req.query.track : '',
    todo: req.query.todo === '1',
    sort: ['score', 'reviews', 'title', 'newest'].includes(req.query.sort) ? req.query.sort : 'newest',
  };
  const clauses = ['p.conference_id = ?'];
  const params = [req.user.id, conf.id];
  if (filter.status) { clauses.push('p.status = ?'); params.push(filter.status); } else clauses.push("p.status != 'withdrawn'");
  if (filter.track) { clauses.push('p.track = ?'); params.push(filter.track); }
  if (filter.todo) clauses.push('my.id IS NULL AND p.speaker_id != ' + Number(req.user.id));
  const order = {
    score: 'avg_score IS NULL, avg_score DESC',
    reviews: 'review_count ASC',
    title: 'p.title COLLATE NOCASE',
    newest: 'p.submitted_at DESC',
  }[filter.sort];
  const proposals = db.prepare(`
    SELECT p.id, p.title, p.format, p.track, p.level, p.status, p.speaker_confirmation, p.submitted_at, p.speaker_id,
           u.name AS speaker_name, u.organization AS speaker_organization,
           (SELECT COUNT(*) FROM reviews r WHERE r.proposal_id = p.id) AS review_count,
           (SELECT ROUND(AVG(score), 2) FROM reviews r WHERE r.proposal_id = p.id) AS avg_score,
           my.score AS my_score, my.recommendation AS my_recommendation
    FROM proposals p
    JOIN users u ON u.id = p.speaker_id
    LEFT JOIN reviews my ON my.proposal_id = p.id AND my.reviewer_id = ?
    WHERE ${clauses.join(' AND ')}
    ORDER BY ${order}`).all(...params);
  const counts = Object.fromEntries(db.prepare(
    'SELECT status, COUNT(*) AS n FROM proposals WHERE conference_id = ? GROUP BY status').all(conf.id)
    .map((r) => [r.status, r.n]));
  res.render('review-list', {
    title: `Review: ${conf.name}`, conf, proposals, filter, counts, STATUSES, DECISIONS,
    blind: hideSpeaker(req.user, conf), returnTo: req.originalUrl,
  });
});

function loadForReview(req, res) {
  const p = getProposal(req.params.id);
  if (!p || !isReviewerFor(req.user, p.conference_id)) {
    res.status(404).render('error', { title: 'Not found', message: 'Proposal not found or you are not on its committee.' });
    return null;
  }
  return { p, conf: getConference(p.conference_id) };
}

router.get('/proposals/:id', (req, res) => {
  const found = loadForReview(req, res);
  if (!found) return;
  const { p, conf } = found;
  const myReview = db.prepare('SELECT * FROM reviews WHERE proposal_id = ? AND reviewer_id = ?').get(p.id, req.user.id);
  const isOwn = p.speaker_id === req.user.id;
  // Reviewers see colleagues' reviews only after submitting their own, to avoid anchoring.
  const showOthers = req.user.role === 'admin' || !!myReview;
  const reviews = showOthers ? db.prepare(`
    SELECT r.*, u.name AS reviewer_name FROM reviews r JOIN users u ON u.id = r.reviewer_id
    WHERE r.proposal_id = ? ORDER BY r.updated_at DESC`).all(p.id) : [];
  const summary = db.prepare(`SELECT COUNT(*) AS n, ROUND(AVG(score), 2) AS avg FROM reviews WHERE proposal_id = ?`).get(p.id);
  const history = req.user.role === 'admin' ? db.prepare(`
    SELECT h.*, u.name AS user_name FROM proposal_history h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.proposal_id = ? ORDER BY h.id DESC`).all(p.id) : [];
  const ids = db.prepare(`SELECT id FROM proposals WHERE conference_id = ? AND status != 'withdrawn' ORDER BY submitted_at DESC`)
    .all(conf.id).map((r) => r.id);
  const idx = ids.indexOf(p.id);
  res.render('review-proposal', {
    title: p.title, p, conf, myReview, reviews, showOthers, summary, history, isOwn,
    blind: hideSpeaker(req.user, conf), RECOMMENDATIONS, DECISIONS,
    prevId: idx > 0 ? ids[idx - 1] : null,
    nextId: idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null,
  });
});

router.post('/proposals/:id/review', (req, res) => {
  const found = loadForReview(req, res);
  if (!found) return;
  const { p } = found;
  if (p.speaker_id === req.user.id) {
    flash(req, 'error', 'You cannot review your own proposal.');
    return res.redirect(`/review/proposals/${p.id}`);
  }
  const score = Number(req.body.score);
  const recommendation = String(req.body.recommendation || '');
  const comments = String(req.body.comments || '').trim();
  if (!Number.isInteger(score) || score < 1 || score > 5 || !RECOMMENDATIONS.includes(recommendation)) {
    flash(req, 'error', 'Please give a score from 1 to 5 and a recommendation.');
    return res.redirect(`/review/proposals/${p.id}`);
  }
  db.prepare(`
    INSERT INTO reviews (proposal_id, reviewer_id, score, recommendation, comments, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (proposal_id, reviewer_id) DO UPDATE SET
      score = excluded.score, recommendation = excluded.recommendation, comments = excluded.comments, updated_at = excluded.updated_at`)
    .run(p.id, req.user.id, score, recommendation, comments, now(), now());
  flash(req, 'success', 'Review saved.');
  const next = req.body.next && /^\d+$/.test(req.body.next) ? `/review/proposals/${req.body.next}` : `/review/proposals/${p.id}`;
  res.redirect(next);
});

function applyDecision(proposal, status, userId, extra = {}) {
  const sets = ['updated_at = ?'];
  const params = [now()];
  if (status !== proposal.status) {
    sets.push('status = ?', 'decided_at = ?');
    params.push(status, status === 'submitted' ? '' : now());
    // A new decision resets any earlier confirmation from the speaker.
    if (status !== 'accepted') { sets.push("speaker_confirmation = ''", "confirmed_at = ''"); }
  }
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); params.push(v); }
  db.prepare(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`).run(...params, proposal.id);
  if (status !== proposal.status) logHistory(proposal.id, userId, 'decision', `${proposal.status} → ${status}`);
}

router.post('/proposals/:id/decision', requireRole('admin'), (req, res) => {
  const found = loadForReview(req, res);
  if (!found) return;
  const { p } = found;
  const status = String(req.body.status || '');
  if (!DECISIONS.includes(status) || p.status === 'withdrawn') {
    flash(req, 'error', p.status === 'withdrawn' ? 'This proposal was withdrawn by the speaker.' : 'Choose a valid decision.');
    return res.redirect(`/review/proposals/${p.id}`);
  }
  transaction(() => applyDecision(p, status, req.user.id, {
    feedback_to_speaker: String(req.body.feedback_to_speaker || '').trim(),
    internal_notes: String(req.body.internal_notes || '').trim(),
  }));
  flash(req, 'success', 'Decision saved.');
  res.redirect(`/review/proposals/${p.id}`);
});

router.post('/conferences/:id/bulk-decision', requireRole('admin'), (req, res) => {
  const conf = getConference(req.params.id);
  if (!conf) return res.status(404).render('error', { title: 'Not found', message: 'Conference not found.' });
  const status = String(req.body.status || '');
  const ids = [].concat(req.body.ids || []).map(Number).filter(Number.isInteger);
  if (!DECISIONS.includes(status) || !ids.length) {
    flash(req, 'error', 'Select at least one proposal and a decision.');
  } else {
    let n = 0;
    transaction(() => {
      for (const id of ids) {
        const p = db.prepare('SELECT * FROM proposals WHERE id = ? AND conference_id = ?').get(id, conf.id);
        if (p && p.status !== 'withdrawn') { applyDecision(p, status, req.user.id); n += 1; }
      }
    });
    flash(req, 'success', `Updated ${n} proposal${n === 1 ? '' : 's'}.`);
  }
  const back = String(req.body.return_to || '');
  res.redirect(back.startsWith(`/review/conferences/${conf.id}`) ? back : `/review/conferences/${conf.id}`);
});

module.exports = router;
