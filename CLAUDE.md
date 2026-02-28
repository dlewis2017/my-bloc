# CivicPulse — Project Spec for Autonomous Build

## What You Are Building

A personalized civic digest system for Jersey City, NJ residents. It monitors local government documents, analyzes them against each subscriber's profile, and sends a weekly personalized email digest explaining what's happening and why it matters to *that specific person*.

This is not a generic newsletter. Two subscribers receive completely different emails for the same agenda — a renter in Ward C gets a rent control angle, a homeowner in Ward A gets a property tax and schools angle.

---

## Architecture Overview

```
Government Sources → Fetch + Parse → State Tracker → Claude Analysis → Personalized Email
                                           ↓
                                      Supabase DB
                                    (ordinances + profiles + votes)
```

**Orchestration:** n8n (workflow automation, self-hosted locally via `npx n8n`)
**Database:** Supabase (free tier — Postgres + auth + row-level security)
**AI Analysis:** Claude API (claude-opus-4-20250514 model)
**Email Delivery:** Resend (free tier, up to 3,000 emails/month)
**Web Scraping:** Playwright (fallback only — primary source is email parsing)

---

## Data Sources

All sources are verified as legitimate — they are directly linked from `jerseycitynj.gov`.

| Source | URL | What it provides | Trigger |
|--------|-----|-----------------|---------|
| CivicWeb | `cityofjerseycity.civicweb.net` | Ordinances, resolutions, meeting agendas & minutes | Post-meeting Thursday AM |
| Jersey City .gov | `jerseycitynj.gov/cityhall/MayorSolomon/mayoralexecutiveorders` | Executive orders (Mayor, no council vote) | Daily check 9AM |
| Municode | `library.municode.com/nj/jersey_city` | Codified/passed law text | On-demand lookup |
| JC Open Data | `data.jerseycitynj.gov` | Zoning Board agendas | Post-Thursday-meeting |

### Document Types to Track

1. **Ordinances** — multi-meeting lifecycle (INTRODUCED → AMENDED → COMMITTEE → VOTED → PASSED/FAILED)
2. **Resolutions** — single-meeting pass, approve contracts/spending/development
3. **Executive Orders** — Mayor issues unilaterally, unpredictable timing
4. **Zoning Board decisions** — variances and development applications, ward-specific
5. **Budget approvals** — annual + amendments, affects property tax
6. **Redevelopment plans** — neighborhood-scale, rare but high impact

---

## Database Schema

Run this SQL in the Supabase SQL editor to create all tables:

```sql
-- Tracks every government document with full state history
create table ordinances (
  id             text primary key,           -- stable hash: ordinance_num + slugified title
  ordinance_num  text,
  title          text not null,
  doc_type       text,                        -- ordinance | resolution | exec_order | zoning | budget | redevelopment
  full_text      text,
  source_url     text,
  meeting_date   date,
  first_seen     timestamptz default now(),
  last_updated   timestamptz default now(),
  current_state  text default 'INTRODUCED',  -- INTRODUCED | AMENDED | COMMITTEE | VOTED | PASSED | FAILED | WITHDRAWN
  previous_state text,
  notified_at    timestamptz                 -- prevents double-notification
);

-- One row per subscriber
create table profiles (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  ward        text,                           -- A | B | C | D | E | F
  housing     text,                           -- Renter | Homeowner | Section 8
  transport   text,                           -- No car | Car owner | Transit dependent
  has_kids    boolean default false,
  interests   text[],                         -- ['rent control','transit','noise','schools','property tax','parking','development']
  active      boolean default true,
  created_at  timestamptz default now()
);

-- Thumbs up/down reactions per person per document
create table votes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references profiles(id),
  ordinance_id text references ordinances(id),
  vote         text,                           -- 'up' | 'down'
  voted_at     timestamptz default now(),
  unique(user_id, ordinance_id)               -- one vote per person per item
);

-- Row level security — profiles are private
alter table profiles enable row level security;
alter table votes enable row level security;
```

---

## State Tracker Logic

This is critical. An ordinance introduced in January should NOT appear as a "new" item in February. The state machine prevents duplicate notifications.

```javascript
// Generate stable ID from ordinance number + title
function generateStableId(ordinanceNum, title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  return `${ordinanceNum}_${slug}`;
}

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

async function upsertOrdinance(supabase, ordinanceData) {
  const id = generateStableId(ordinanceData.ordinance_num, ordinanceData.title);

  const { data: existing } = await supabase
    .from('ordinances')
    .select('id, current_state, notified_at')
    .eq('id', id)
    .single();

  if (existing) {
    const stateChanged = existing.current_state !== ordinanceData.current_state;
    if (stateChanged) {
      await supabase.from('ordinances').update({
        previous_state: existing.current_state,
        current_state: ordinanceData.current_state,
        last_updated: new Date(),
        full_text: ordinanceData.full_text,
        notified_at: null  // reset so it gets included in next digest
      }).eq('id', id);
      return { action: 'state_changed', id, shouldNotify: true };
    }
    return { action: 'no_change', id, shouldNotify: false };
  } else {
    await supabase.from('ordinances').insert({ id, ...ordinanceData });
    return { action: 'inserted', id, shouldNotify: true };
  }
}
```

