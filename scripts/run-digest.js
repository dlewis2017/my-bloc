#!/usr/bin/env node
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchCivicWeb } = require('./fetch-civicweb');
const { fetchPlanningBoard } = require('./fetch-planning-board');
const { upsertOrdinance, getUnnotifiedOrdinances, markNotified, getVoteTotals } = require('./state-tracker');
const { analyzeOrdinance, bulkFilterItems } = require('./claude-analyzer');
const { sendDigest, generateSubjectLine } = require('./send-digest');

const MIN_RELEVANCE_SCORE = 5;
const MAX_ITEMS_PER_DIGEST = 5;
const MAX_DEV_PER_DIGEST = 5;
const MAX_NOTICES_PER_DIGEST = 5;

// Doc types that go in the "Development & Zoning" section
const DEVELOPMENT_TYPES = new Set(['planning']);
const MAX_MEETINGS = 2;
const CONCURRENCY = 2; // parallel Claude API calls (kept low for 30k tokens/min rate limit)

// Doc types that get deep per-item analysis (tier 2)
const DEEP_ANALYSIS_TYPES = new Set(['ordinance', 'resolution']);

/**
 * Full digest pipeline: fetch → state track → Claude analyze → send emails.
 * Replaces n8n workflow — run via `node scripts/run-digest.js` or cron.
 *
 * @param {Object} [deps] - injectable dependencies for testing
 */
