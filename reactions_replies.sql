-- reactions_replies.sql
--
-- Run ONCE, by hand, in the Supabase SQL editor, BEFORE serving the index.html
-- that ships emoji reactions and comment replies. Like youtube_search.sql this
-- is deliberately not part of CI: it rewrites live rows, and the choice it
-- bakes in (value -> emoji) cannot be undone.
--
-- Reading order:
--   0. clip metadata columns  (a Known gap in AGENTS.md - may already exist)
--   1. reactions.emoji        (allowlist, plus the data migration off `value`)
--   2. reactions.comment_id   (comments become a third reaction target)
--   3. comments.parent_id     (one-level replies)
--
-- ---------------------------------------------------------------------------
-- STEP 1 OF 2 - INTROSPECT FIRST. Run this on its own and read the output.
--
-- The `value in (1,-1)` CHECK was declared inline in the original schema, so
-- its name is Postgres-generated. Confirm it is `reactions_value_check` before
-- running the migration below, which drops it by that name. If it is named
-- something else, edit the DROP to match - a silently-missed drop leaves the
-- constraint in place, and every emoji-only INSERT then fails.
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conrelid = 'reactions'::regclass;
--
-- Expect: reactions_pkey, reactions_value_check, reactions_one_target,
--         reactions_post_id_fkey, reactions_user_id_fkey.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- STEP 2 OF 2 - the migration. One transaction: it all lands or none of it does.
-- ---------------------------------------------------------------------------
begin;

-- 0. Clip metadata -----------------------------------------------------------
-- AGENTS.md lists these as never confirmed run. The publish handler in
-- index.html ALWAYS sends all three keys (null for text posts and for tt/vm
-- clips), so if they are missing then every publish fails with a PostgREST
-- "column does not exist". Idempotent, so it is safe if they already exist.
alter table posts add column if not exists video_title     text;
alter table posts add column if not exists video_channel   text;
alter table posts add column if not exists video_published text;


-- 1. Emoji reactions ---------------------------------------------------------
alter table reactions add column if not exists emoji text;

-- The backfill is provably total: `value` was NOT NULL and CHECKed to (1,-1),
-- so every pre-existing row maps to exactly one emoji. That is what makes the
-- SET NOT NULL below safe to run in the same transaction.
--
-- The downvote lands on the cross rather than a thumbs-down because that is
-- what this project's reaction set uses. It is a pickable reaction, not only a
-- migration target - migrating to an emoji the picker cannot produce would
-- leave reactions on live rows that nobody can add or remove.
update reactions set emoji = '👍' where emoji is null and value =  1;
update reactions set emoji = '❌' where emoji is null and value = -1;

-- Allowlist, as defense in depth rather than as UI validation. Anyone can
-- INSERT straight through the REST API with the (intentionally public) anon
-- key, bypassing this page's JS entirely - the same trust category as posts in
-- invariant #1. An unconstrained text column would let one such row put 500
-- characters into every reaction bar that renders it. The client re-validates
-- on read too; this is the other half of that pair.
alter table reactions drop constraint if exists reactions_emoji_allowed;
alter table reactions add constraint reactions_emoji_allowed
  check (emoji in ('👍','❌','😂','🤯','🔥','🤔'));
alter table reactions alter column emoji set not null;

-- `value` stops being the source of truth but is kept, not dropped, and stays
-- populated on old rows. That is the rollback path: reverting index.html alone
-- restores the old up/down behaviour with no down-migration, because the client
-- falls back to `value` for any row whose `emoji` it does not recognise.
alter table reactions drop constraint if exists reactions_value_check;
alter table reactions alter column value drop not null;


-- 2. Comments as a third reaction target -------------------------------------
alter table reactions add column if not exists comment_id uuid
  references comments(id) on delete cascade;

-- Was a two-way exclusive check; now three-way. Written as a sum rather than as
-- nested ORs so that adding a fourth target later is a one-line change.
alter table reactions drop constraint if exists reactions_one_target;
alter table reactions add constraint reactions_one_target check (
  (post_id    is not null)::int +
  (event_id   is not null)::int +
  (comment_id is not null)::int = 1
);

-- Partial, for the same reason the other two are partial: post_id/event_id/
-- comment_id are all nullable and Postgres treats NULLs as distinct, so a plain
-- UNIQUE(comment_id,user_id) would not stop one user reacting twice.
create unique index if not exists reactions_comment_user_uniq
  on reactions(comment_id, user_id) where comment_id is not null;


-- 3. One-level replies -------------------------------------------------------
alter table comments add column if not exists parent_id uuid
  references comments(id) on delete cascade;

-- Nothing here enforces DEPTH - a direct REST insert can still point parent_id
-- at a row that itself has a parent. Expressing "one level" declaratively needs
-- a trigger, and a trigger that rejects is worse than a client that flattens:
-- the row would be written and then invisible. The client walks each comment to
-- its root ancestor on read instead, so an over-deep reply renders as a
-- first-level reply rather than vanishing. Same reasoning for target agreement
-- (a reply's post_id/event_id should match its parent's): the client copies the
-- parent's target on insert.
alter table comments drop constraint if exists comments_parent_not_self;
alter table comments add constraint comments_parent_not_self
  check (parent_id is null or parent_id <> id);

create index if not exists comments_parent_idx on comments(parent_id);

commit;

-- PostgREST caches the schema; without this the new columns 404 until it
-- happens to reload on its own.
notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- RLS: nothing to add.
--
-- The three reactions policies key on user_id and the three comments policies
-- key on author_id. Neither cares which target column is set, and a reply is
-- just a comment - so "public read", "auth insert (auth.uid() = owner)" and
-- "own delete" all continue to cover the new shapes unchanged.
--
-- There is still no UPDATE policy on either table and none is needed: changing
-- a reaction stays delete-then-insert, which the partial unique indexes above
-- make safe, and comments remain immutable once posted.
--
-- One consequence worth knowing before you run this: "on delete cascade" on
-- both new FKs means deleting a parent comment now silently deletes its replies
-- and, through reactions.comment_id, their reactions. The client labels the
-- control accordingly - "remove (and 3 replies)".
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- VERIFY after running:
--
--   select emoji, count(*) from reactions group by 1 order by 2 desc;
--     -> only the six allowed emoji, and no null bucket
--
--   select count(*) from reactions where emoji is null;               -- 0
--
--   select conname from pg_constraint
--    where conrelid='reactions'::regclass and conname like '%value%'; -- no rows
--
--   select column_name from information_schema.columns
--    where table_name='posts' and column_name like 'video_%';
--     -> video_kind, video_id, video_title, video_channel, video_published
--
--   select column_name from information_schema.columns
--    where table_name='comments' and column_name='parent_id';         -- 1 row
-- ---------------------------------------------------------------------------
