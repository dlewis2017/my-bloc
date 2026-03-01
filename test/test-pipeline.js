const { runDigest } = require('../scripts/run-digest');

// --- Test fixtures ---

const FAKE_ITEMS = [
  {
    ordinance_num: 'Ord-26-001',
    title: 'Rent Control Amendment',
    doc_type: 'ordinance',
    full_text: 'An ordinance amending rent control...',
    source_url: 'https://example.com/ord-26-001',
    meeting_date: 'January 28 2026',
    current_state: 'INTRODUCED'
  },
  {
    ordinance_num: 'Res-26-010',
    title: 'Budget Resolution',
    doc_type: 'resolution',
    full_text: 'A resolution approving the budget...',
    source_url: 'https://example.com/res-26-010',
    meeting_date: 'January 28 2026',
    current_state: 'INTRODUCED'
  }
];

const FAKE_UNNOTIFIED = [
  { id: 'ord-26-001_rent_control', ordinance_num: 'Ord-26-001', title: 'Rent Control Amendment', doc_type: 'ordinance', full_text: 'An ordinance amending rent control...', source_url: 'https://example.com/ord-26-001' },
  { id: 'res-26-010_budget_resolution', ordinance_num: 'Res-26-010', title: 'Budget Resolution', doc_type: 'resolution', full_text: 'A resolution approving the budget...', source_url: 'https://example.com/res-26-010' }
];

const FAKE_PROFILE = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'test@example.com',
  ward: 'C',
  housing: 'Renter',
  transport: 'No car',
  has_kids: false,
  interests: ['rent control', 'transit'],
  active: true
};

const FAKE_ANALYSIS = {
  plain_title: 'Rent Control Change',
  what_is_happening: 'The city is changing rent control rules.',
  personal_impact: 'Your rent could go up.',
  relevance_score: 8,
  current_status: 'INTRODUCED',
  status_context: 'First reading complete.',
  action_available: true
};

// --- Mock helpers ---

function createCallTracker() {
  const calls = {};
  return {
    track(name) { calls[name] = (calls[name] || 0) + 1; },
    count(name) { return calls[name] || 0; },
    all() { return { ...calls }; }
  };
}

function createMockSupabase(profiles = [FAKE_PROFILE]) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq(field, value) {
              if (table === 'profiles' && field === 'active') {
                return { data: profiles, error: null };
              }
              return { data: [], error: null };
            }
          };
        },
        update() {
          return {
            in() { return { error: null }; }
          };
        }
      };
    }
  };
}

// --- Tests ---

async function test1_happyPath() {
  console.log('Test 1: Happy path — full pipeline');
  const tracker = createCallTracker();

  const deps = {
    supabase: createMockSupabase(),
    fetchCivicWeb: async () => { tracker.track('fetch'); return FAKE_ITEMS; },
    upsertOrdinance: async () => { tracker.track('upsert'); return { action: 'inserted', id: 'test', shouldNotify: true }; },
    getUnnotifiedOrdinances: async () => { tracker.track('getUnnotified'); return FAKE_UNNOTIFIED; },
    getVoteTotals: async () => { tracker.track('getVotes'); return {}; },
    analyzeOrdinance: async () => { tracker.track('analyze'); return FAKE_ANALYSIS; },
    sendDigest: async () => { tracker.track('send'); return { id: 'email-123' }; },
    markNotified: async () => { tracker.track('markNotified'); }
  };

  await runDigest(deps);

  if (tracker.count('fetch') !== 1) throw new Error(`Expected 1 fetch call, got ${tracker.count('fetch')}`);
  if (tracker.count('upsert') !== 2) throw new Error(`Expected 2 upsert calls, got ${tracker.count('upsert')}`);
  if (tracker.count('getUnnotified') !== 1) throw new Error(`Expected 1 getUnnotified call, got ${tracker.count('getUnnotified')}`);
  if (tracker.count('getVotes') !== 1) throw new Error(`Expected 1 getVotes call, got ${tracker.count('getVotes')}`);
  if (tracker.count('analyze') !== 2) throw new Error(`Expected 2 analyze calls (2 ordinances x 1 profile), got ${tracker.count('analyze')}`);
  if (tracker.count('send') !== 1) throw new Error(`Expected 1 send call, got ${tracker.count('send')}`);
  if (tracker.count('markNotified') !== 1) throw new Error(`Expected 1 markNotified call, got ${tracker.count('markNotified')}`);

  console.log('PASS: All steps called in correct order with correct counts\n');
}

async function test2_noItemsFetched() {
  console.log('Test 2: No items fetched — early exit');
  const tracker = createCallTracker();

  const deps = {
    supabase: createMockSupabase(),
    fetchCivicWeb: async () => { tracker.track('fetch'); return []; },
    upsertOrdinance: async () => { tracker.track('upsert'); return { action: 'inserted', shouldNotify: true }; },
    getUnnotifiedOrdinances: async () => { tracker.track('getUnnotified'); return []; },
    analyzeOrdinance: async () => { tracker.track('analyze'); return FAKE_ANALYSIS; },
    sendDigest: async () => { tracker.track('send'); return { id: 'x' }; },
    markNotified: async () => { tracker.track('markNotified'); }
  };

  await runDigest(deps);

  if (tracker.count('upsert') !== 0) throw new Error('Upsert should not be called when no items fetched');
  if (tracker.count('analyze') !== 0) throw new Error('Analyze should not be called when no items fetched');
  if (tracker.count('send') !== 0) throw new Error('Send should not be called when no items fetched');

  console.log('PASS: Pipeline exited early, no downstream calls\n');
}

