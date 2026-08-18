-- video_duration.sql
--
-- Run ONCE, by hand, in the Supabase SQL editor. Same convention as
-- reactions_replies.sql / youtube_search.sql — not part of CI. Idempotent,
-- and safe to run before or after either of those.
--
-- Feeds the clip-thumbnail duration badge in index.html and the composer's
-- search-result rows. Populated only for YouTube clips going forward, via
-- the youtube-search Edge Function's new contentDetails lookup; posts
-- published before this ran (or non-YouTube clips, or text posts) simply
-- have video_duration = null, which every render site already treats as
-- "no badge" rather than an error.
begin;
alter table posts add column if not exists video_duration text;
commit;
notify pgrst, 'reload schema';

-- VERIFY:
--   select column_name from information_schema.columns
--    where table_name='posts' and column_name='video_duration';  -- 1 row