---

## n8n Workflows to Build

### Workflow 1: Weekly Council Digest (runs Thursday 8AM via cron)

```
Trigger (Cron: Thursday 8AM)
  → Fetch CivicWeb agenda page (HTTP Request to cityofjerseycity.civicweb.net/Portal/MeetingInformation.aspx)
  → Parse HTML for agenda items (Code node — extract titles, ordinance numbers, doc types)
  → For each item: run State Tracker upsert (Supabase node)
  → Collect all items where shouldNotify = true
  → Fetch all active subscriber profiles (Supabase node: SELECT * FROM profiles WHERE active = true)
  → For each profile × each notifiable item:
      → Call Claude API (Anthropic node — see prompt template below)
      → Filter items with relevance_score >= 5
  → Group by subscriber email
  → Send personalized digest via Resend (one email per subscriber)
  → Update notified_at on each ordinance that was included
```

### Workflow 2: Daily Executive Order Check (runs every day 9AM via cron)

```
Trigger (Cron: daily 9AM)
  → Fetch jerseycitynj.gov/cityhall/MayorSolomon/mayoralexecutiveorders (HTTP Request)
  → Parse for any orders newer than yesterday (Code node — check dates)
  → If none found: stop workflow
  → If new orders found: run same State Tracker + Claude + Resend pipeline as Workflow 1
```

### Playwright Fetch Helper (used by both workflows as fallback)

```javascript
// n8n Code node — fetch dynamic page content
const { chromium } = require('playwright');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
const content = await page.content();
await browser.close();

// Strip HTML tags, normalize whitespace
const text = content
  .replace(/]*>[\s\S]*?<\/script>/gi, '')
  .replace(/]*>[\s\S]*?<\/style>/gi, '')
  .replace(/]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

return { text, url, fetched_at: new Date().toISOString() };
```

---

## Claude API Prompt Template

This is the exact prompt to use in the Anthropic n8n node for analysis. Inject `{ordinance_text}` and `{user_profile}` dynamically.

```
You are a civic intelligence assistant for Jersey City, NJ residents.

Analyze the following government document and user profile. Return a JSON object only — no markdown, no preamble.

DOCUMENT:
{ordinance_text}

USER PROFILE:
Ward: {ward}
Housing: {housing}
Transport: {transport}
Has kids: {has_kids}
Interests: {interests}

Return this exact JSON structure:
{
  "plain_title": "short plain-English title (not the legal name)",
  "what_is_happening": "2 sentences max explaining what this document does",
  "personal_impact": "1-2 sentences explaining how this specifically affects THIS user based on their profile. Be direct and concrete.",
  "relevance_score": <integer 1-10>,
  "current_status": "<INTRODUCED|AMENDED|COMMITTEE|VOTED|PASSED|FAILED>",
  "status_context": "one sentence explaining what this status means in plain English, e.g. 'This passed 6-3 at Wednesday's meeting and is now law.'",
  "action_available": <true|false>
}

Scoring guide:
- 8-10: Directly affects this user's housing, finances, commute, or children
- 5-7: Relevant to their ward or interests but indirect impact
- 1-4: Citywide background info, low personal relevance

Only return the JSON. No other text.
```

---

## Email Template

Build the email digest using this structure. Each subscriber gets a fully personalized version.

```html
Subject: 🏙️ JC This Week — {personalized_subject_line}

Your Jersey City Digest
Week of {date} · Ward {ward}

<!-- For each item with relevance_score >= 5, sorted high to low -->

  {doc_type} · {current_status}
  {plain_title}
  {what_is_happening}

    What this means for you: {personal_impact}

  {status_context}

    👍 Support   &nbsp;&nbsp;   👎 Oppose

  {#if vote_totals}
    Last week: {up_votes} supported · {down_votes} opposed
  {/if}


CivicPulse · Jersey City ·
   Unsubscribe

```

---

## Vote Handler (Vercel Serverless Function or Supabase Edge Function)

Deploy this to handle thumbs up/down clicks from emails:

```javascript
// /api/vote.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  const { user, item, vote } = req.query;

  if (!user || !item || !['up', 'down'].includes(vote)) {
    return res.status(400).send('Invalid parameters');
  }

  await supabase.from('votes').upsert({
    user_id: user,
    ordinance_id: item,
    vote,
    voted_at: new Date().toISOString()
  }, { onConflict: 'user_id,ordinance_id' });

  // Redirect to a simple confirmation page
  res.redirect(302, '/thanks');
}
```

---

## Project File Structure to Create

