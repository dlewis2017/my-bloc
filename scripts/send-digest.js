require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const VOTE_BASE_URL = process.env.VOTE_BASE_URL || 'https://your-app.vercel.app';

// Jersey City Council — term Jan 2026 – Jan 2030
// Email pattern: {FirstInitial}{LastName}@jcnj.org
const COUNCIL_REPS = {
  A: { name: 'Denise Ridley',     email: 'DRidley@jcnj.org' },
  B: { name: 'Joel Brooks',       email: 'JBrooks@jcnj.org' },
  C: { name: 'Thomas Zuppa Jr.',  email: 'TZuppa@jcnj.org' },
  D: { name: 'Jake Ephros',       email: 'JEphros@jcnj.org' },
  E: { name: 'Eleana Little',     email: 'ELittle@jcnj.org' },
  F: { name: 'Frank E. Gilmore',  email: 'FGilmore@jcnj.org' },
};

/**
 * Build a single item block for the digest email.
 */
function buildItemHtml(item, userId, ward) {
  const statusColors = {
    INTRODUCED: '#3b82f6',
    AMENDED: '#f59e0b',
    COMMITTEE: '#8b5cf6',
    VOTED: '#6366f1',
    PASSED: '#10b981',
    FAILED: '#ef4444',
    WITHDRAWN: '#6b7280'
  };

  const impactIcons = {
    housing: '\u{1F3E0}',
    money: '\u{1F4B0}',
    transit: '\u{1F68C}',
    schools: '\u{1F393}',
    safety: '\u{1F6E1}\uFE0F',
    environment: '\u{1F333}',
    development: '\u{1F3D7}\uFE0F',
    jobs: '\u{1F4BC}',
    government: '\u{1F3DB}\uFE0F'
  };

  const impactColors = {
    housing: '#7c3aed',
    money: '#059669',
    transit: '#2563eb',
    schools: '#d97706',
    safety: '#dc2626',
    environment: '#16a34a',
    development: '#9333ea',
    jobs: '#0891b2',
    government: '#6b7280'
  };

  const statusColor = statusColors[item.current_status] || '#6b7280';
  const category = item.impact_category || 'government';
  const icon = impactIcons[category] || '\u{1F3DB}\uFE0F';
  const catColor = impactColors[category] || '#6b7280';

  const voteUpUrl = `${VOTE_BASE_URL}/api/vote?user=${userId}&item=${encodeURIComponent(item.ordinance_id || '')}&vote=up`;
  const voteDownUrl = `${VOTE_BASE_URL}/api/vote?user=${userId}&item=${encodeURIComponent(item.ordinance_id || '')}&vote=down`;

  const totalVotes = item.vote_totals ? (item.vote_totals.up || 0) + (item.vote_totals.down || 0) : 0;
  const voteTotalsHtml = totalVotes > 0
    ? `<p style="font-size:12px;color:#6b7280;margin:8px 0 0 0;">\u{1F465} ${totalVotes} resident${totalVotes === 1 ? '' : 's'} weighed in &middot; ${item.vote_totals.up || 0} support &middot; ${item.vote_totals.down || 0} oppose</p>`
    : '';

  // Deadline banner — only if next_vote_date exists
  const deadlineHtml = item.next_vote_date
    ? (() => {
        const d = new Date(item.next_vote_date + 'T00:00:00');
        const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const daysLeft = Math.ceil((d - new Date()) / 86400000);
        const urgency = daysLeft <= 7 ? '#dc2626' : '#d97706';
        const label = daysLeft <= 0 ? 'Vote today' : daysLeft === 1 ? 'Vote tomorrow' : `Vote in ${daysLeft} days`;
        return `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 12px;margin:8px 0;display:flex;align-items:center;gap:6px;">
          <span style="font-size:14px;">\u{1F4C5}</span>
          <span style="font-size:13px;color:${urgency};font-weight:600;">Final vote: ${formatted} &mdash; ${label}</span>
        </div>`;
      })()
    : '';

  // Visual relevance: filled vs empty dots (out of 10)
  const score = Math.min(10, Math.max(0, item.relevance_score || 0));
  const filled = '\u{25CF}';
  const empty = '\u{25CB}';
  const dotsHtml = `<span style="font-size:10px;letter-spacing:2px;color:${score >= 7 ? '#059669' : score >= 4 ? '#d97706' : '#9ca3af'};">${filled.repeat(score)}${empty.repeat(10 - score)}</span>`;

  return `
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:16px;">
      <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <span style="display:inline-block;background:#f3f4f6;color:#374151;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;text-transform:uppercase;margin-right:8px;">${item.doc_type || 'ordinance'}</span>
          <span style="display:inline-block;background:${statusColor};color:#ffffff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;margin-right:8px;">${item.current_status}</span>
          ${item.affected_ward ? `<span style="display:inline-block;background:${item.affected_ward === ward || item.affected_ward === 'citywide' ? '#ecfdf5' : '#fef3c7'};color:${item.affected_ward === ward || item.affected_ward === 'citywide' ? '#065f46' : '#92400e'};font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;">${item.affected_ward === 'citywide' ? 'Citywide' : 'Ward ' + item.affected_ward}${item.affected_ward === ward ? ' (yours)' : ''}</span>` : ''}
        </div>
        <div style="text-align:right;">
          ${dotsHtml}
          <span style="font-size:10px;color:#9ca3af;margin-left:4px;">relevance</span>
        </div>
      </div>
      <h3 style="margin:8px 0;font-size:18px;color:#111827;">${item.plain_title}</h3>
      <p style="color:#4b5563;font-size:14px;line-height:1.5;margin:8px 0;">${item.what_is_happening}</p>
      <div style="background:#fafafa;border-radius:6px;padding:10px 12px;margin:12px 0;display:flex;align-items:center;gap:8px;">
        <span style="font-size:20px;">${icon}</span>
        <span style="font-size:14px;color:${catColor};font-weight:600;">${item.personal_impact}</span>
      </div>
      <p style="font-size:13px;color:#6b7280;margin:8px 0;">${item.status_context}</p>
      ${item.location ? `<p style="margin:8px 0;"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location + ', Jersey City, NJ')}" style="font-size:13px;color:#2563eb;text-decoration:none;">&#x1F4CD; ${item.location}</a></p>` : ''}
      ${deadlineHtml}
      ${item.source_url || item.meeting_url ? `<p style="margin:8px 0;">${item.source_url ? `<a href="${item.source_url}" style="font-size:13px;color:#2563eb;text-decoration:none;">View full document</a>` : ''}${item.source_url && item.meeting_url ? ' &middot; ' : ''}${item.meeting_url ? `<a href="${item.meeting_url}" style="font-size:13px;color:#2563eb;text-decoration:none;">Meeting agenda</a>` : ''}</p>` : ''}
      <div style="margin-top:12px;">
        <a href="${voteUpUrl}" style="display:inline-block;background:#f0fdf4;color:#166534;padding:6px 16px;border-radius:6px;text-decoration:none;font-size:14px;margin-right:8px;border:1px solid #bbf7d0;">&#128077; Support</a>
        <a href="${voteDownUrl}" style="display:inline-block;background:#fef2f2;color:#991b1b;padding:6px 16px;border-radius:6px;text-decoration:none;font-size:14px;border:1px solid #fecaca;">&#128078; Oppose</a>
      </div>
      ${voteTotalsHtml}
    </div>`;
}

/**
 * Build the full digest email HTML for a subscriber.
 *
 * @param {Object} profile - { id, email, ward }
 * @param {Array} items - analyzed items with plain_title, what_is_happening, personal_impact, etc.
 * @param {string} weekDate - formatted week date string
 * @returns {string} HTML email content
 */
function buildDigestHtml(profile, items, weekDate) {
  const itemsHtml = items.map(item => buildItemHtml(item, profile.id, profile.ward)).join('\n');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="text-align:center;padding:24px 0;">
      <h1 style="margin:0;font-size:24px;color:#111827;">Your MyBloc Digest</h1>
      <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">Week of ${weekDate} &middot; Ward ${profile.ward || '?'}</p>
    </div>

    ${itemsHtml}

    <div style="text-align:center;padding:24px 0;border-top:1px solid #e5e7eb;margin-top:24px;">
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        MyBloc &middot; Jersey City &middot;
        <a href="${VOTE_BASE_URL}/manage.html?user=${profile.id}" style="color:#9ca3af;">Manage profile</a> &middot;
        <a href="${VOTE_BASE_URL}/api/unsubscribe?user=${profile.id}" style="color:#9ca3af;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Generate a personalized subject line from the top items.
 */
function generateSubjectLine(items) {
  if (!items.length) return 'Your Weekly MyBloc Digest';
  const topItem = items[0];
  return `\u{1F3D9}\uFE0F JC This Week — ${topItem.plain_title}`;
}

/**
 * Send a digest email to a single subscriber.
 *
 * @param {Object} profile - { id, email, ward }
 * @param {Array} items - analyzed items sorted by relevance_score desc
 * @param {string} weekDate - formatted week date string
 * @returns {Object} Resend API response
 */
async function sendDigest(profile, items, weekDate) {
  const html = buildDigestHtml(profile, items, weekDate);
  const subject = generateSubjectLine(items);

  const { data, error } = await resend.emails.send({
    from: 'MyBloc <digest@mybloc.co>',
    to: [profile.email],
    subject,
    html
  });

  if (error) {
    throw new Error(`Failed to send digest to ${profile.email}: ${JSON.stringify(error)}`);
  }

  return data;
}

/**
 * Build a welcome email for a new subscriber using cached ward highlights.
 *
 * @param {Object} profile - { id, email, ward }
 * @param {Array} items - cached highlight items (same shape as buildItemHtml expects)
 * @param {string} weekDate - formatted week date string from ward_highlights
 * @returns {string} HTML email content
 */
function buildWelcomeHtml(profile, items, weekDate) {
  const rep = COUNCIL_REPS[profile.ward];
  const itemsHtml = items.map(item => buildItemHtml(item, profile.id, profile.ward)).join('\n');

  const repHtml = rep ? `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin-bottom:20px;">
      <p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#1e40af;">Your council rep: ${rep.name} (Ward ${profile.ward})</p>
      <p style="margin:0 0 6px;font-size:13px;color:#1e40af;">Email: <a href="mailto:${rep.email}" style="color:#2563eb;">${rep.email}</a></p>
      <p style="margin:0;font-size:13px;color:#374151;">Your personalized digest arrives every Thursday.</p>
    </div>` : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="text-align:center;padding:24px 0;">
      <h1 style="margin:0;font-size:24px;color:#111827;">Welcome to MyBloc</h1>
      <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">Here's a preview of what's happening in Ward ${profile.ward || '?'}</p>
    </div>

    ${repHtml}

    <p style="font-size:14px;color:#4b5563;margin-bottom:16px;">Here are a few items from the latest council agenda that may affect you:</p>

    ${itemsHtml}

    <div style="text-align:center;margin:24px 0;">
      <a href="${VOTE_BASE_URL}/manage.html?user=${profile.id}" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">Update your profile</a>
    </div>

    <div style="text-align:center;padding:24px 0;border-top:1px solid #e5e7eb;margin-top:24px;">
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        MyBloc &middot; Jersey City &middot;
        <a href="${VOTE_BASE_URL}/manage.html?user=${profile.id}" style="color:#9ca3af;">Manage profile</a> &middot;
        <a href="${VOTE_BASE_URL}/api/unsubscribe?user=${profile.id}" style="color:#9ca3af;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { sendDigest, buildDigestHtml, buildItemHtml, buildWelcomeHtml, generateSubjectLine, COUNCIL_REPS };
