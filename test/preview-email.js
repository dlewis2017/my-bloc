/**
 * Generate a local HTML preview of the digest and welcome emails.
 * Run: node test/preview-email.js
 * Then open the generated files in your browser.
 */
const fs = require('fs');
const path = require('path');
const { buildDigestHtml, buildWelcomeHtml } = require('../scripts/send-digest');

const profile = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'test@example.com',
  ward: 'C',
  city: 'Jersey City'
};

const items = [
  {
    ordinance_id: 'ord-001',
    doc_type: 'ordinance',
    current_status: 'INTRODUCED',
    plain_title: 'Rent Control Amendment',
    what_is_happening: 'This ordinance would cap annual rent increases at 4% instead of the current 5% for rent-controlled units citywide.',
    personal_impact: 'As a Journal Square renter, this directly affects your lease renewal costs.',
    status_context: 'Introduced at the Feb 26 council meeting. Public hearing scheduled for March 12.',
    impact_category: 'housing',
    affected_ward: 'citywide',
    relevance_score: 9,
    next_vote_date: '2026-03-12',
    location: null,
    source_url: 'https://example.com/ord-001',
    meeting_url: 'https://example.com/meeting'
  },
  {
    ordinance_id: 'ord-002',
    doc_type: 'resolution',
    current_status: 'PASSED',
    plain_title: 'Journal Square Streetlight Upgrade',
    what_is_happening: 'Resolution approving $2.1M contract for LED streetlight replacement along Kennedy Blvd from Sip Ave to Manhattan Ave.',
    personal_impact: 'Better lighting on your daily commute route through Journal Square.',
    status_context: 'Passed unanimously at the Feb 26 meeting.',
    impact_category: 'safety',
    affected_ward: 'C',
    relevance_score: 7,
    location: 'Kennedy Blvd, Jersey City',
    source_url: null,
    meeting_url: null
  },
  {
    ordinance_id: 'ord-003',
    doc_type: 'ordinance',
    current_status: 'COMMITTEE',
    plain_title: 'Parking Meter Rate Increase',
    what_is_happening: 'Proposal to increase metered parking rates from $0.25 to $0.50 per 15 minutes in downtown and Journal Square.',
    personal_impact: 'If you drive to errands in Journal Square, your parking costs could double.',
    status_context: 'Referred to Transportation Committee for review.',
    impact_category: 'transit',
    affected_ward: 'citywide',
    relevance_score: 6,
    location: null,
    source_url: null,
    meeting_url: null
  }
];

const devNotices = [
  {
    plain_title: '6-Story Mixed-Use Building at 295 Sip Ave',
    personal_impact: 'New 48-unit residential building with ground-floor retail, 2 blocks from Journal Square PATH.',
    impact_category: 'development',
    ward: 'C',
    current_state: 'NEW',
    location: '295 Sip Ave, Jersey City'
  },
  {
    plain_title: 'Warehouse Conversion at 150 Bay St',
    personal_impact: '32 loft-style apartments planned in former industrial space near the waterfront.',
    impact_category: 'housing',
    ward: 'E',
    current_state: 'CARRIED',
    location: '150 Bay St, Jersey City'
  }
];

const notices = [
  {
    plain_title: 'NJDEP Environmental Remediation Notice — 100 Monitor St',
    personal_impact: 'Soil cleanup at former industrial site near Lincoln Park.',
    impact_category: 'environment',
    location: '100 Monitor St, Jersey City'
  },
  {
    plain_title: 'DPW Paving Schedule — Ward C Streets',
    personal_impact: 'Road repaving on Central Ave and Tonnelle Ave in March.',
    impact_category: 'transit',
    location: null
  }
];

const weekDate = 'February 26, 2026';

// Generate digest email
const digestHtml = buildDigestHtml(profile, items, weekDate, devNotices, notices);
const digestPath = path.join(__dirname, '..', 'public', '_preview-digest.html');
fs.writeFileSync(digestPath, digestHtml);
console.log(`Digest preview: ${digestPath}`);

// Generate welcome email
const welcomeHtml = buildWelcomeHtml(profile, items.slice(0, 2), weekDate);
const welcomePath = path.join(__dirname, '..', 'public', '_preview-welcome.html');
fs.writeFileSync(welcomePath, welcomeHtml);
console.log(`Welcome preview: ${welcomePath}`);

console.log('\nOpen in browser:');
console.log('  http://localhost:8000/_preview-digest.html');
console.log('  http://localhost:8000/_preview-welcome.html');