```
civicpulse/
├── CLAUDE.md                    ← this file
├── .env.example                 ← environment variable template
├── README.md                    ← user-facing setup instructions
├── supabase/
│   └── schema.sql               ← full database schema (from above)
├── n8n/
│   ├── workflow-weekly-digest.json     ← exported n8n workflow
│   └── workflow-daily-exec-orders.json ← exported n8n workflow
├── scripts/
│   ├── fetch-civicweb.js        ← Playwright fetch helper
│   ├── state-tracker.js         ← ordinance upsert logic
│   ├── claude-analyzer.js       ← Claude API call + prompt
│   └── send-digest.js           ← Resend email builder + sender
├── api/
│   └── vote.js                  ← vote handler (Vercel serverless)
├── seed/
│   └── profiles.sql             ← INSERT statements for initial test subscribers
└── test/
    ├── test-fetch.js            ← verify CivicWeb fetch works
    ├── test-state-tracker.js    ← verify upsert + state change logic
    ├── test-claude-prompt.js    ← verify Claude returns valid JSON
    └── test-email.js            ← send test digest to one address
```

---

## Environment Variables

Create `.env` with these values (never commit this file):

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key
ANTHROPIC_API_KEY=your-anthropic-api-key
RESEND_API_KEY=your-resend-api-key
VOTE_BASE_URL=https://your-app.vercel.app
```

---

## Build Instructions for Claude Code

Work through these phases in order. Complete all tests in each phase before moving to the next. Do not skip phases.

### Phase 0 — Validate the data source

1. Create `scripts/fetch-civicweb.js` using Playwright to fetch and parse `cityofjerseycity.civicweb.net/Portal/MeetingInformation.aspx`
2. Extract: ordinance numbers, titles, document types, meeting dates from the HTML
3. Print the parsed output to console
4. Create `test/test-fetch.js` — run it and confirm at least 3 items are returned with valid structure
5. **Gate:** Do not proceed until test-fetch passes with real data

### Phase 1 — Database + state tracker

1. Apply `supabase/schema.sql` (provide instructions for user to run in Supabase dashboard)
2. Create `scripts/state-tracker.js` implementing the upsert logic above
3. Create `test/test-state-tracker.js`:
   - Insert a new ordinance → verify action = 'inserted'
   - Insert same ordinance with different state → verify action = 'state_changed'
   - Insert same ordinance with same state → verify action = 'no_change'
4. **Gate:** All 3 state tracker assertions must pass before proceeding

### Phase 2 — Claude analysis

1. Create `scripts/claude-analyzer.js` using the Anthropic SDK
2. Use model `claude-opus-4-20250514`
3. Test with hardcoded sample ordinance text + two different profiles (renter vs homeowner)
4. Create `test/test-claude-prompt.js` — verify response is valid parseable JSON matching the required schema
5. Verify the two profiles produce meaningfully different `personal_impact` fields
6. **Gate:** Both profiles must return valid JSON with different personal_impact content

### Phase 3 — Email builder

1. Create `scripts/send-digest.js` using the Resend SDK
2. Build HTML email from template above
3. Create `test/test-email.js` — send a test digest to a hardcoded test email address with 2 sample items
4. **Gate:** Email must arrive in inbox (not spam) with correct formatting and working vote links

### Phase 4 — n8n workflow export

1. Install n8n locally: `npx n8n`
2. Build Workflow 1 (weekly digest) in the n8n UI using the workflow spec above
3. Build Workflow 2 (daily exec orders)
4. Export both as JSON to `n8n/` directory
5. Test Workflow 1 manually by triggering it once
6. **Gate:** Workflow 1 must complete without errors and produce at least one email

### Phase 5 — Vote handler

1. Create `api/vote.js` using Supabase client
2. Deploy to Vercel: `vercel deploy`
3. Test by hitting the URL with sample query params
4. Verify vote appears in Supabase votes table
5. **Gate:** Vote must persist in database and redirect to /thanks

### Phase 6 — Seed data + end-to-end test

1. Create `seed/profiles.sql` with two test subscribers:
   - Profile A: Ward C, Renter, No car, No kids, interests: ['rent control', 'transit', 'noise']
   - Profile B: Ward A, Homeowner, Car owner, has_kids: true, interests: ['schools', 'property tax', 'parking']
2. Insert both profiles into Supabase
3. Run the full workflow end-to-end
4. Verify both subscribers receive different emails for the same agenda
5. **Gate:** The two emails must have different subject lines and different personal_impact text

---

## Success Criteria

The build is complete when:
- [ ] `npx n8n` starts locally and both workflows are loaded
- [ ] All 4 test files pass without errors
- [ ] Two test subscribers receive meaningfully different digest emails
- [ ] Vote links in emails correctly record to Supabase
- [ ] Executive order daily check runs without errors (even if no new orders exist)

---

## Notes for Claude Code

- Prefer `async/await` over callbacks throughout
- Use the Supabase JavaScript client (`@supabase/supabase-js`) not raw SQL queries from Node
- Use the Anthropic SDK (`@anthropic-ai/sdk`) not raw fetch for Claude API calls
- Use the Resend SDK (`resend`) not raw fetch for email sending
- All secrets must come from `.env` via `dotenv` — never hardcode credentials
- If a fetch from CivicWeb fails, log the error and skip gracefully — do not crash the workflow
- The state tracker must be idempotent — running it twice on the same data must produce the same result
- When in doubt about ordinance state, default to INTRODUCED rather than guessing
- Create `README.md` last, after everything works, documenting the actual setup steps discovered during build