async function runDigest(deps = {}) {
  const db = deps.supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const fetch = deps.fetchCivicWeb || fetchCivicWeb;
  const fetchPB = deps.fetchPlanningBoard || fetchPlanningBoard;
  const upsert = deps.upsertOrdinance || upsertOrdinance;
  const getUnnotified = deps.getUnnotifiedOrdinances || getUnnotifiedOrdinances;
  const getVotes = deps.getVoteTotals || getVoteTotals;
  const analyze = deps.analyzeOrdinance || analyzeOrdinance;
  const send = deps.sendDigest || sendDigest;
  const markDone = deps.markNotified || markNotified;

  console.log('=== MyBloc Digest Pipeline ===\n');

  // Step 1: Fetch from all sources
  console.log('Step 1a: Fetching from CivicWeb...');
  const civicItems = await fetch(MAX_MEETINGS);
  console.log(`  Fetched ${civicItems.length} CivicWeb items`);

  console.log('Step 1b: Fetching from Planning/Zoning Boards...');
  let pbItems = [];
  try {
    pbItems = await fetchPB();
    console.log(`  Fetched ${pbItems.length} Planning/Zoning items`);
  } catch (err) {
    console.warn(`  Planning Board fetch failed (non-fatal): ${err.message}`);
  }

  const items = [...civicItems, ...pbItems];
  console.log(`  Total: ${items.length} items\n`);

  if (!items.length) {
    console.log('No items found. Exiting.');
    return;
  }

  // Step 2: Upsert into database with state tracking
  console.log('Step 2: Upserting into database...');
  let newOrChanged = 0;
  for (const item of items) {
    const result = await upsert({
      ordinance_num: item.ordinance_num,
      title: item.title,
      doc_type: item.doc_type,
      full_text: item.full_text || null,
      source_url: item.source_url,
      meeting_date: item.meeting_date || null,
      meeting_url: item.meeting_url || null,
      current_state: item.current_state || 'INTRODUCED'
    }, db);
    if (result.shouldNotify) newOrChanged++;
    console.log(`  ${item.ordinance_num}: ${result.action}`);
  }
  console.log(`  ${newOrChanged} new/changed items\n`);

  // Step 3: Get all unnotified ordinances
  console.log('Step 3: Getting unnotified ordinances...');
  const unnotified = await getUnnotified(db);
  console.log(`  ${unnotified.length} items pending notification\n`);

  if (!unnotified.length) {
    console.log('No items need notification. Exiting.');
    return;
  }

  // Step 4: Get vote totals for these ordinances
  console.log('Step 4: Getting vote totals...');
  const ordinanceIds = unnotified.map(o => o.id);
  const voteTotals = await getVotes(ordinanceIds, db);
  const withVotes = Object.keys(voteTotals).length;
  console.log(`  ${withVotes} items have votes\n`);

  // Step 5: Fetch all active subscriber profiles
  console.log('Step 5: Fetching subscriber profiles...');
  const { data: profiles, error: profileErr } = await db
    .from('profiles')
    .select('*')
    .eq('active', true);

  if (profileErr) throw new Error(`Failed to fetch profiles: ${profileErr.message}`);
  console.log(`  ${profiles.length} active subscribers\n`);

  if (!profiles.length) {
    console.log('No active subscribers. Exiting.');
    return;
  }

  // Split unnotified items into ordinances (deep analysis) and notices (bulk filter)
  const deepItems = unnotified.filter(o => DEEP_ANALYSIS_TYPES.has(o.doc_type));
  const noticeItems = unnotified.filter(o => !DEEP_ANALYSIS_TYPES.has(o.doc_type));
  console.log(`  ${deepItems.length} ordinances/resolutions (deep analysis), ${noticeItems.length} community notices (bulk filter)\n`);

  // Step 6: For each profile, analyze with two-tier approach
  console.log('Step 6: Analyzing items per profile with Claude...');
  const weekDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  let emailsSent = 0;
  const bulkFilter = deps.bulkFilterItems || bulkFilterItems;

  for (const profile of profiles) {
    console.log(`\n  Analyzing for ${profile.email} (Ward ${profile.ward})...`);
    const relevantItems = [];
    let completed = 0;

    // Tier 2: Deep analysis for ordinances/resolutions (1 call per item)
    if (deepItems.length > 0) {
      console.log(`    Deep analysis: ${deepItems.length} ordinances/resolutions...`);
      for (let i = 0; i < deepItems.length; i += CONCURRENCY) {
        const batch = deepItems.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (ord) => {
            const textForAnalysis = ord.full_text || ord.title;
            const analysis = await analyze(textForAnalysis, profile);
            return { ord, analysis };
          })
        );

        for (const result of results) {
          completed++;
          if (result.status === 'fulfilled') {
            const { ord, analysis } = result.value;
            if (analysis.relevance_score >= MIN_RELEVANCE_SCORE) {
              relevantItems.push({
                ...analysis,
                ordinance_id: ord.id,
                doc_type: ord.doc_type,
                source_url: ord.source_url || null,
                meeting_url: ord.meeting_url || null,
                vote_totals: voteTotals[ord.id] || null
              });
              console.log(`    [${completed}/${deepItems.length}] ${ord.ordinance_num}: score ${analysis.relevance_score} — "${analysis.plain_title}"`);
            } else {
              console.log(`    [${completed}/${deepItems.length}] ${ord.ordinance_num}: score ${analysis.relevance_score} (filtered out)`);
            }
          } else {
            const ord = batch[results.indexOf(result)];
            console.warn(`    [${completed}/${deepItems.length}] ${ord.ordinance_num}: analysis failed — ${result.reason?.message || result.reason}`);
          }
        }
      }
    }

    // Tier 1: Bulk filter for community notices + development items (1 call total)
    let relevantNotices = [];
    if (noticeItems.length > 0) {
      console.log(`    Bulk filtering: ${noticeItems.length} community notices + development items...`);
      try {
        const filtered = await bulkFilter(noticeItems, profile);
        relevantNotices = filtered.map(f => ({
          ...f,
          ordinance_id: noticeItems[f.index]?.id,
          doc_type: noticeItems[f.index]?.doc_type || 'notice',
          source_url: noticeItems[f.index]?.source_url || null,
          meeting_url: noticeItems[f.index]?.meeting_url || null,
          // Carry forward structured fields from planning items
          ward: noticeItems[f.index]?.ward || null,
          current_state: noticeItems[f.index]?.current_state || null,
          is_notice: true
        }));
        console.log(`    ${relevantNotices.length} items relevant to this person`);
      } catch (err) {
        console.warn(`    Bulk filter failed: ${err.message}`);
      }
    }

    // Split bulk filter results: development/zoning vs community notices
    const devNotices = relevantNotices.filter(n => DEVELOPMENT_TYPES.has(n.doc_type));
    const communityNotices = relevantNotices.filter(n => !DEVELOPMENT_TYPES.has(n.doc_type));

    // Sort ordinances by relevance score first, then total votes as tiebreaker
    relevantItems.sort((a, b) => {
      if (b.relevance_score !== a.relevance_score) return b.relevance_score - a.relevance_score;
      const aVotes = (a.vote_totals ? a.vote_totals.up + a.vote_totals.down : 0);
      const bVotes = (b.vote_totals ? b.vote_totals.up + b.vote_totals.down : 0);
      return bVotes - aVotes;
    });

    // Cap each section separately
    const cappedItems = relevantItems.slice(0, MAX_ITEMS_PER_DIGEST);
    const cappedDev = devNotices.slice(0, MAX_DEV_PER_DIGEST);
    const cappedNotices = communityNotices.slice(0, MAX_NOTICES_PER_DIGEST);

    if (!cappedItems.length && !cappedDev.length && !cappedNotices.length) {
      console.log(`  No relevant items for ${profile.email}, skipping email.`);
      continue;
    }

    console.log(`  ${cappedItems.length} ordinances + ${cappedDev.length} development + ${cappedNotices.length} notices for digest`);

    // Step 7: Send personalized digest email
    console.log(`  Sending digest to ${profile.email}...`);
    try {
      const result = await send(profile, cappedItems, weekDate, cappedDev, cappedNotices);
      console.log(`  Sent! ID: ${result.id}`);
      emailsSent++;
    } catch (err) {
      console.error(`  Failed to send to ${profile.email}: ${err.message}`);
    }
  }

  // Step 8: Mark all ordinances as notified
  console.log(`\nStep 7: Marking ${ordinanceIds.length} ordinances as notified...`);
  await markDone(ordinanceIds, db);

  console.log(`\n=== Done! Sent ${emailsSent} digest emails ===`);
}

module.exports = { runDigest };

// Run directly
if (require.main === module) {
  runDigest().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Pipeline failed:', err);
    process.exit(1);
  });
}
