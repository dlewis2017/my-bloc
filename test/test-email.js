require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { sendDigest, buildDigestHtml } = require('../scripts/send-digest');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Test email address — change this to your email
const TEST_EMAIL = process.env.TEST_EMAIL || 'delivered@resend.dev';

// Sample item content — ordinance_ids will be populated from the database
const SAMPLE_ITEMS = [
  {
    doc_type: 'ordinance',
    plain_title: 'Rent Control Cap Raised from 4% to 5.5%',
    what_is_happening: 'This ordinance would raise the maximum rent increase landlords can charge from 4% to 5.5% per year in buildings with 6+ units. It also creates a new process where landlords can apply for even higher increases if their operating costs went up more than 8%.',
    personal_impact: 'This one hits you directly 😬 — if your building has 6+ units, your landlord could raise your rent 37% more than before (4% → 5.5%). On a $1,800/month apartment that\'s an extra $27/month, or $324/yr. And that new hardship exemption? Basically a loophole for landlords to push even higher. Public hearing is Feb 11 — your Ward C council member sponsored this, so calling their office actually matters here 📣',
    relevance_score: 10,
    current_status: 'INTRODUCED',
    status_context: 'This just had its first reading and isn\'t law yet — there\'s a public hearing on February 11, 2026 where residents can speak before any vote happens.',
    action_available: true,
    next_vote_date: '2026-02-11',
    vote_totals: { up: 42, down: 18 }
  },
  {
    doc_type: 'resolution',
    plain_title: 'Light Rail Stations Getting Safety Upgrades',
    what_is_happening: 'The council approved a $2.1M contract for safety improvements at three light rail stations including better lighting, emergency call boxes, and security cameras.',
    personal_impact: 'Your late-night commute home just got a little less sketchy 🚉✨ — new lighting, cameras, and emergency call boxes coming to three stations. No car means you actually use these, so this is a real quality-of-life upgrade for you.',
    relevance_score: 8,
    current_status: 'PASSED',
    status_context: 'This passed unanimously at the January 28 meeting and is now in effect — construction should start within a few months.',
    action_available: false
  }
];

async function testEmail() {
  console.log('Testing Email Builder...\n');

  // Fetch a real profile from Supabase so vote links use a valid UUID
  const { data: profiles } = await supabase.from('profiles').select('id, email, ward').limit(1);
  const realProfile = profiles && profiles.length > 0
    ? { id: profiles[0].id, email: TEST_EMAIL, ward: profiles[0].ward }
    : { id: '00000000-0000-0000-0000-000000000000', email: TEST_EMAIL, ward: 'C' };

  console.log(`Using profile ID: ${realProfile.id} (ward ${realProfile.ward})\n`);

  // Fetch real ordinance IDs from the database so vote links use valid foreign keys
  const { data: ordinances } = await supabase.from('ordinances').select('id').limit(2);
  const testItems = SAMPLE_ITEMS.map((item, i) => ({
    ...item,
    ordinance_id: ordinances && ordinances[i] ? ordinances[i].id : `fallback_${i}`
  }));

  console.log(`Using ordinance IDs: ${testItems.map(i => i.ordinance_id).join(', ')}\n`);

  // Test 1: Build HTML without sending
  console.log('Test 1: Building digest HTML');
  const html = buildDigestHtml(realProfile, testItems, 'February 10, 2026');
  if (!html.includes('Rent Control Cap')) {
    console.error('FAIL: HTML missing expected content');
    process.exit(1);
  }
  if (!html.includes('Light Rail')) {
    console.error('FAIL: HTML missing second item');
    process.exit(1);
  }
  if (!html.includes(`Ward ${realProfile.ward}`)) {
    console.error('FAIL: HTML missing ward info');
    process.exit(1);
  }
  if (!html.includes(`vote?user=${realProfile.id}`)) {
    console.error('FAIL: HTML missing vote links with correct UUID');
    process.exit(1);
  }
  console.log('PASS: HTML contains all expected content\n');

  // Test 2: Send test email via Resend
  console.log(`Test 2: Sending test digest to ${TEST_EMAIL}`);
  try {
    const result = await sendDigest(realProfile, testItems, 'February 10, 2026');
    console.log('Send result:', result);
    console.log('PASS: Email sent successfully\n');
  } catch (err) {
    if (!process.env.RESEND_API_KEY) {
      console.log('SKIP: No RESEND_API_KEY set, skipping send test');
      console.log('  Set RESEND_API_KEY and TEST_EMAIL in .env to test email delivery\n');
    } else {
      console.error('FAIL: Email send failed:', err.message);
      process.exit(1);
    }
  }

  console.log('All email tests passed!');
}

testEmail().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
