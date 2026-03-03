#!/usr/bin/env node
/**
 * Integration test for the Planning Board / Zoning Board fetcher.
 * Tests each layer: API fetch → PDF download → case parsing → output format.
 *
 * Usage:
 *   node test/test-fetch-planning-board.js
 */
const { fetchAttachmentList, downloadAndParsePdf, parseCases, parseDateFromId, fetchPlanningBoard } = require('../scripts/fetch-planning-board');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function testDateParsing() {
  console.log('\n--- Date Parsing ---');

  const pb = parseDateFromId('05_march_10_2026_mtg_pdf');
  assert(pb.date === 'March 10, 2026', `Planning Board date: ${pb.date}`);
  assert(pb.isoDate === '2026-03-10', `Planning Board ISO: ${pb.isoDate}`);

  const zb = parseDateFromId('3_march_5th_agn_pdf');
  assert(zb.date !== null, `Zoning Board date parsed: ${zb.date}`);
  assert(zb.isoDate !== null, `Zoning Board ISO: ${zb.isoDate}`);

  const versioned = parseDateFromId('04_february_24_2026_mtg_v3_pdf');
  assert(versioned.date === 'February 24, 2026', `Versioned filename: ${versioned.date}`);
}

async function testAttachmentList() {
  console.log('\n--- Attachment List API ---');

  const pbAttachments = await fetchAttachmentList('planning-board-agendas-2026', 'Planning Board');
  assert(pbAttachments.length > 0, `Planning Board: ${pbAttachments.length} attachments`);
  assert(pbAttachments[0].id !== undefined, 'Has id field');
  assert(pbAttachments[0].url !== undefined, 'Has url field');
  assert(pbAttachments[0].board === 'Planning Board', 'Has board field');

  const zbAttachments = await fetchAttachmentList('zb-agendas-2026', 'Zoning Board');
  assert(zbAttachments.length > 0, `Zoning Board: ${zbAttachments.length} attachments`);
}

async function testPdfDownload() {
  console.log('\n--- PDF Download ---');

  const attachments = await fetchAttachmentList('planning-board-agendas-2026', 'Planning Board');
  const latest = attachments[attachments.length - 1];
  console.log(`  Downloading: ${latest.title}`);

  const text = await downloadAndParsePdf(latest.url);
  assert(text !== null, 'PDF downloaded and parsed');
  assert(text.length > 500, `PDF text length: ${text.length} chars`);
  assert(text.includes('JERSEY CITY'), 'Contains expected header text');
}

async function testCaseParsing() {
  console.log('\n--- Case Parsing ---');

  const attachments = await fetchAttachmentList('planning-board-agendas-2026', 'Planning Board');
  const latest = attachments[attachments.length - 1];
  const text = await downloadAndParsePdf(latest.url);
  const cases = parseCases(text);

  assert(cases.length > 0, `Parsed ${cases.length} cases`);

  // Check structure of first case
  const first = cases[0];
  assert(first.ordinance_num !== undefined, `Has ordinance_num: ${first.ordinance_num}`);
  assert(first.title !== undefined, `Has title: ${first.title.slice(0, 60)}`);
  assert(first.doc_type === 'planning', `doc_type is planning`);
  assert(first.current_state !== undefined, `Has current_state: ${first.current_state}`);
  assert(first.full_text !== undefined, 'Has full_text');

  // Check that some cases have structured fields
  const withWard = cases.filter(c => c.ward);
  const withAddress = cases.filter(c => c.address);
  assert(withAddress.length > 0, `${withAddress.length}/${cases.length} have address`);
  console.log(`  ${withWard.length}/${cases.length} have ward (some adjournment entries won't)`);

  // Validate case number formats
  const validPattern = /^[PZ]?\d[\w-]+$/;
  const allValid = cases.every(c => validPattern.test(c.ordinance_num));
  assert(allValid, 'All case numbers match expected pattern');
}

async function testZoningBoard() {
  console.log('\n--- Zoning Board ---');

  const attachments = await fetchAttachmentList('zb-agendas-2026', 'Zoning Board');
  if (attachments.length === 0) {
    console.log('  (No ZB attachments found, skipping)');
    return;
  }

  const latest = attachments[attachments.length - 1];
  console.log(`  Downloading: ${latest.title}`);
  const text = await downloadAndParsePdf(latest.url);

  if (!text || text.length < 100) {
    console.log('  (ZB PDF too short, skipping)');
    return;
  }

  const cases = parseCases(text);
  assert(cases.length > 0, `Parsed ${cases.length} ZB cases`);

  const zCases = cases.filter(c => c.ordinance_num.startsWith('Z'));
  assert(zCases.length > 0, `${zCases.length} cases have Z prefix`);
}

async function testFullFetch() {
  console.log('\n--- Full fetchPlanningBoard ---');

  const items = await fetchPlanningBoard(1); // only 1 agenda per board for speed
  assert(items.length > 0, `Got ${items.length} total items`);

  // Check pipeline contract fields
  const required = ['ordinance_num', 'title', 'doc_type', 'source_url', 'current_state'];
  const first = items[0];
  for (const field of required) {
    assert(first[field] !== undefined && first[field] !== null, `Pipeline field: ${field}`);
  }

  // Check meeting metadata
  const withMeetingDate = items.filter(i => i.meeting_date);
  assert(withMeetingDate.length > 0, `${withMeetingDate.length}/${items.length} have meeting_date`);
}

async function main() {
  console.log('=== Planning Board Fetcher Tests ===');

  await testDateParsing();
  await testAttachmentList();
  await testPdfDownload();
  await testCaseParsing();
  await testZoningBoard();
  await testFullFetch();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
