const STATUS_LABELS = {
  submitted: 'Pending decision',
  'under review': 'Under review',
  accepted: 'Accepted',
  waitlisted: 'Waitlisted',
  rejected: 'Not accepted',
  withdrawn: 'Withdrawn',
};

const CFP_LABELS = { open: 'CFP open', upcoming: 'CFP opens soon', closed: 'CFP closed', archived: 'Archived' };

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function badgeClass(status) {
  return `badge badge-${String(status).replace(/\s+/g, '-')}`;
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function dateRange(start, end) {
  if (!start) return '';
  if (!end || end === start) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
}

// Only allow http(s) links in user-supplied URLs (blocks javascript: and friends).
function safeUrl(value) {
  const s = String(value || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return `https://${s}`;
  return '';
}

module.exports = { safeUrl, statusLabel, badgeClass, formatDate, dateRange, CFP_LABELS };
