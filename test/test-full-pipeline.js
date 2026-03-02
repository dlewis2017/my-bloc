#!/usr/bin/env node
/**
 * Full pipeline test run — identical to the Thursday cron job,
 * but limited to a single subscriber email for safe testing.
 *
 * By default, only processes items that haven't been notified yet (same as production).
 * Use --all to include already-notified items without marking them as sent again.
 *
 * Usage:
 *   node test/test-full-pipeline.js                    # new items only, TEST_EMAIL from .env
 *   node test/test-full-pipeline.js --all              # all items, TEST_EMAIL from .env
 *   node test/test-full-pipeline.js user@example.com   # new items only, custom email
 *   node test/test-full-pipeline.js --all user@email   # all items, custom email
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runDigest } = require('../scripts/run-digest');

// Parse args
const args = process.argv.slice(2);
const includeAll = args.includes('--all');
const emailArg = args.find(a => !a.startsWith('--'));
const testEmail = emailArg || process.env.TEST_EMAIL;

if (!testEmail) {
  console.error('No test email provided. Pass as argument or set TEST_EMAIL in .env');
  process.exit(1);
}

console.log(`\n=== Full Pipeline Test ===`);
console.log(`  Email: ${testEmail}`);
console.log(`  Mode:  ${includeAll ? 'ALL items (ignoring notified_at)' : 'new items only'}\n`);

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Build dependency overrides
const deps = { supabase: db };

if (includeAll) {
  // Override getUnnotifiedOrdinances to return ALL items regardless of notified_at
  deps.getUnnotifiedOrdinances = async (client) => {
    const { data, error } = await (client || db)
      .from('ordinances')
      .select('*')
      .order('last_updated', { ascending: false });
    if (error) throw new Error(`Failed to fetch ordinances: ${error.message}`);
    console.log(`  (--all mode: returning all ${data.length} items, not just unnotified)`);
    return data || [];
  };

  // Override markNotified to be a no-op so we don't mark items as sent
  deps.markNotified = async () => {
    console.log(`  (--all mode: skipping markNotified to keep items re-testable)`);
  };
}

// Override sendDigest to redirect all emails to test address
const { sendDigest } = require('../scripts/send-digest');
deps.sendDigest = async (profile, items, weekDate, notices) => {
  const testProfile = { ...profile, email: testEmail };
  return sendDigest(testProfile, items, weekDate, notices);
};

// Fetch only the test profile
const originalGetProfiles = async () => {
  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('active', true)
    .eq('email', testEmail);
  if (error) throw new Error(`Failed to fetch profiles: ${error.message}`);
  if (!data.length) {
    console.error(`No active profile found for ${testEmail}`);
    process.exit(1);
  }
  return data;
};

// Monkey-patch: runDigest fetches profiles directly from db, so we intercept
// by wrapping the supabase client's profiles query
const originalFrom = db.from.bind(db);
db.from = (table) => {
  if (table === 'profiles') {
    const builder = originalFrom(table);
    const originalSelect = builder.select.bind(builder);
    builder.select = (...selectArgs) => {
      const chain = originalSelect(...selectArgs);
      const originalEq = chain.eq.bind(chain);
      chain.eq = (col, val) => {
        const result = originalEq(col, val);
        if (col === 'active') {
          return result.eq('email', testEmail);
        }
        return result;
      };
      return chain;
    };
    return builder;
  }
  return originalFrom(table);
};

runDigest(deps).then(() => {
  console.log('\n=== Pipeline test complete ===');
  process.exit(0);
}).catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
