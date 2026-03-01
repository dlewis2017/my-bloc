require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// State machine — only notify on state changes
const VALID_TRANSITIONS = {
  INTRODUCED:  ['AMENDED', 'COMMITTEE', 'VOTED', 'WITHDRAWN'],
  AMENDED:     ['COMMITTEE', 'VOTED', 'WITHDRAWN'],
  COMMITTEE:   ['VOTED', 'WITHDRAWN'],
  VOTED:       ['PASSED', 'FAILED'],
  PASSED:      [],  // terminal
  FAILED:      [],  // terminal
  WITHDRAWN:   []   // terminal
};

/**
 * Generate stable ID from ordinance number + title.
 */
function generateStableId(ordinanceNum, title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  return `${ordinanceNum}_${slug}`;
}

/**
 * Upsert an ordinance into the database with state tracking.
 * Only marks for notification on new inserts or state changes.
 *
 * @param {Object} ordinanceData - { ordinance_num, title, doc_type, full_text, source_url, meeting_date, meeting_url, current_state }
 * @param {Object} [client] - optional Supabase client (for testing)
 * @returns {{ action: string, id: string, shouldNotify: boolean }}
 */
async function upsertOrdinance(ordinanceData, client) {
  const db = client || supabase;
  const id = generateStableId(ordinanceData.ordinance_num, ordinanceData.title);

  const { data: existing, error: fetchError } = await db
    .from('ordinances')
    .select('id, current_state, notified_at')
    .eq('id', id)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    // PGRST116 = "not found", which is expected for new items
    throw new Error(`Failed to fetch ordinance ${id}: ${fetchError.message}`);
  }

  if (existing) {
    const newState = ordinanceData.current_state;
    const stateChanged = existing.current_state !== newState;

    if (stateChanged) {
      // Validate state transition
      const validNext = VALID_TRANSITIONS[existing.current_state] || [];
      if (validNext.length > 0 && !validNext.includes(newState)) {
        console.warn(`Invalid state transition for ${id}: ${existing.current_state} → ${newState}. Skipping.`);
        return { action: 'invalid_transition', id, shouldNotify: false };
      }

      const { error: updateError } = await db.from('ordinances').update({
        previous_state: existing.current_state,
        current_state: newState,
        last_updated: new Date().toISOString(),
        full_text: ordinanceData.full_text || null,
        notified_at: null  // reset so it gets included in next digest
      }).eq('id', id);

      if (updateError) throw new Error(`Failed to update ${id}: ${updateError.message}`);
      return { action: 'state_changed', id, shouldNotify: true };
    }

    return { action: 'no_change', id, shouldNotify: false };
  } else {
    const { error: insertError } = await db.from('ordinances').insert({
      id,
      ordinance_num: ordinanceData.ordinance_num,
      title: ordinanceData.title,
      doc_type: ordinanceData.doc_type || 'ordinance',
      full_text: ordinanceData.full_text || null,
      source_url: ordinanceData.source_url || null,
      meeting_date: ordinanceData.meeting_date || null,
      meeting_url: ordinanceData.meeting_url || null,
      current_state: ordinanceData.current_state || 'INTRODUCED'
    });

    if (insertError) throw new Error(`Failed to insert ${id}: ${insertError.message}`);
    return { action: 'inserted', id, shouldNotify: true };
  }
}

/**
 * Get all ordinances that need notification (notified_at is null and have had state changes).
 */
async function getUnnotifiedOrdinances(client) {
  const db = client || supabase;
  const { data, error } = await db
    .from('ordinances')
    .select('*')
    .is('notified_at', null)
    .order('last_updated', { ascending: false });

  if (error) throw new Error(`Failed to fetch unnotified ordinances: ${error.message}`);
  return data || [];
}

/**
 * Mark ordinances as notified after sending digests.
 */
async function markNotified(ordinanceIds, client) {
  const db = client || supabase;
  const { error } = await db
    .from('ordinances')
    .update({ notified_at: new Date().toISOString() })
    .in('id', ordinanceIds);

  if (error) throw new Error(`Failed to mark notified: ${error.message}`);
}

/**
 * Get vote totals (up/down counts) for a list of ordinance IDs.
 * @param {string[]} ordinanceIds
 * @param {Object} [client] - optional Supabase client
 * @returns {Object} { [ordinance_id]: { up: N, down: N } }
 */
async function getVoteTotals(ordinanceIds, client) {
  if (!ordinanceIds.length) return {};
  const db = client || supabase;

  const { data, error } = await db
    .from('votes')
    .select('ordinance_id, vote')
    .in('ordinance_id', ordinanceIds);

  if (error) throw new Error(`Failed to fetch vote totals: ${error.message}`);

  const totals = {};
  for (const row of (data || [])) {
    if (!totals[row.ordinance_id]) totals[row.ordinance_id] = { up: 0, down: 0 };
    if (row.vote === 'up') totals[row.ordinance_id].up++;
    else if (row.vote === 'down') totals[row.ordinance_id].down++;
  }
  return totals;
}

module.exports = { generateStableId, upsertOrdinance, getUnnotifiedOrdinances, markNotified, getVoteTotals, VALID_TRANSITIONS };
