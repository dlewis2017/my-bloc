require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const VOTE_BASE_URL = process.env.VOTE_BASE_URL || 'https://your-app.vercel.app';

/**
 * Build a single item block for the digest email.
 */
function buildItemHtml(item, userId) {
  const statusColors = {
    INTRODUCED: '#3b82f6',
    AMENDED: '#f59e0b',
    COMMITTEE: '#8b5cf6',
    VOTED: '#6366f1',
    PASSED: '#10b981',
    FAILED: '#ef4444',
    WITHDRAWN: '#6b7280'
  };

  const statusColor = statusColors[item.current_status] || '#6b7280';

  const voteUpUrl = `${VOTE_BASE_URL}/api/vote?user=${userId}&item=${encodeURIComponent(item.ordinance_id || '')}&vote=up`;
  const voteDownUrl = `${VOTE_BASE_URL}/api/vote?user=${userId}&item=${encodeURIComponent(item.ordinance_id || '')}&vote=down`;

  const voteTotalsHtml = item.vote_totals
    ? `<p style="font-size:12px;color:#9ca3af;margin:4px 0 0 0;">Last week: ${item.vote_totals.up || 0} supported &middot; ${item.vote_totals.down || 0} opposed</p>`
    : '';

  return `
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:16px;">
      <div style="margin-bottom:8px;">
        <span style="display:inline-block;background:#f3f4f6;color:#374151;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;text-transform:uppercase;margin-right:8px;">${item.doc_type || 'ordinance'}</span>
        <span style="display:inline-block;background:${statusColor};color:#ffffff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;">${item.current_status}</span>
      </div>
      <h3 style="margin:8px 0;font-size:18px;color:#111827;">${item.plain_title}</h3>
      <p style="color:#4b5563;font-size:14px;line-height:1.5;margin:8px 0;">${item.what_is_happening}</p>
      <div style="background:#eff6ff;border-left:3px solid #3b82f6;padding:12px;margin:12px 0;border-radius:0 4px 4px 0;">
        <p style="margin:0;font-size:14px;color:#1e40af;"><strong>What this means for you:</strong> ${item.personal_impact}</p>
      </div>
      <p style="font-size:13px;color:#6b7280;margin:8px 0;">${item.status_context}</p>
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
  const itemsHtml = items.map(item => buildItemHtml(item, profile.id)).join('\n');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="text-align:center;padding:24px 0;">
      <h1 style="margin:0;font-size:24px;color:#111827;">Your Jersey City Digest</h1>
      <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">Week of ${weekDate} &middot; Ward ${profile.ward || '?'}</p>
    </div>

    ${itemsHtml}

    <div style="text-align:center;padding:24px 0;border-top:1px solid #e5e7eb;margin-top:24px;">
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        CivicPulse &middot; Jersey City &middot;
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
  if (!items.length) return 'Your Weekly JC Digest';
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
    from: 'CivicPulse <onboarding@resend.dev>',
    to: [profile.email],
    subject,
    html
  });

  if (error) {
    throw new Error(`Failed to send digest to ${profile.email}: ${JSON.stringify(error)}`);
  }

  return data;
}

module.exports = { sendDigest, buildDigestHtml, buildItemHtml, generateSubjectLine };
