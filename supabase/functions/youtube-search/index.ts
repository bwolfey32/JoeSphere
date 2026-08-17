// YouTube search proxy for the "+ Post → Clip" composer.
//
// Why this exists at all: a YouTube Data API key must never reach the
// browser. index.html is a public static file — anything embedded in it is
// visible to anyone who views source, the same reason the Supabase anon key
// in this file is meant to be public (RLS enforces access, not secrecy) while
// a YouTube key is NOT meant to be public (it draws down someone's quota and
// can be reused by anyone who lifts it). So the key lives only here, as a
// Supabase secret, and the browser talks to this function instead of to
// Google directly.
//
// Deploy (from the repo root, with the Supabase CLI):
//   supabase functions deploy youtube-search
//   supabase secrets set YOUTUBE_API_KEY=your-key-here
// The key needs the YouTube Data API v3 enabled and — in Google Cloud
// Console — restricted to that API only. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected automatically; nothing else to set.
// Also run the SQL in ../../youtube_search.sql once, in the SQL editor, to
// create the cache/rate-limit tables this function reads and writes.
//
// Everything here is deliberately conservative: cache before quota, quota
// before search, and every failure mode returns a 200 with an {ok:false}
// body rather than a thrown error, because the composer needs to tell "no
// results" apart from "search is broken" apart from "quota's gone for today".

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const YT_KEY = Deno.env.get('YOUTUBE_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// search.list costs 100 units, videos.list costs 1, against a default
// 10,000-unit/day project quota — the "100 searches a day" the product ask
// refers to. Capped below the true ceiling so a handful of id-lookups (also
// billed here, at 1 unit) and any other quota use on the project still fit,
// and so a raised quota later just means editing one number.
const DAILY_UNIT_BUDGET = 9000;
const SEARCH_COST = 100;
const LOOKUP_COST = 1;

// One visitor should not be able to spend the shared daily budget alone. This
// is per anonymous-session id (every visitor already has one — see
// initAuth() in index.html), not per IP: a household or office behind one IP
// would otherwise share a single, much-too-small budget.
const PER_USER_DAILY_SEARCHES = 15;
const PER_USER_DAILY_LOOKUPS = 60;

const CACHE_TTL_MS = 20 * 60 * 1000; // within the requested 15-30 minute window

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
// Every failure path returns this shape at HTTP 200 — see the file header for
// why: the composer needs to distinguish reasons, and a thrown/non-200
// response collapses them all into one generic client-side error.
function fail(error: string, message: string, status = 200) {
  return json({ ok: false, error, message }, status);
}

const todayUTC = () => new Date().toISOString().slice(0, 10);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail('bad_request', 'POST only.', 405);
  if (!YT_KEY) return fail('unconfigured', 'YOUTUBE_API_KEY is not set for this function.');

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return fail('unauthorized', 'Missing session.', 401);

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  // Identifies *who* is asking, for the per-visitor cap below. The gateway
  // (verify_jwt, on by default) has already rejected anything that isn't a
  // validly signed Supabase token before this code runs at all — this call
  // just recovers the user id from a token we already know is genuine.
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData?.user) return fail('unauthorized', 'Session not recognized.', 401);
  const userId = userData.user.id;

  let body: { q?: string; id?: string };
  try { body = await req.json(); } catch { return fail('bad_request', 'Invalid request body.'); }

  const rawId = (body.id || '').trim();
  const rawQ = (body.q || '').trim().slice(0, 100);
  const isLookup = !!rawId;

  if (isLookup && !YT_ID.test(rawId)) return fail('bad_request', 'Not a YouTube video id.');
  if (!isLookup && rawQ.length < 2) return fail('bad_request', 'Search needs at least 2 characters.');

  const cacheKey = isLookup ? 'id:' + rawId : 'q:' + rawQ.toLowerCase();

  // Cache first — a hit costs no quota and skips every check below.
  const { data: cached } = await db.from('yt_cache').select('payload,fetched_at')
    .eq('cache_key', cacheKey).maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_TTL_MS) {
    return json({ ok: true, results: cached.payload, cached: true });
  }

  const day = todayUTC();
  const cost = isLookup ? LOOKUP_COST : SEARCH_COST;

  // Global budget: refuse before spending, not after — a call that fails
  // partway through still gets billed by Google.
  const { data: quotaRow } = await db.from('yt_quota').select('units').eq('day', day).maybeSingle();
  const usedToday = quotaRow?.units || 0;
  if (usedToday + cost > DAILY_UNIT_BUDGET) {
    return fail('quota', 'Search is temporarily unavailable — today’s allowance is used up. Try again tomorrow, or paste a link directly.');
  }

  // Per-visitor cap, tracked separately for search vs. lookup since they cost
  // very different amounts and a URL paste shouldn't compete with the same
  // small budget as a search.
  const rateCol = isLookup ? 'lookups' : 'searches';
  const rateCap = isLookup ? PER_USER_DAILY_LOOKUPS : PER_USER_DAILY_SEARCHES;
  const { data: rateRow } = await db.from('yt_rate').select('searches,lookups')
    .eq('day', day).eq('user_id', userId).maybeSingle();
  const usedByUser = (rateRow?.[rateCol] as number) || 0;
  if (usedByUser >= rateCap) {
    return fail('ratelimit', 'You’ve hit today’s personal search limit. Paste a YouTube link directly instead.');
  }

  let results;
  try {
    results = isLookup ? await lookupVideo(rawId) : await searchVideos(rawQ);
  } catch (err) {
    console.error('YouTube API call failed', err);
    return fail('upstream', 'Could not reach YouTube right now. Try again in a moment.');
  }

  // Best-effort bookkeeping: a write failure here must not turn a successful
  // search into an error response — the visitor already has their results.
  // Read-then-upsert, not an atomic increment, so two requests from the same
  // visitor landing in the same instant could both read the same prior count
  // and each add one — the limit could be exceeded by a request or two. Fine
  // for what this protects (a shared, refillable daily budget on a low-
  // traffic site), not something to build a Postgres RPC around.
  try {
    await db.from('yt_quota').upsert(
      { day, units: usedToday + cost }, { onConflict: 'day' });
    await db.from('yt_rate').upsert(
      { day, user_id: userId, searches: (rateRow?.searches || 0) + (isLookup ? 0 : 1),
        lookups: (rateRow?.lookups || 0) + (isLookup ? 1 : 0) },
      { onConflict: 'day,user_id' });
    await db.from('yt_cache').upsert(
      { cache_key: cacheKey, payload: results, fetched_at: new Date().toISOString() },
      { onConflict: 'cache_key' });
  } catch (err) {
    console.error('Cache/rate bookkeeping failed (non-fatal)', err);
  }

  return json({ ok: true, results, cached: false });
});

