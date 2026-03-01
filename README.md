# MyBloc

A personalized civic digest system for Jersey City, NJ residents. Monitors local government documents, analyzes them against each subscriber's profile, and sends weekly personalized email digests.

## Architecture

```
CivicWeb (Playwright) → PDF Extract → State Tracker → Claude Analysis → Personalized Email
                                            ↓
                                       Supabase DB
                                     (ordinances + profiles + votes)
```

- **Orchestration:** `node scripts/run-digest.js` (single script)
- **Database:** Supabase (Postgres + RLS)
- **AI Analysis:** Claude API (`claude-sonnet-4-6` via `@anthropic-ai/sdk`)
- **Email:** Resend SDK
- **Scraping:** Playwright (headless Chromium)
- **PDF Parsing:** `pdf-parse` v2
- **Deployment:** `mybloc.co` on Vercel

## Setup

### 1. Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project
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

### 5. Run

```bash
# Full digest pipeline
node scripts/run-digest.js

# Test individual components
node test/test-fetch.js
node test/test-state-tracker.js
node test/test-claude-prompt.js
node test/test-email.js

# Deploy
vercel deploy --prod --yes
```

## How It Works

1. **Fetch**: Playwright scrapes the CivicWeb portal for recent meeting agendas, extracting ordinance/resolution PDFs
2. **Track**: The state tracker upserts each document into Supabase, detecting new items and state changes (INTRODUCED → VOTED → PASSED etc.)
3. **Analyze**: Each item is analyzed by Claude against each subscriber's profile (ward, housing type, income, interests) to generate personalized impact summaries and relevance scores
4. **Send**: Subscribers receive email digests containing only items scoring 5+ relevance, sorted by votes and personal impact, with Support/Oppose buttons
5. **Vote**: Vote buttons record reactions in Supabase and offer email templates to contact your council rep
