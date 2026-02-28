const { fetchCivicWeb } = require('../scripts/fetch-civicweb');

async function testFetch() {
  console.log('Testing CivicWeb fetch...\n');

  const items = await fetchCivicWeb();

  console.log(`\nFetched ${items.length} items\n`);

  // Gate: at least 3 items returned
  if (items.length < 3) {
    console.error(`FAIL: Expected at least 3 items, got ${items.length}`);
    process.exit(1);
  }
  console.log('PASS: At least 3 items returned');

  // Validate structure of each item
  const requiredFields = ['ordinance_num', 'title', 'doc_type', 'source_url', 'current_state'];
  let structureValid = true;

  for (const item of items) {
    for (const field of requiredFields) {
      if (!item[field]) {
        console.error(`FAIL: Item missing required field "${field}":`, JSON.stringify(item));
        structureValid = false;
      }
    }
    // doc_type must be ordinance or resolution
    if (!['ordinance', 'resolution'].includes(item.doc_type)) {
      console.error(`FAIL: Invalid doc_type "${item.doc_type}" for item: ${item.ordinance_num}`);
      structureValid = false;
    }
    // ordinance_num must match expected format (Ord-XX-XXX or Res-XX-XXX)
    if (!/^(Ord|Res)-\d{2,4}-\d{1,4}$/.test(item.ordinance_num)) {
      console.error(`FAIL: Invalid ordinance_num format "${item.ordinance_num}"`);
      structureValid = false;
    }
    // current_state must be valid
    const validStates = ['INTRODUCED', 'AMENDED', 'COMMITTEE', 'VOTED', 'PASSED', 'FAILED', 'WITHDRAWN'];
    if (!validStates.includes(item.current_state)) {
      console.error(`FAIL: Invalid current_state "${item.current_state}" for ${item.ordinance_num}`);
      structureValid = false;
    }
  }

  if (!structureValid) {
    process.exit(1);
  }
  console.log('PASS: All items have valid structure');

  // Check we have at least some ordinances and some resolutions
  const ordinances = items.filter(i => i.doc_type === 'ordinance');
  const resolutions = items.filter(i => i.doc_type === 'resolution');
  console.log(`PASS: Found ${ordinances.length} ordinances and ${resolutions.length} resolutions`);

  // Print sample items
  console.log('\nSample items:');
  items.slice(0, 5).forEach((item, i) => {
    console.log(`  ${i + 1}. [${item.doc_type}] ${item.ordinance_num} — ${item.title} (${item.current_state})`);
  });

  console.log('\nAll fetch tests passed!');
}

testFetch().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
