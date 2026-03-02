# MyBloc

A personalized civic digest system for Jersey City, NJ residents. It monitors local government documents (ordinances, resolutions), analyzes them with Claude AI against each subscriber's profile, and sends a weekly personalized email digest explaining what's happening and why it matters to *that specific person*.

Two subscribers receive completely different emails for the same agenda — a renter in Ward C gets a rent control angle, a homeowner in Ward A gets a property tax and schools angle.

## Architecture

```
CivicWeb (Playwright) → PDF Extract → State Tracker → Claude Analysis → Personalized Email
                                            ↓
                                       Supabase DB
                                     (ordinances + profiles + votes)
```

- **Orchestration:** `node scripts/run-digest.js` (single script, no n8n)
- **Database:** Supabase (Postgres + RLS)
- **AI Analysis:** Claude API (`claude-sonnet-4-6` via `@anthropic-ai/sdk`, 5 concurrent calls)
- **Email:** Resend SDK
- **Scraping:** Playwright (headless Chromium)
- **PDF Parsing:** `pdf-parse` v2 (class-based API)
- **Web/API:** Vercel (serverless functions + static hosting)
- **Deployment:** `mybloc.co`, GitHub repo `dlewis2017/civic-pulse-2`

## File Structure

```
civicpulse/
├── CLAUDE.md
├── package.json
├── .env                         ← secrets (never commit)
├── scripts/
│   ├── fetch-civicweb.js        ← Playwright scraper + PDF text extraction
│   ├── state-tracker.js         ← ordinance upsert + state machine + vote aggregation
│   ├── claude-analyzer.js       ← Claude API call with personalization prompt
│   ├── send-digest.js           ← Resend email builder + sender
│   └── run-digest.js            ← full pipeline orchestrator (fetch → track → analyze → email)
├── api/
│   ├── vote.js                  ← thumbs up/down handler (redirects to /thanks.html)
│   ├── signup.js                ← POST subscriber registration + welcome email
│   ├── welcome.js               ← POST manual welcome email re-send ({ userId })
│   ├── profile.js               ← GET/PUT subscriber profile
│   └── unsubscribe.js           ← sets active=false, redirects to /thanks.html
├── public/
│   ├── index.html               ← signup form
│   ├── manage.html              ← profile editor (linked from digest emails)
│   └── thanks.html              ← confirmation page for votes/unsubscribe
├── supabase/
│   └── schema.sql               ← database schema
├── seed/
│   └── profiles.sql             ← test subscriber inserts
└── test/
    ├── test-fetch.js
    ├── test-state-tracker.js
    ├── test-claude-prompt.js
    └── test-email.js
```

## Running

```bash
# Run full digest pipeline (fetch → state track → Claude analyze → send emails)
node scripts/run-digest.js

# Full pipeline test (sends only to test email, safe to re-run)
node test/test-full-pipeline.js --all              # all items, uses TEST_EMAIL from .env
node test/test-full-pipeline.js --all user@email   # all items, custom email
node test/test-full-pipeline.js                    # new items only (production-like)

# Test individual components
node scripts/fetch-civicweb.js   # scrape + extract PDFs, print results
node test/test-fetch.js          # verify fetch returns valid items
node test/test-fetch-folders.js  # verify multi-source scraper (folders + agenda PDF)
node test/test-state-tracker.js  # verify upsert state machine
node test/test-claude-prompt.js  # verify Claude returns valid JSON
node test/test-email.js          # send test digest email

# Deploy
vercel deploy --prod --yes
```

