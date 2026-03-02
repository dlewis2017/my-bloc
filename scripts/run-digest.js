#!/usr/bin/env node
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchCivicWeb } = require('./fetch-civicweb');
const { upsertOrdinance, getUnnotifiedOrdinances, markNotified, getVoteTotals } = require('./state-tracker');
const { analyzeOrdinance, bulkFilterItems } = require('./claude-analyzer');
const { sendDigest, generateSubjectLine } = require('./send-digest');

const MIN_RELEVANCE_SCORE = 5;
const MAX_ITEMS_PER_DIGEST = 10;
const MAX_NOTICES_PER_DIGEST = 5;
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
  const upsert = deps.upsertOrdinance || upsertOrdinance;
  const getUnnotified = deps.getUnnotifiedOrdinances || getUnnotifiedOrdinances;
  const getVotes = deps.getVoteTotals || getVoteTotals;
  const analyze = deps.analyzeOrdinance || analyzeOrdinance;
  const send = deps.sendDigest || sendDigest;
  const markDone = deps.markNotified || markNotified;

  console.log('=== MyBloc Digest Pipeline ===\n');

  // Step 1: Fetch latest ordinances/resolutions from CivicWeb
  console.log('Step 1: Fetching from CivicWeb...');
  const items = await fetch(MAX_MEETINGS);
  console.log(`  Fetched ${items.length} items\n`);

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
  const cachedWards = new Set();
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

    // Tier 1: Bulk filter for community notices (1 call total)
    let relevantNotices = [];
    if (noticeItems.length > 0) {
      console.log(`    Bulk filtering: ${noticeItems.length} community notices...`);
      try {
        const filtered = await bulkFilter(noticeItems, profile);
        relevantNotices = filtered.map(f => ({
          ...f,
          ordinance_id: noticeItems[f.index]?.id,
          doc_type: noticeItems[f.index]?.doc_type || 'notice',
          source_url: noticeItems[f.index]?.source_url || null,
          meeting_url: noticeItems[f.index]?.meeting_url || null,
          is_notice: true
        }));
        console.log(`    ${relevantNotices.length} notices relevant to this person`);
      } catch (err) {
        console.warn(`    Bulk filter failed: ${err.message}`);
      }
    }

    // Sort ordinances by total votes then relevance score
    relevantItems.sort((a, b) => {
      const aVotes = (a.vote_totals ? a.vote_totals.up + a.vote_totals.down : 0);
      const bVotes = (b.vote_totals ? b.vote_totals.up + b.vote_totals.down : 0);
      if (bVotes !== aVotes) return bVotes - aVotes;
      return b.relevance_score - a.relevance_score;
    });

    // Cap each tier separately
    const cappedItems = relevantItems.slice(0, MAX_ITEMS_PER_DIGEST);
    const cappedNotices = relevantNotices.slice(0, MAX_NOTICES_PER_DIGEST);

    if (!cappedItems.length && !cappedNotices.length) {
      console.log(`  No relevant items for ${profile.email}, skipping email.`);
      continue;
    }

    console.log(`  ${cappedItems.length} ordinances + ${cappedNotices.length} notices for digest`);

    // Cache top 3 ordinance items for welcome emails (first subscriber per ward wins)
    if (profile.ward && !cachedWards.has(profile.ward) && cappedItems.length > 0) {
      cachedWards.add(profile.ward);
      const highlightItems = cappedItems.slice(0, 3);
      try {
        await db.from('ward_highlights').upsert({
          ward: profile.ward,
          items: highlightItems,
          week_date: weekDate,
          updated_at: new Date().toISOString()
        });
        console.log(`  Cached ${highlightItems.length} highlights for Ward ${profile.ward}`);
      } catch (err) {
        console.warn(`  Failed to cache highlights for Ward ${profile.ward}: ${err.message}`);
      }
    }

    // Step 7: Send personalized digest email
    console.log(`  Sending digest to ${profile.email}...`);
    try {
      const result = await send(profile, cappedItems, weekDate, cappedNotices);
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
