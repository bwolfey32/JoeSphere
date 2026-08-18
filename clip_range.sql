-- clip_range.sql
--
-- Run ONCE, by hand, in the Supabase SQL editor. Same convention as
-- video_duration.sql / reactions_replies.sql / youtube_search.sql — not part
-- of CI. Idempotent, and safe to run before or after any of those.
--
-- Adds the clip range: a post can now point at a span of its source video
-- rather than the whole thing. clip_start/clip_end are whole seconds from the
-- start of the video; null/null means "the whole video", which is what every
-- post published before this ran has.
--
-- ── Why this CHECK is not decoration ────────────────────────────────────────
-- Every other clip column (video_title, video_channel, video_published,
-- video_duration) is descriptive text — it gets escaped and printed, and
-- nothing more. These two are different in kind: they are interpolated into
-- an embed URL as &start=/&end=. Anyone can INSERT a posts row straight
-- through Supabase's REST API with the (intentionally public) anon key,
-- bypassing index.html's JS entirely, so this constraint — not the client —
-- is the actual boundary. index.html re-validates on read anyway
-- (parseClipRange), for the same reason parseVideo0 re-validates video_id:
-- the constraint can be bypassed by a future migration that loosens it
-- without the client changing. See AGENTS.md invariant #15.
--
-- YouTube only, because start/end are YouTube embed parameters. TikTok's
-- player v1 and Vimeo's player have no equivalent, so a trimmed tt/vm post
-- would store a range that nothing could ever honour.
--
-- 86400 (24h) is a sanity ceiling, not a product limit — it exists so a
-- garbage value can't produce an absurd URL, not to cap clip length.
begin;

alter table posts add column if not exists clip_start integer;
alter table posts add column if not exists clip_end   integer;

-- Dropped first so re-running this file after editing the bounds actually
-- replaces the constraint instead of failing on the duplicate name.
alter table posts drop constraint if exists posts_clip_range;
alter table posts add constraint posts_clip_range check (
  (clip_start is null and clip_end is null)
  or (
    video_kind = 'yt'
    and clip_start >= 0
    and clip_end > clip_start
    and clip_end <= 86400
  )
);

commit;
notify pgrst, 'reload schema';

-- VERIFY:
--   select column_name, data_type from information_schema.columns
--    where table_name='posts' and column_name in ('clip_start','clip_end');
--   -- 2 rows, both integer
--
--   select conname from pg_constraint where conname='posts_clip_range';
--   -- 1 row
--
-- Expected to reject (run inside a transaction you roll back):
--   clip_end <= clip_start          -- backwards or empty range
--   clip_start set, clip_end null   -- half a range
--   a range on a video_kind='tt' or text post