## Environment Variables

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_KEY=...
SUPABASE_DB_URL=...
ANTHROPIC_API_KEY=...
RESEND_API_KEY=...
VOTE_BASE_URL=https://mybloc.co
TEST_EMAIL=your-test-email@example.com
```

## CivicWeb Scraping Structure

CivicWeb has a 3-level navigation (not flat HTML):

1. **Meeting list page** (`/Portal/MeetingInformation.aspx`) — lists meetings with `a.list-link` elements
2. **Meeting page** (`/Portal/MeetingInformation.aspx?Id=...`) — has document folder links + Agenda Packet PDF
3. **Document folder** (`/filepro/documents/{id}`) — lists individual ordinance/resolution PDFs
4. **Agenda Packet PDF** (`/document/{id}`) — full agenda with embedded sections for communications, appointments, claims

Two data sources per meeting:
- **Document folder** → ordinances + resolutions (individual PDFs, full text extraction)
- **Agenda PDF** → community notices parsed from structured sections (6=Petitions & Communications, 8=Reports of Directors)

**IMPORTANT — Date/navigation validation:** CivicWeb's navigation can be confusing. Always verify you're scraping the correct meeting date/year. The meeting list page may show meetings across multiple years, and folder links must have a specific ID (`/filepro/documents/441866`), not the root `/filepro/documents` which is a site-wide "Document Center" link. Future cities may have similar navigation pitfalls.

PDF extraction flow:
- Preview URLs (e.g. `?preview=444662`) return an HTML viewer page, NOT raw PDFs
- Must find the "New Window" link containing `/filepro/document/{id}/{filename}.pdf`
- Download the direct PDF URL, parse with `pdf-parse` v2
- Text capped at 15,000 chars per document

### pdf-parse v2 API

```javascript
const { PDFParse, VerbosityLevel } = require('pdf-parse');
const parser = new PDFParse({ data: buffer, verbosity: VerbosityLevel.ERRORS });
await parser.load();
const result = await parser.getText();  // returns { pages, text, total }
await parser.destroy();
```

## Database Schema

Four tables: `ordinances`, `profiles`, `votes`, `ward_highlights`. See `supabase/schema.sql` for full DDL.

- Supabase RLS is enabled but no policies defined — API routes use service key to bypass
- `votes` table has FK constraints on both `user_id` (→ `profiles.id`) and `ordinance_id` (→ `ordinances.id`)
- `ward_highlights` caches top 3 analyzed items per ward for instant welcome emails (no Claude call at signup time)

## State Machine

Ordinances follow: INTRODUCED → AMENDED → COMMITTEE → VOTED → PASSED/FAILED/WITHDRAWN

The state tracker is idempotent — running twice on the same data produces the same result. Only notifies on new inserts or state changes.

## Known Pitfalls

- **Vote links must use real UUIDs** from `profiles.id`, not test strings — FK constraint on `votes.user_id`
- **Vote links must use real ordinance IDs** from `ordinances.id` — FK constraint on `votes.ordinance_id`
- **Vote handler redirects to `/thanks.html`** not `/thanks`
- **CivicWeb main page lists meetings**, not agenda items — must navigate into individual meetings
- **Vercel CLI** `vercel deploy` creates a new project by default — use `vercel link` first. Domain: `mybloc.co`
- **Email footer** includes both "Manage profile" and "Unsubscribe" links
- **pdf-parse v2** uses a class-based API (`new PDFParse({ data })` + `.load()` + `.getText()`) not a function call
- **Welcome email depends on `ward_highlights`** being seeded — if the table is empty (e.g. fresh deploy), welcome emails are silently skipped and signup still succeeds
- **Pipeline re-runs on already-notified items** won't reach the ward caching step — to re-seed `ward_highlights` manually, reset `notified_at` or write a one-off seed script
- **Supabase remote SQL** — use `psql "$SUPABASE_DB_URL"` for DDL; the Supabase CLI (`v2.75.0`, installed via `brew install supabase/tap/supabase`) does not have a `db execute` command

## Working Style

- Always briefly explain *why* before taking an action — especially for installing packages, running commands, or making non-obvious changes. The user wants to understand the reasoning as you go, not be surprised by actions after the fact.

## Coding Conventions

- `async/await` throughout, no callbacks
- Supabase JS client (`@supabase/supabase-js`) not raw SQL
- Anthropic SDK (`@anthropic-ai/sdk`) not raw fetch
- Resend SDK (`resend`) not raw fetch
- All secrets from `.env` via `dotenv`
- Graceful failure on CivicWeb fetch errors — log and skip, never crash
