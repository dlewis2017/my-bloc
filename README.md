# CivicPulse

A personalized civic digest system for Jersey City, NJ residents. Monitors local government documents, analyzes them against each subscriber's profile, and sends weekly personalized email digests.

## Architecture

```
CivicWeb Portal → Playwright Fetch → State Tracker → Claude Analysis → Personalized Email (Resend)
                                           ↓
                                      Supabase DB
                                (ordinances + profiles + votes)
```

**Orchestration:** n8n workflows (weekly digest + daily executive order check)
**Database:** Supabase (Postgres + auth + RLS)
**AI Analysis:** Claude API (claude-opus-4-20250514)
**Email:** Resend
**Scraping:** Playwright (headless Chromium)

## Setup

### 1. Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project (free tier works)
- An [Anthropic API key](https://console.anthropic.com)
- A [Resend API key](https://resend.com)

### 2. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your actual credentials
```

### 4. Create database tables

Run the SQL in `supabase/schema.sql` in your Supabase dashboard SQL editor.

### 5. Seed test data

Run the SQL in `seed/profiles.sql` in your Supabase dashboard to create two test subscriber profiles. Update the email addresses to your own test emails.

### 6. Run tests

```bash
# Test data fetching (no API keys needed)
node test/test-fetch.js

# Test state tracker (requires Supabase)
node test/test-state-tracker.js

# Test Claude analysis (requires Anthropic API key)
node test/test-claude-prompt.js

# Test email sending (requires Resend API key)
node test/test-email.js
```

### 7. n8n workflows

```bash
npx n8n
```

Import the workflow files from `n8n/`:
- `workflow-weekly-digest.json` — runs Thursday 8AM, fetches CivicWeb agenda, analyzes per subscriber, sends digest
- `workflow-daily-exec-orders.json` — runs daily 9AM, checks for new executive orders

Set these environment variables in n8n:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `ANTHROPIC_API_KEY`
- `RESEND_API_KEY`
- `VOTE_BASE_URL`

### 8. Deploy vote handler

The vote handler (`api/vote.js`) can be deployed to Vercel:

```bash
vercel deploy
```

Or run locally for testing.

## Project Structure

```
civicpulse/
├── CLAUDE.md                    — project spec
├── .env.example                 — environment variable template
├── supabase/
│   └── schema.sql               — database schema
├── n8n/
│   ├── workflow-weekly-digest.json
│   └── workflow-daily-exec-orders.json
├── scripts/
│   ├── fetch-civicweb.js        — Playwright scraper for CivicWeb portal
│   ├── state-tracker.js         — ordinance upsert with state machine
│   ├── claude-analyzer.js       — Claude API analysis with prompt template
│   └── send-digest.js           — Resend email builder
├── api/
│   └── vote.js                  — vote handler (Vercel serverless)
├── seed/
│   └── profiles.sql             — test subscriber profiles
└── test/
    ├── test-fetch.js            — verify CivicWeb fetch
    ├── test-state-tracker.js    — verify state tracker logic
    ├── test-claude-prompt.js    — verify Claude returns valid JSON
    └── test-email.js            — send test digest email
```

## How It Works

1. **Fetch**: Playwright scrapes the CivicWeb portal for recent meeting agendas, extracting ordinance/resolution numbers and links
2. **Track**: The state tracker upserts each document into Supabase, detecting new items and state changes (INTRODUCED → VOTED → PASSED etc.)
3. **Analyze**: Each notifiable item is analyzed by Claude against each subscriber's profile (ward, housing type, interests) to generate personalized impact summaries and relevance scores
4. **Send**: Subscribers receive email digests containing only items scoring 5+ relevance, sorted by personal impact, with vote buttons
5. **Vote**: Email vote links hit the serverless vote handler which records reactions in Supabase
