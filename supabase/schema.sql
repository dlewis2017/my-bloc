-- Tracks every government document with full state history
create table ordinances (
  id             text primary key,           -- stable hash: ordinance_num + slugified title
  ordinance_num  text,
  title          text not null,
  doc_type       text,                        -- ordinance | resolution | exec_order | zoning | budget | redevelopment
  full_text      text,
  source_url     text,
  meeting_date   date,
  meeting_url    text,                        -- link to the CivicWeb meeting page
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
  city        text default 'Jersey City',     -- city name; non-JC users are waitlisted (active=false)
  ward        text,                           -- A | B | C | D | E | F (Jersey City specific)
  housing     text,                           -- Renter | Homeowner | Section 8
  transport   text,                           -- No car | Car owner | Transit dependent
  has_kids    boolean default false,
  income      text,                           -- 'Under $50K' | '$50K–$100K' | '$100K–$200K' | 'Over $200K' | 'Prefer not to say'
  interests   text[],                         -- expanded tiered list
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

-- Cached top items per ward for instant welcome emails (no Claude call needed)
create table ward_highlights (
  ward        text primary key,              -- A | B | C | D | E | F
  items       jsonb not null default '[]',   -- top 3 analyzed items (same shape as buildItemHtml expects)
  week_date   text not null,                 -- e.g. "March 1, 2026"
  updated_at  timestamptz default now()
);

-- Row level security — profiles are private
alter table profiles enable row level security;
alter table votes enable row level security;
