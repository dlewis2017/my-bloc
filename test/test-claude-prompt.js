require('dotenv').config();
const { analyzeOrdinance } = require('../scripts/claude-analyzer');

const SAMPLE_ORDINANCE = `
ORDINANCE 26-007
AN ORDINANCE AMENDING CHAPTER 260 OF THE JERSEY CITY CODE ENTITLED "RENT CONTROL"
TO INCREASE THE MAXIMUM ALLOWABLE RENT INCREASE FROM 4% TO 5.5% PER ANNUM FOR
RESIDENTIAL UNITS IN BUILDINGS WITH SIX OR MORE UNITS, AND TO ESTABLISH A NEW
HARDSHIP EXEMPTION PROCESS FOR LANDLORDS DEMONSTRATING OPERATING COST INCREASES
EXCEEDING 8% ANNUALLY.

INTRODUCED: January 28, 2026
STATUS: INTRODUCED — First reading complete, public hearing scheduled for February 11, 2026.
SPONSOR: Council Member Ward C
`;

const PROFILE_RENTER = {
  ward: 'C',
  housing: 'Renter',
  transport: 'No car',
  has_kids: false,
  interests: ['rent control', 'transit', 'noise']
};

const PROFILE_HOMEOWNER = {
  ward: 'A',
  housing: 'Homeowner',
  transport: 'Car owner',
  has_kids: true,
  interests: ['schools', 'property tax', 'parking']
};

async function testClaudePrompt() {
  console.log('Testing Claude Analyzer...\n');

  // Test with renter profile
  console.log('Test 1: Analyzing for renter profile (Ward C)...');
  const renterResult = await analyzeOrdinance(SAMPLE_ORDINANCE, PROFILE_RENTER);
  console.log('Renter result:', JSON.stringify(renterResult, null, 2));

  // Validate structure
  const requiredFields = ['plain_title', 'what_is_happening', 'personal_impact', 'relevance_score', 'current_status', 'status_context', 'action_available'];
  for (const field of requiredFields) {
    if (!(field in renterResult)) {
      console.error(`FAIL: Missing field "${field}" in renter result`);
      process.exit(1);
    }
  }
  console.log('PASS: Renter result has all required fields\n');

  // Validate types
  if (typeof renterResult.relevance_score !== 'number' || renterResult.relevance_score < 1 || renterResult.relevance_score > 10) {
    console.error(`FAIL: relevance_score should be 1-10, got ${renterResult.relevance_score}`);
    process.exit(1);
  }
  console.log('PASS: relevance_score is valid number\n');

  // Test with homeowner profile
  console.log('Test 2: Analyzing for homeowner profile (Ward A)...');
  const homeownerResult = await analyzeOrdinance(SAMPLE_ORDINANCE, PROFILE_HOMEOWNER);
  console.log('Homeowner result:', JSON.stringify(homeownerResult, null, 2));

  for (const field of requiredFields) {
    if (!(field in homeownerResult)) {
      console.error(`FAIL: Missing field "${field}" in homeowner result`);
      process.exit(1);
    }
  }
  console.log('PASS: Homeowner result has all required fields\n');

  // Verify the two profiles produce different personal_impact
  if (renterResult.personal_impact === homeownerResult.personal_impact) {
    console.error('FAIL: Both profiles produced the same personal_impact');
    process.exit(1);
  }
  console.log('PASS: Personal impact differs between profiles');
  console.log(`  Renter: "${renterResult.personal_impact}"`);
  console.log(`  Homeowner: "${homeownerResult.personal_impact}"`);

  // Renter should score higher for a rent control ordinance
  if (renterResult.relevance_score <= homeownerResult.relevance_score) {
    console.warn(`WARNING: Expected renter to score higher than homeowner for rent control ordinance`);
    console.warn(`  Renter score: ${renterResult.relevance_score}, Homeowner score: ${homeownerResult.relevance_score}`);
  } else {
    console.log(`PASS: Renter scored higher (${renterResult.relevance_score}) than homeowner (${homeownerResult.relevance_score}) for rent control\n`);
  }

  console.log('\nAll Claude analyzer tests passed!');
}

testClaudePrompt().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
