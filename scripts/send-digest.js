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
    transit: '#0f1b2d',
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

  return `
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-bottom:16px;">
      <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <span style="display:inline-block;background:#f1f5f9;color:#475569;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;text-transform:uppercase;margin-right:8px;">${item.doc_type || 'ordinance'}</span>
          <span style="display:inline-block;background:${statusColor};color:#ffffff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;margin-right:8px;">${item.current_status}</span>
          ${item.affected_ward ? `<span style="display:inline-block;background:${item.affected_ward === ward || item.affected_ward === 'citywide' ? '#ecfdf5' : '#fef3c7'};color:${item.affected_ward === ward || item.affected_ward === 'citywide' ? '#065f46' : '#92400e'};font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;">${item.affected_ward === 'citywide' ? 'Citywide' : 'Ward ' + item.affected_ward}${item.affected_ward === ward ? ' (yours)' : ''}</span>` : ''}
        </div>
      </div>
      <h3 style="margin:8px 0;font-size:18px;color:#0f1b2d;">${item.plain_title}</h3>
      <p style="color:#475569;font-size:14px;line-height:1.5;margin:8px 0;">${item.what_is_happening}</p>
      <div style="background:#f8fafc;border-radius:6px;padding:10px 12px;margin:12px 0;display:flex;align-items:center;gap:8px;">
        <span style="font-size:20px;">${icon}</span>
        <span style="font-size:14px;color:${catColor};font-weight:600;">${item.personal_impact}</span>
      </div>
      <p style="font-size:13px;color:#64748b;margin:8px 0;">${item.status_context}</p>
      ${item.location ? `<p style="margin:8px 0;"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location + ', Jersey City, NJ')}" style="font-size:13px;color:#d4a843;text-decoration:none;">&#x1F4CD; ${item.location}</a></p>` : ''}
      ${deadlineHtml}
      ${item.source_url || item.meeting_url ? `<p style="margin:8px 0;">${item.source_url ? `<a href="${item.source_url}" style="font-size:13px;color:#d4a843;text-decoration:none;">View full document</a>` : ''}${item.source_url && item.meeting_url ? ' &middot; ' : ''}${item.meeting_url ? `<a href="${item.meeting_url}" style="font-size:13px;color:#d4a843;text-decoration:none;">Meeting agenda</a>` : ''}</p>` : ''}
      <div style="margin-top:12px;">
        <a href="${voteUpUrl}" style="display:inline-block;background:#f0fdf4;color:#166534;padding:6px 16px;border-radius:6px;text-decoration:none;font-size:14px;margin-right:8px;border:1px solid #bbf7d0;">&#128077; Support</a>
        <a href="${voteDownUrl}" style="display:inline-block;background:#fef2f2;color:#991b1b;padding:6px 16px;border-radius:6px;text-decoration:none;font-size:14px;border:1px solid #fecaca;">&#128078; Oppose</a>
      </div>
    </div>`;
}

/**
 * Build a lightweight notice block for community notices (consent agenda, communications, etc.).
 * Simpler than ordinance items — just title + one-line impact, no vote buttons or relevance dots.
 */
function buildNoticeHtml(notice) {
  const impactIcons = {
    housing: '\u{1F3E0}', money: '\u{1F4B0}', transit: '\u{1F68C}', schools: '\u{1F393}',
    safety: '\u{1F6E1}\uFE0F', environment: '\u{1F333}', development: '\u{1F3D7}\uFE0F',
    jobs: '\u{1F4BC}', government: '\u{1F3DB}\uFE0F'
  };

  const category = notice.impact_category || 'government';
  const icon = impactIcons[category] || '\u{1F3DB}\uFE0F';

  return `
    <div style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
      <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#0f1b2d;">${icon} ${notice.plain_title}</p>
      <p style="margin:0;font-size:13px;color:#64748b;">${notice.personal_impact}</p>
      ${notice.location ? `<p style="margin:4px 0 0;"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(notice.location + ', Jersey City, NJ')}" style="font-size:12px;color:#d4a843;text-decoration:none;">&#x1F4CD; ${notice.location}</a></p>` : ''}
    </div>`;
}

/**
 * Build a medium-weight development/zoning card.
 * More detail than a community notice (includes address, description, ward/zone)
 * but no vote buttons or relevance dots like ordinances.
 */
function buildDevelopmentHtml(item, userId, ward) {
  const impactIcons = {
    housing: '\u{1F3E0}', money: '\u{1F4B0}', transit: '\u{1F68C}', schools: '\u{1F393}',
    safety: '\u{1F6E1}\uFE0F', environment: '\u{1F333}', development: '\u{1F3D7}\uFE0F',
    jobs: '\u{1F4BC}', government: '\u{1F3DB}\uFE0F'
  };

  const category = item.impact_category || 'development';
  const icon = impactIcons[category] || '\u{1F3D7}\uFE0F';

  const stateLabel = item.current_state === 'CARRIED' ? 'Adjourned' : item.current_state === 'CONTINUED' ? 'Continued' : 'New Application';
  const stateColor = item.current_state === 'CARRIED' ? '#d97706' : item.current_state === 'CONTINUED' ? '#6366f1' : '#3b82f6';

  const repUrl = `${VOTE_BASE_URL}/thanks.html?vote=dev&ward=${encodeURIComponent(ward || '')}&title=${encodeURIComponent(item.plain_title || '')}`;

  return `
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:12px;">
      <div style="margin-bottom:6px;">
        <span style="display:inline-block;background:${stateColor};color:#ffffff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;margin-right:6px;">${stateLabel}</span>
        ${item.ward ? `<span style="display:inline-block;background:#ecfdf5;color:#065f46;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;">Ward ${item.ward}</span>` : ''}
      </div>
      <h3 style="margin:6px 0;font-size:16px;color:#0f1b2d;">${item.plain_title}</h3>
      <div style="background:#f8fafc;border-radius:6px;padding:8px 10px;margin:8px 0;display:flex;align-items:center;gap:8px;">
        <span style="font-size:18px;">${icon}</span>
        <span style="font-size:13px;color:#475569;">${item.personal_impact}</span>
      </div>
      ${item.location ? `<p style="margin:6px 0 0;"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location + ', Jersey City, NJ')}" style="font-size:12px;color:#d4a843;text-decoration:none;">&#x1F4CD; ${item.location}</a></p>` : ''}
      <div style="margin-top:10px;">
        <a href="${repUrl}" style="display:inline-block;background:#d4a843;color:#ffffff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">&#x1F4E8; Let your rep know</a>
      </div>
    </div>`;
}

/**
 * Build the full digest email HTML for a subscriber.
 *
 * @param {Object} profile - { id, email, ward }
 * @param {Array} items - analyzed ordinance items with plain_title, what_is_happening, personal_impact, etc.
 * @param {string} weekDate - formatted week date string
 * @param {Array} [devNotices] - development/zoning items from bulk filter (medium-weight format)
 * @param {Array} [notices] - community notice items from bulk filter (lighter format)
 * @returns {string} HTML email content
 */
function buildDigestHtml(profile, items, weekDate, devNotices = [], notices = []) {
  const itemsHtml = items.length > 0
    ? `<h2 style="font-size:18px;color:#0f1b2d;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #e2e8f0;">\u{1F3DB}\uFE0F Ordinances &amp; Resolutions</h2>
      ${items.map(item => buildItemHtml(item, profile.id, profile.ward)).join('\n')}`
    : '';

  const devHtml = devNotices.length > 0
    ? `
    <div style="margin-top:24px;">
      <h2 style="font-size:18px;color:#0f1b2d;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #e2e8f0;">\u{1F3D7}\uFE0F Development &amp; Zoning</h2>
      ${devNotices.map(n => buildDevelopmentHtml(n, profile.id, profile.ward)).join('\n')}
    </div>`
    : '';

  const noticesHtml = notices.length > 0
    ? `
    <div style="margin-top:24px;">
      <h2 style="font-size:18px;color:#0f1b2d;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #e2e8f0;">Community Notices</h2>
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;">
        ${notices.map(n => buildNoticeHtml(n)).join('\n')}
      </div>
    </div>`
    : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="background:#0f1b2d;padding:28px 24px;text-align:center;border-radius:0 0 0 0;">
      <h1 style="margin:0;font-size:22px;color:#ffffff;font-weight:800;letter-spacing:-0.5px;">my<span style="color:#d4a843;">bloc</span></h1>
      <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.6);">${profile.city || 'Jersey City'} &middot; Week of ${weekDate} &middot; Ward ${profile.ward || '?'}</p>
    </div>

    <div style="padding:24px 20px;">
    ${itemsHtml}
    ${devHtml}
    ${noticesHtml}
    </div>

    <div style="background:#0f1b2d;padding:20px 24px;text-align:center;">
      <p style="font-size:12px;color:rgba(255,255,255,0.4);margin:0;">
        MyBloc &middot; Jersey City &middot;
        <a href="${VOTE_BASE_URL}/manage.html?user=${profile.id}" style="color:#d4a843;">Manage profile</a> &middot;
        <a href="${VOTE_BASE_URL}/api/unsubscribe?user=${profile.id}" style="color:rgba(255,255,255,0.4);">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Generate a personalized subject line from the most relevant item across all sections.
 */
function generateSubjectLine(items, devNotices = [], notices = []) {
  // Pick the highest relevance_score item for the subject line (dev/notices don't have scores)
  const topByRelevance = [...items].sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))[0];
  const best = topByRelevance || devNotices[0] || notices[0];
  if (!best) return 'Your Weekly MyBloc Digest';
  return `\u{1F3D9}\uFE0F JC This Week — ${best.plain_title}`;
}

/**
 * Send a digest email to a single subscriber.
 *
 * @param {Object} profile - { id, email, ward }
 * @param {Array} items - analyzed ordinance items sorted by relevance_score desc
 * @param {string} weekDate - formatted week date string
 * @param {Array} [devNotices] - development/zoning items from bulk filter
 * @param {Array} [notices] - community notice items from bulk filter
 * @returns {Object} Resend API response
 */
async function sendDigest(profile, items, weekDate, devNotices = [], notices = []) {
  const html = buildDigestHtml(profile, items, weekDate, devNotices, notices);
  const subject = generateSubjectLine(items, devNotices, notices);

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
  const hasItems = Array.isArray(items) && items.length > 0;
  const itemsHtml = hasItems ? items.map(item => buildItemHtml(item, profile.id, profile.ward)).join('\n') : '';

  const repHtml = rep ? `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:20px;">
      <p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#0f1b2d;">Your council rep: ${rep.name} (Ward ${profile.ward})</p>
      <p style="margin:0 0 6px;font-size:13px;color:#475569;">Email: <a href="mailto:${rep.email}" style="color:#d4a843;">${rep.email}</a></p>
      <p style="margin:0;font-size:13px;color:#64748b;">Your personalized digest arrives every Thursday.</p>
    </div>` : '';

  const previewHtml = hasItems ? `
    <p style="font-size:14px;color:#475569;margin-bottom:16px;">Here are a few items from the latest council agenda that may affect you:</p>
    ${itemsHtml}` : `
    <p style="font-size:14px;color:#475569;margin-bottom:16px;">Your first personalized digest will arrive this Thursday with the latest from the Jersey City Council — tailored to your ward and interests.</p>`;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="background:#0f1b2d;padding:28px 24px;text-align:center;">
      <h1 style="margin:0;font-size:22px;color:#ffffff;font-weight:800;letter-spacing:-0.5px;">my<span style="color:#d4a843;">bloc</span></h1>
      <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.6);">Welcome to your personalized civic digest</p>
    </div>

    <div style="padding:24px 20px;">
    <h2 style="font-size:20px;color:#0f1b2d;margin:0 0 16px;">Welcome, Ward ${profile.ward || '?'} resident</h2>

    ${repHtml}

    ${previewHtml}

    <div style="text-align:center;margin:24px 0;">
      <a href="${VOTE_BASE_URL}/manage.html?user=${profile.id}" style="display:inline-block;padding:12px 28px;background:#d4a843;color:#ffffff;border-radius:10px;text-decoration:none;font-size:14px;font-weight:700;">Update your profile</a>
    </div>
    </div>

    <div style="background:#0f1b2d;padding:20px 24px;text-align:center;">
      <p style="font-size:12px;color:rgba(255,255,255,0.4);margin:0;">
        MyBloc &middot; Jersey City &middot;
        <a href="${VOTE_BASE_URL}/manage.html?user=${profile.id}" style="color:#d4a843;">Manage profile</a> &middot;
        <a href="${VOTE_BASE_URL}/api/unsubscribe?user=${profile.id}" style="color:rgba(255,255,255,0.4);">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { sendDigest, buildDigestHtml, buildItemHtml, buildDevelopmentHtml, buildNoticeHtml, buildWelcomeHtml, generateSubjectLine, COUNCIL_REPS };
