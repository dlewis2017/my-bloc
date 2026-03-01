require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { upsertOrdinance, generateStableId, getVoteTotals } = require('../scripts/state-tracker');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TEST_ORDINANCE = {
  ordinance_num: 'TEST-99-001',
  title: 'Test Ordinance for State Tracker Validation',
  doc_type: 'ordinance',
  full_text: 'This is a test ordinance for automated testing.',
  source_url: 'https://example.com/test',
  meeting_date: '2026-01-01',
  current_state: 'INTRODUCED'
};

async function cleanup() {
  const id = generateStableId(TEST_ORDINANCE.ordinance_num, TEST_ORDINANCE.title);
  await supabase.from('ordinances').delete().eq('id', id);
}

async function testStateTracker() {
  console.log('Testing State Tracker...\n');

  // Clean up any leftover test data
  await cleanup();

  // Test 1: Insert a new ordinance
  console.log('Test 1: Insert new ordinance');
  const result1 = await upsertOrdinance(TEST_ORDINANCE, supabase);
  if (result1.action !== 'inserted') {
    console.error(`FAIL: Expected action "inserted", got "${result1.action}"`);
    process.exit(1);
  }
  if (!result1.shouldNotify) {
    console.error('FAIL: Expected shouldNotify to be true for new insert');
    process.exit(1);
  }
  console.log('PASS: New ordinance inserted, shouldNotify=true\n');

  // Test 2: Insert same ordinance with different state
  console.log('Test 2: Update state to VOTED');
  const result2 = await upsertOrdinance({ ...TEST_ORDINANCE, current_state: 'VOTED' }, supabase);
  if (result2.action !== 'state_changed') {
    console.error(`FAIL: Expected action "state_changed", got "${result2.action}"`);
    process.exit(1);
  }
  if (!result2.shouldNotify) {
    console.error('FAIL: Expected shouldNotify to be true for state change');
    process.exit(1);
  }
  console.log('PASS: State changed to VOTED, shouldNotify=true\n');

  // Verify the state was actually updated in the database
  const id = generateStableId(TEST_ORDINANCE.ordinance_num, TEST_ORDINANCE.title);
  const { data: updated } = await supabase
    .from('ordinances')
    .select('current_state, previous_state')
    .eq('id', id)
    .single();

  if (updated.current_state !== 'VOTED' || updated.previous_state !== 'INTRODUCED') {
    console.error(`FAIL: Database state mismatch. Got current=${updated.current_state}, previous=${updated.previous_state}`);
    process.exit(1);
  }
  console.log('PASS: Database correctly shows VOTED with previous_state INTRODUCED\n');

  // Test 3: Insert same ordinance with same state (no change)
  console.log('Test 3: Re-insert with same state');
  const result3 = await upsertOrdinance({ ...TEST_ORDINANCE, current_state: 'VOTED' }, supabase);
  if (result3.action !== 'no_change') {
    console.error(`FAIL: Expected action "no_change", got "${result3.action}"`);
    process.exit(1);
  }
  if (result3.shouldNotify) {
    console.error('FAIL: Expected shouldNotify to be false for no change');
    process.exit(1);
  }
  console.log('PASS: No change detected, shouldNotify=false\n');

  // Test 4: Vote totals aggregation
  console.log('Test 4: Vote totals aggregation');
  const totals = await getVoteTotals([id], supabase);
  // We don't expect votes on test data, just verify the function returns valid structure
  if (typeof totals !== 'object') {
    console.error('FAIL: getVoteTotals did not return an object');
    process.exit(1);
  }
  console.log(`PASS: getVoteTotals returned valid object (${Object.keys(totals).length} entries)\n`);

  // Cleanup
  await cleanup();

  console.log('All state tracker tests passed!');
}

testStateTracker().catch(err => {
  console.error('Test failed with error:', err);
  cleanup().finally(() => process.exit(1));
});
