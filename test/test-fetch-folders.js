/**
 * Integration test for the expanded scraper (folders + agenda PDF parsing).
 * Tests each layer independently against live CivicWeb:
 *   1. fetchMeetingList — gets meetings
 *   2. findAllDocumentFolders — finds document folders + agenda PDF link
 *   3. parseDocumentFolder — parses ordinance/resolution items
 *   4. parseAgendaPdf — extracts community notices from agenda PDF
 *   5. extractPdfText — downloads and parses a PDF
 *
 * Run: node test/test-fetch-folders.js
 */
const { chromium } = require('playwright');
const { fetchMeetingList, findAllDocumentFolders, parseDocumentFolder, parseAgendaPdf, extractPdfText } = require('../scripts/fetch-civicweb');

const VALID_STATES = ['INTRODUCED', 'AMENDED', 'COMMITTEE', 'VOTED', 'PASSED', 'FAILED', 'WITHDRAWN'];

let failures = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); }
function fail(msg) { console.error(`  FAIL: ${msg}`); failures++; }

async function testFetchFolders() {
  console.log('=== Multi-Source Scraper Integration Test ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // --- Layer 1: Meeting list ---
  console.log('Layer 1: fetchMeetingList');
  const meetings = await fetchMeetingList(page);

  if (meetings.length === 0) {
    fail('No meetings found');
    await browser.close();
    process.exit(1);
  }
  pass(`Found ${meetings.length} meetings`);

  const meeting = meetings[0];
  if (!meeting.meetingId || !meeting.url) {
    fail(`First meeting missing meetingId or url: ${JSON.stringify(meeting)}`);
  } else {
    pass(`First meeting: "${meeting.title}" (ID: ${meeting.meetingId})`);
  }

  // --- Layer 2: Find document folders + agenda URL ---
  console.log(`\nLayer 2: findAllDocumentFolders (${meeting.title})`);
  const { folders, agendaUrl } = await findAllDocumentFolders(page, meeting.url);

  if (folders.length === 0) {
    fail('No document folders found');
  } else {
    pass(`Found ${folders.length} folder(s): ${folders.map(f => `"${f.name}" [${f.category}]`).join(', ')}`);
  }

  // Verify no root-level "Document Center" snuck through
  for (const folder of folders) {
    if (folder.url.match(/\/filepro\/documents\/?$/)) {
      fail(`Root "Document Center" link not filtered: ${folder.url}`);
    }
  }

  if (agendaUrl) {
    pass(`Agenda PDF URL found: ${agendaUrl}`);
  } else {
    fail('No agenda PDF URL found on meeting page');
  }

  // --- Layer 3: Parse ordinance folder ---
  console.log('\nLayer 3: parseDocumentFolder');
  const ordFolder = folders.find(f => f.category === 'ordinance');
  if (!ordFolder) {
    fail('No ordinance folder to test');
  } else {
    const items = await parseDocumentFolder(page, ordFolder.url, ordFolder.category);
    if (items.length === 0) {
      fail('No items in ordinance folder');
    } else {
      pass(`${items.length} ordinances/resolutions parsed`);

      for (const item of items) {
        if (!item.ordinance_num || !item.title || !item.doc_type || !item.source_url) {
          fail(`Item missing required fields: ${JSON.stringify(item)}`);
        }
        if (!['ordinance', 'resolution'].includes(item.doc_type)) {
          fail(`Unexpected doc_type "${item.doc_type}" in ordinance folder`);
        }
        if (!/^(Ord|Res)-\d{2,4}-\d{1,4}$/.test(item.ordinance_num)) {
          fail(`Invalid ordinance_num format: "${item.ordinance_num}"`);
        }
      }
      pass('All ordinance items have valid structure');

      // Print a few samples
      items.slice(0, 3).forEach(item => {
        console.log(`    ${item.ordinance_num} [${item.doc_type}] — ${item.title.slice(0, 80)}`);
      });
    }
  }

  // --- Layer 4: Parse agenda PDF for notices ---
  console.log('\nLayer 4: parseAgendaPdf');
  if (!agendaUrl) {
    console.log('  SKIP: No agenda URL to test');
  } else {
    const notices = await parseAgendaPdf(context.request, agendaUrl, meeting.date);
    if (notices.length === 0) {
      fail('No notice items parsed from agenda PDF');
    } else {
      pass(`${notices.length} notice items parsed from agenda`);

      // Validate structure
      const validNoticeTypes = ['communication', 'claims'];
      for (const notice of notices) {
        if (!notice.ordinance_num || !notice.title || !notice.doc_type) {
          fail(`Notice missing required fields: ${JSON.stringify(notice)}`);
        }
        if (!validNoticeTypes.includes(notice.doc_type)) {
          fail(`Unexpected notice doc_type: "${notice.doc_type}"`);
        }
        if (notice.current_state !== 'PASSED') {
          fail(`Notice should be PASSED, got: "${notice.current_state}"`);
        }
        if (!notice.full_text || notice.full_text.length < 10) {
          fail(`Notice missing full_text: ${notice.ordinance_num}`);
        }
      }
      pass('All notices have valid structure');

      // Group by type and print samples
      const byType = {};
      for (const n of notices) {
        (byType[n.doc_type] = byType[n.doc_type] || []).push(n);
      }
      for (const [type, typeItems] of Object.entries(byType)) {
        console.log(`    ${type} (${typeItems.length}):`);
        typeItems.slice(0, 3).forEach(n => {
          console.log(`      ${n.ordinance_num} — ${n.title.slice(0, 100)}`);
        });
        if (typeItems.length > 3) console.log(`      ... and ${typeItems.length - 3} more`);
      }
    }
  }

  // --- Layer 5: PDF extraction sample ---
  console.log('\nLayer 5: extractPdfText (sample ordinance)');
  if (ordFolder) {
    const items = await parseDocumentFolder(page, ordFolder.url, ordFolder.category);
    const sample = items[0];
    if (sample) {
      const text = await extractPdfText(page, context.request, sample.source_url);
      if (text && text.length > 50) {
        pass(`Extracted ${text.length} chars from ${sample.ordinance_num}`);
      } else {
        fail(`PDF extraction returned no text for ${sample.ordinance_num}`);
      }
    }
  }

  // --- Summary ---
  await browser.close();

  console.log(`\n=== ${failures === 0 ? 'All tests passed!' : `${failures} failure(s)`} ===`);
  if (failures > 0) process.exit(1);
}

testFetchFolders().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