// Normalized shape both callers return. Thumbnails are deliberately not
// taken from the API response — the client already knows how to build
// https://i.ytimg.com/vi/<id>/mqdefault.jpg from the id alone (see index.html
// row/card rendering), so there is one fewer URL anyone has to trust.
type Clip = { id: string; title: string; channel: string; publishedAt: string };

async function searchVideos(q: string): Promise<Clip[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({
    key: YT_KEY!, part: 'snippet', type: 'video', maxResults: '6',
    videoEmbeddable: 'true', safeSearch: 'moderate', order: 'relevance',
    // Scoped to the show, not just prefixed with his name — a bare "q" like
    // "mma" would otherwise return the entire platform's back catalog on the
    // topic rather than anything of his.
    q: 'Joe Rogan ' + q,
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error('search.list ' + res.status);
  const data = await res.json();
  return (data.items || [])
    // Google's own id scheme is always this shape, but the client is about to
    // build an iframe src from it — validate against the same strict charset
    // the rest of the app uses (parseVideo/parseVideo0) rather than trusting
    // it just because it came from our own function.
    .filter((it: any) => YT_ID.test(it?.id?.videoId || ''))
    .map((it: any) => ({
      id: it.id.videoId,
      title: String(it.snippet?.title || '').slice(0, 200),
      channel: String(it.snippet?.channelTitle || '').slice(0, 100),
      publishedAt: String(it.snippet?.publishedAt || '').slice(0, 10),
    }));
}

async function lookupVideo(id: string): Promise<Clip[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search = new URLSearchParams({
    key: YT_KEY!, part: 'snippet,status', id,
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error('videos.list ' + res.status);
  const data = await res.json();
  const it = (data.items || [])[0];
  if (!it) return [];
  // A pasted link to a private, deleted, or embed-disabled video is exactly
  // the case this check exists for — better to say so than hand back a
  // preview that will just fail in the iframe a moment later.
  if (it.status?.privacyStatus !== 'public' || it.status?.embeddable === false) return [];
  return [{
    id,
    title: String(it.snippet?.title || '').slice(0, 200),
    channel: String(it.snippet?.channelTitle || '').slice(0, 100),
    publishedAt: String(it.snippet?.publishedAt || '').slice(0, 10),
  }];
}
