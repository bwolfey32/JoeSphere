-- Backs the youtube-search Edge Function (supabase/functions/youtube-search).
-- Run this once in the Supabase SQL editor, as postgres, before deploying the
-- function — it upserts into these tables on every live YouTube API call.
--
-- All three are written only by the function itself, using the service-role
-- key, which bypasses RLS entirely. RLS is still enabled with no policies —
-- not because the service role needs it, but so that if it were ever queried
-- with the public anon key by mistake, the answer is "nothing", not "every
-- visitor's search history".

create table yt_cache (
  cache_key text primary key,       -- 'q:<lowercased search terms>' or 'id:<video id>'
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table yt_cache enable row level security;

-- One row per UTC day: the running total of YouTube API quota units spent.
-- search.list costs 100, videos.list costs 1. The function checks this
-- *before* calling Google and refuses once the budget would be exceeded,
-- rather than finding out after spending the units.
create table yt_quota (
  day date primary key,
  units integer not null default 0
);
alter table yt_quota enable row level security;

-- One row per UTC day per visitor (keyed to the anonymous Supabase session
-- id every visitor already has — see initAuth() in index.html — not to an
-- IP, so a shared IP doesn't mean a shared budget). Searches and lookups are
-- tracked separately since they cost very different amounts of the shared
-- daily budget above.
create table yt_rate (
  day date not null,
  user_id uuid not null,
  searches integer not null default 0,
  lookups integer not null default 0,
  primary key (day, user_id)
);
alter table yt_rate enable row level security;

-- Housekeeping: nothing above needs to be kept once its day has passed.
-- Re-run this occasionally (or wire it to a cron/Edge Function schedule) —
-- there's no automatic expiry otherwise.
--   delete from yt_cache where fetched_at < now() - interval '1 day';
--   delete from yt_quota where day < current_date - 7;
--   delete from yt_rate  where day < current_date - 7;
