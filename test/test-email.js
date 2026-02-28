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
    plain_title: 'Rent Control Increase to 5.5%',
    what_is_happening: 'The city council is considering raising the maximum allowable rent increase from 4% to 5.5% per year for buildings with 6+ units. A new hardship exemption would let landlords request higher increases if operating costs rise more than 8%.',
    personal_impact: 'As a renter in Ward C, this could directly increase your rent by up to 1.5% more per year. If your building has 6 or more units, your landlord could raise rent by up to 5.5% instead of the current 4% cap.',
    relevance_score: 9,
    current_status: 'INTRODUCED',
    status_context: 'This was introduced at the January 28 meeting. A public hearing is scheduled for February 11 where residents can testify.',
    action_available: true,
    vote_totals: { up: 42, down: 18 }
  },
  {
    doc_type: 'resolution',
    plain_title: 'Light Rail Station Safety Improvements',
    what_is_happening: 'The council approved a $2.1M contract for safety improvements at three light rail stations including better lighting, emergency call boxes, and security cameras.',
    personal_impact: 'As someone without a car who relies on transit, improved safety at light rail stations directly affects your daily commute and nighttime travel security.',
    relevance_score: 7,
    current_status: 'PASSED',
    status_context: 'This resolution passed unanimously at the January 28 meeting and is now in effect.',
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
  if (!html.includes('Rent Control Increase')) {
    console.error('FAIL: HTML missing expected content');
    process.exit(1);
  }
  if (!html.includes('Light Rail Station')) {
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
