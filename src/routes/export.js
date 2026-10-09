// Spreadsheet export endpoints.
//
//   /admin/export/<dataset>.csv | .xlsx      – for signed-in admins (browser download)
//   /admin/export/workbook.xlsx              – every dataset as a tab in one workbook
//   /api/export/<token>/<dataset>.csv|.xlsx  – the same files behind a secret token, for
//                                              automations (Google Sheets IMPORTDATA, Zapier,
//                                              Make, Power Automate, cron jobs...)
//   /api/export/<token>/<dataset>.json       – same rows as JSON
//
// Query parameters: conference=<id|slug>, status=<status>, updated_since=<ISO timestamp>
const crypto = require('node:crypto');
const express = require('express');
const { ensureSecret } = require('../db');
const { requireRole } = require('../auth');
const { STATUSES, getConference } = require('../model');
const { DATASETS, toCsv, toXlsx } = require('../export');

const router = express.Router();

function filtersFrom(query) {
  const filters = {};
  if (query.conference) {
    const conf = getConference(query.conference);
    filters.conferenceId = conf ? conf.id : -1;
    filters.slug = conf ? conf.slug : 'unknown';
  }
  if (STATUSES.includes(query.status)) filters.status = query.status;
  if (query.updated_since) {
    const d = new Date(String(query.updated_since));
    if (!Number.isNaN(d.getTime())) filters.updatedSince = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return filters;
}

async function send(res, dataset, ext, filters) {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${filters.slug ? `${filters.slug}-` : ''}${dataset}-${stamp}`;
  res.set('Cache-Control', 'no-store');
  if (dataset === 'workbook') {
    if (ext !== 'xlsx') return res.status(404).send('The workbook is only available as .xlsx');
    const sheets = Object.fromEntries(Object.entries(DATASETS).map(([name, fn]) => [name, fn(filters)]));
    res.attachment(`${base}.xlsx`);
    return res.send(Buffer.from(await toXlsx(sheets)));
  }
  const fn = DATASETS[dataset];
  if (!fn) return res.status(404).send(`Unknown dataset. Use one of: ${Object.keys(DATASETS).join(', ')}, workbook`);
  const rows = fn(filters);
  if (ext === 'csv') {
    res.type('text/csv; charset=utf-8');
    res.attachment(`${base}.csv`);
    return res.send(`﻿${toCsv(rows)}`);
  }
  if (ext === 'xlsx') {
    res.attachment(`${base}.xlsx`);
    return res.send(Buffer.from(await toXlsx({ [dataset]: rows })));
  }
  if (ext === 'json') return res.json(rows);
  return res.status(404).send('Unknown format. Use .csv, .xlsx or .json');
}

router.get('/admin/export/:file', requireRole('admin'), async (req, res) => {
  const m = /^([a-z]+)\.(csv|xlsx|json)$/.exec(req.params.file);
  if (!m) return res.status(404).send('Not found');
  await send(res, m[1], m[2], filtersFrom(req.query));
});

router.get('/api/export/:token/:file', async (req, res) => {
  const expected = Buffer.from(ensureSecret('export_token'));
  const given = Buffer.from(String(req.params.token));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).send('Invalid export token');
  }
  const m = /^([a-z]+)\.(csv|xlsx|json)$/.exec(req.params.file);
  if (!m) return res.status(404).send('Not found');
  await send(res, m[1], m[2], filtersFrom(req.query));
});

module.exports = router;
