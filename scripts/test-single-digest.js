#!/usr/bin/env node
/**
 * Quick test: analyze 1 ordinance for 1 profile and send the email.
 *
 * Usage:
 *   node scripts/test-single-digest.js                  # latest ordinance
 *   node scripts/test-single-digest.js Ord-26-007       # by ordinance_num
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { analyzeOrdinance } = require('./claude-analyzer');
const { sendDigest } = require('./send-digest');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const targetNum = process.argv[2] || null;

async function run() {
  // 1. Get the ordinance
  let query = supabase.from('ordinances').select('*');
  if (targetNum) {
    query = query.eq('ordinance_num', targetNum);
  } else {
    query = query.order('last_updated', { ascending: false }).limit(1);
  }
  const { data: ords, error: ordErr } = await query;
  if (ordErr) throw new Error(ordErr.message);
  if (!ords || !ords.length) { console.log('No ordinance found.'); return; }

  const ord = ords[0];
  console.log(`Ordinance: ${ord.ordinance_num} — ${ord.title}`);
  console.log(`  Full text: ${ord.full_text ? ord.full_text.length + ' chars' : 'none'}\n`);

  // 2. Get a profile (prefer TEST_EMAIL, fall back to first active)
  let profileQuery = supabase.from('profiles').select('*');
  if (process.env.TEST_EMAIL) {
    profileQuery = profileQuery.eq('email', process.env.TEST_EMAIL);
  } else {
    profileQuery = profileQuery.eq('active', true).limit(1);
  }
  const { data: profiles, error: profErr } = await profileQuery;
  if (profErr) throw new Error(profErr.message);
  if (!profiles || !profiles.length) { console.log('No profile found.'); return; }

  const profile = profiles[0];
  console.log(`Profile: ${profile.email} (Ward ${profile.ward})\n`);

  // 3. Analyze with Claude
  console.log('Analyzing with Claude...');
  const textForAnalysis = ord.full_text || ord.title;
  const analysis = await analyzeOrdinance(textForAnalysis, profile);
  console.log(`  Score: ${analysis.relevance_score}`);
  console.log(`  Title: ${analysis.plain_title}`);
  console.log(`  Impact: ${analysis.personal_impact}\n`);

  // 4. Build item and send
  const item = {
    ...analysis,
    ordinance_id: ord.id,
    doc_type: ord.doc_type,
    source_url: ord.source_url || null,
    vote_totals: null
  };

  const weekDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  console.log(`Sending email to ${profile.email}...`);
  const result = await sendDigest(profile, [item], weekDate);
  console.log(`Sent! ID: ${result.id}`);
}

run().then(() => process.exit(0)).catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