async function test3_noActiveSubscribers() {
  console.log('Test 3: No active subscribers — skip analysis and email');
  const tracker = createCallTracker();

  const deps = {
    supabase: createMockSupabase([]),  // no profiles
    fetchCivicWeb: async () => { tracker.track('fetch'); return FAKE_ITEMS; },
    upsertOrdinance: async () => { tracker.track('upsert'); return { action: 'inserted', shouldNotify: true }; },
    getUnnotifiedOrdinances: async () => { tracker.track('getUnnotified'); return FAKE_UNNOTIFIED; },
    getVoteTotals: async () => { tracker.track('getVotes'); return {}; },
    analyzeOrdinance: async () => { tracker.track('analyze'); return FAKE_ANALYSIS; },
    sendDigest: async () => { tracker.track('send'); return { id: 'x' }; },
    markNotified: async () => { tracker.track('markNotified'); }
  };

  await runDigest(deps);

  if (tracker.count('upsert') !== 2) throw new Error('Upsert should still be called for state tracking');
  if (tracker.count('analyze') !== 0) throw new Error('Analyze should not be called with no subscribers');
  if (tracker.count('send') !== 0) throw new Error('Send should not be called with no subscribers');

  console.log('PASS: State tracked but no analysis or email sent\n');
}

async function test4_analysisFailure() {
  console.log('Test 4: Claude analysis failure — graceful handling');
  const tracker = createCallTracker();
  let analyzeCallCount = 0;

  const deps = {
    supabase: createMockSupabase(),
    fetchCivicWeb: async () => FAKE_ITEMS,
    upsertOrdinance: async () => ({ action: 'inserted', shouldNotify: true }),
    getUnnotifiedOrdinances: async () => FAKE_UNNOTIFIED,
    getVoteTotals: async () => ({}),
    analyzeOrdinance: async () => {
      analyzeCallCount++;
      if (analyzeCallCount === 1) throw new Error('Claude API timeout');
      return FAKE_ANALYSIS;
    },
    sendDigest: async () => { tracker.track('send'); return { id: 'email-456' }; },
    markNotified: async () => { tracker.track('markNotified'); }
  };

  // Should not throw
  await runDigest(deps);

  if (analyzeCallCount !== 2) throw new Error(`Expected 2 analyze attempts, got ${analyzeCallCount}`);
  if (tracker.count('send') !== 1) throw new Error('Email should still be sent for the successful analysis');
  if (tracker.count('markNotified') !== 1) throw new Error('Ordinances should still be marked notified');

  console.log('PASS: First analysis failed, second succeeded, email sent\n');
}

async function test5_allBelowThreshold() {
  console.log('Test 5: All items below relevance threshold — no email sent');
  const tracker = createCallTracker();

  const lowScoreAnalysis = { ...FAKE_ANALYSIS, relevance_score: 3 };

  const deps = {
    supabase: createMockSupabase(),
    fetchCivicWeb: async () => FAKE_ITEMS,
    upsertOrdinance: async () => ({ action: 'inserted', shouldNotify: true }),
    getUnnotifiedOrdinances: async () => FAKE_UNNOTIFIED,
    getVoteTotals: async () => ({}),
    analyzeOrdinance: async () => { tracker.track('analyze'); return lowScoreAnalysis; },
    sendDigest: async () => { tracker.track('send'); return { id: 'x' }; },
    markNotified: async () => { tracker.track('markNotified'); }
  };

  await runDigest(deps);

  if (tracker.count('analyze') !== 2) throw new Error(`Expected 2 analyze calls, got ${tracker.count('analyze')}`);
  if (tracker.count('send') !== 0) throw new Error('Send should not be called when all items are below threshold');
  if (tracker.count('markNotified') !== 1) throw new Error('Ordinances should still be marked notified');

  console.log('PASS: All items filtered out, no email sent, ordinances still marked\n');
}

async function test6_noUnnotifiedItems() {
  console.log('Test 6: No unnotified items — exit after state tracking');
  const tracker = createCallTracker();

  const deps = {
    supabase: createMockSupabase(),
    fetchCivicWeb: async () => FAKE_ITEMS,
    upsertOrdinance: async () => { tracker.track('upsert'); return { action: 'no_change', shouldNotify: false }; },
    getUnnotifiedOrdinances: async () => { tracker.track('getUnnotified'); return []; },
    getVoteTotals: async () => { tracker.track('getVotes'); return {}; },
    analyzeOrdinance: async () => { tracker.track('analyze'); return FAKE_ANALYSIS; },
    sendDigest: async () => { tracker.track('send'); return { id: 'x' }; },
    markNotified: async () => { tracker.track('markNotified'); }
  };

  await runDigest(deps);

  if (tracker.count('upsert') !== 2) throw new Error('Upsert should be called for each item');
  if (tracker.count('getUnnotified') !== 1) throw new Error('Should check for unnotified items');
  if (tracker.count('getVotes') !== 0) throw new Error('Should not fetch votes when nothing to notify');
  if (tracker.count('analyze') !== 0) throw new Error('Should not analyze when nothing to notify');
  if (tracker.count('send') !== 0) throw new Error('Should not send when nothing to notify');

  console.log('PASS: State tracked, no unnotified items, exited early\n');
}

// --- Runner ---

async function runTests() {
  console.log('Testing Digest Pipeline...\n');

  await test1_happyPath();
  await test2_noItemsFetched();
  await test3_noActiveSubscribers();
  await test4_analysisFailure();
  await test5_allBelowThreshold();
  await test6_noUnnotifiedItems();

  console.log('All pipeline tests passed!');
}

runTests().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
