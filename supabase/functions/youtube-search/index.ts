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
//
// Three modes, by request body:
//   {q}              a typed search        — 101 units, capped per visitor
//   {id}             a pasted link lookup  —   1 unit,  capped per visitor
//   {recommend:true} the composer's shelf  — 201 units, shared by everyone
// The third never returns {ok:false}: a shelf nobody asked for must not be
// able to produce an error message, so every failure answers with an empty
// result list and a `reason`, and index.html shows JRE episodes instead.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const YT_KEY = Deno.env.get('YOUTUBE_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// search.list costs 100 units, videos.list costs 1, against a default
// 10,000-unit/day project quota — the "100 searches a day" the product ask
// refers to. Capped below the true ceiling so a handful of id-lookups (also
// billed here, at 1 unit) and any other quota use on the project still fit,
// and so a raised quota later just means editing one number.
//
// A search now also makes a second, batched videos.list call for duration
// (contentDetails isn't available on search.list at all) — one more LOOKUP_COST
// unit regardless of how many of the <=6 results are in the batch, so a
// search's true cost is SEARCH_COST + LOOKUP_COST. lookupVideo's own cost is
// unchanged: duration rides along on the part= list it already requests.
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

// ── The recommendation shelf ────────────────────────────────────────────────
// {recommend:true} answers with videos on the same theme as what the community
// has already clipped, minus anything already clipped. YouTube removed
// search.list's relatedToVideoId parameter on 2023-08-07, so there is no
// related-videos endpoint to call — a "recommendation" here is a search whose
// query this function derives from the posts table itself.
//
// That derivation is server-side for a reason that is not cosmetic: it makes
// the cache key a function of stored rows rather than of the request body, so
// a caller cannot vary it, cannot force a miss, and cannot make this spend
// quota on demand. That is what licenses skipping the per-visitor yt_rate cap
// for this mode (see the note at the rate check). Moving theme derivation to
// the client would reopen exactly the drain PER_USER_DAILY_SEARCHES closes.
//
// One refresh costs REC_QUERIES * SEARCH_COST + LOOKUP_COST = 201 units, and
// at a 12-hour TTL the shelf can cost at most ~402 units/day for the whole
// site — under 5% of the budget — because every visitor shares one cache entry.
const REC_RULES_V = 'v1';                // bump when theme/query building changes
const REC_TTL_MS = 12 * 60 * 60 * 1000;
const REC_QUERIES = 2;
const REC_POST_SAMPLE = 60;              // most recent clip posts to read themes from
const REC_MIN_POSTS = 4;                 // below this there is no theme yet
const REC_SEARCH_MAX = 10;               // headroom so exclusions don't empty the shelf
const REC_RESULTS = 8;
// The shelf yields to real searches. A visitor who typed a query and pressed
// Enter wants the units more than a shelf nobody asked for does, so
// recommendations stop at 60% of the budget while searches keep the full one.
const REC_BUDGET_CEILING = Math.floor(DAILY_UNIT_BUDGET * 0.6);

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

  let body: { q?: string; id?: string; recommend?: boolean };
  try { body = await req.json(); } catch { return fail('bad_request', 'Invalid request body.'); }

  const rawId = (body.id || '').trim();
  const rawQ = (body.q || '').trim().slice(0, 100);
  const isLookup = !!rawId;
  // An id still wins over everything else: tryYtLookup() sends {id} alone, and
  // a body carrying both is a caller bug rather than a request for both.
  const isRecommend = !isLookup && body.recommend === true;

  if (isLookup && !YT_ID.test(rawId)) return fail('bad_request', 'Not a YouTube video id.');
  if (!isLookup && !isRecommend && rawQ.length < 2) return fail('bad_request', 'Search needs at least 2 characters.');

  // Derived before the cache key, because for this mode it *is* the cache key.
  // Note this read is the only thing that decides what the shelf costs — the
  // request body contributes nothing beyond the boolean that got us here.
  let recQueries: string[] = [];
  const recClipped = new Set<string>();
  if (isRecommend) {
    const { data: postRows } = await db.from('posts')
      .select('video_id,video_title,video_channel,caption')
      .not('video_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(REC_POST_SAMPLE);
    const rows = postRows || [];
    for (const r of rows) if (r.video_id) recClipped.add(String(r.video_id));
    // Too little posted to have a theme yet. Say so cheaply and truthfully
    // rather than inventing one: index.html falls back to recent JRE episodes,
    // which cost nothing and are already on the page. Note this returns
    // *before* any quota accounting — a cold start must never spend.
    if (rows.length < REC_MIN_POSTS) {
      return json({ ok: true, results: [], cached: false, source: 'recommend', reason: 'cold' });
    }
    recQueries = deriveThemes(rows);
    if (!recQueries.length) {
      return json({ ok: true, results: [], cached: false, source: 'recommend', reason: 'cold' });
    }
  }

  // The version token namespaces every search entry to the query-building rules
  // that produced it. Dropping the 'Joe Rogan ' prefix changed what a given q
  // means, so without this the 20-minute cache would keep answering with
  // Rogan-scoped results for a while after the redeploy — briefly, but
  // confusingly, and exactly while somebody is checking whether the change
  // worked. Bump it whenever the query sent to Google changes shape. Lookups
  // are keyed by video id, which no rule change can alter, so they skip it.
  const SEARCH_RULES_V = 'v2';
  // The recommendation key is the derived queries themselves — readable in the
  // table, and a change of theme is a change of key, which is what makes the
  // shelf follow the site's content without any invalidation logic.
  const cacheKey = isRecommend
    ? ('rec:' + REC_RULES_V + ':' + recQueries.join('|')).slice(0, 300)
    : isLookup ? 'id:' + rawId : 'q:' + SEARCH_RULES_V + ':' + rawQ.toLowerCase();

  // Cache first — a hit costs no quota and skips every check below. The shelf
  // is cached far longer than a search: it answers a question nobody asked
  // ("what might I clip?"), so a stale-by-hours answer is fine, whereas a
  // typed query is a question about right now.
  const ttl = isRecommend ? REC_TTL_MS : CACHE_TTL_MS;
  const { data: cached } = await db.from('yt_cache').select('payload,fetched_at')
    .eq('cache_key', cacheKey).maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < ttl) {
    return json({ ok: true, results: cached.payload, cached: true });
  }

  const day = todayUTC();
  const cost = isRecommend ? SEARCH_COST * recQueries.length + LOOKUP_COST
    : isLookup ? LOOKUP_COST : SEARCH_COST + LOOKUP_COST;

  // Global budget: refuse before spending, not after — a call that fails
  // partway through still gets billed by Google.
  const { data: quotaRow } = await db.from('yt_quota').select('units').eq('day', day).maybeSingle();
  const usedToday = quotaRow?.units || 0;
  if (usedToday + cost > (isRecommend ? REC_BUDGET_CEILING : DAILY_UNIT_BUDGET)) {
    // Running out of shelf is not an error the visitor should ever read about
    // — they did not ask for it. index.html quietly shows episodes instead.
    if (isRecommend) {
      return json({ ok: true, results: [], cached: false, source: 'recommend', reason: 'budget' });
    }
    return fail('quota', 'Search is temporarily unavailable — today’s allowance is used up. Try again tomorrow, or paste a link directly.');
  }

  // Per-visitor cap, tracked separately for search vs. lookup since they cost
  // very different amounts and a URL paste shouldn't compete with the same
  // small budget as a search.
  //
  // Recommendations are exempt, and that exemption rests entirely on the
  // derivation above being server-side: the caller cannot influence what a
  // shelf costs or when it refreshes, so there is nothing here for a
  // per-visitor cap to protect against. Charging one would only mean a shelf
  // nobody asked for eating the 15 searches they need to actually search.
  const rateCol = isLookup ? 'lookups' : 'searches';
  const rateCap = isLookup ? PER_USER_DAILY_LOOKUPS : PER_USER_DAILY_SEARCHES;
  const { data: rateRow } = await db.from('yt_rate').select('searches,lookups')
    .eq('day', day).eq('user_id', userId).maybeSingle();
  const usedByUser = (rateRow?.[rateCol] as number) || 0;
  if (!isRecommend && usedByUser >= rateCap) {
    return fail('ratelimit', 'You’ve hit today’s personal search limit. Paste a YouTube link directly instead.');
  }

  let results;
  try {
    results = isRecommend ? await recommendClips(recQueries, recClipped)
      : isLookup ? await lookupVideo(rawId) : await searchVideos(rawQ);
  } catch (err) {
    console.error('YouTube API call failed', err);
    if (isRecommend) {
      return json({ ok: true, results: [], cached: false, source: 'recommend', reason: 'upstream' });
    }
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
    // Nothing to write for a recommendation: it is charged to the shared
    // budget above and to no visitor in particular.
    if (!isRecommend) {
      await db.from('yt_rate').upsert(
        { day, user_id: userId, searches: (rateRow?.searches || 0) + (isLookup ? 0 : 1),
          lookups: (rateRow?.lookups || 0) + (isLookup ? 1 : 0) },
        { onConflict: 'day,user_id' });
    }
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
// row/card rendering), so there is one fewer URL anyone has to trust. duration
// is plain descriptive text like title/channel — never used to build a URL,
// and null whenever the follow-up contentDetails lookup didn't have it.
type Clip = { id: string; title: string; channel: string; publishedAt: string; duration: string | null };

// The search.list call on its own, without the duration batch. Split out so
// the recommendation shelf can run several queries and pay for durations once
// at the end rather than once per query; searchVideos() below keeps its
// previous behaviour by calling this and then fetching durations itself.
async function searchRaw(q: string, max: number): Promise<Omit<Clip, 'duration'>[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({
    key: YT_KEY!, part: 'snippet', type: 'video', maxResults: String(max),
    videoEmbeddable: 'true', safeSearch: 'moderate', order: 'relevance',
    // The query goes through as typed. This used to be prefixed with 'Joe
    // Rogan ' to scope every search to the show, which made sense while the
    // site only tracked him — but the clipping tool is for comedy generally,
    // and a prefix that silently rewrites "Bill Burr crowd work" into
    // something else is worse than no search at all. safeSearch and
    // videoEmbeddable still apply; relevance is now YouTube's problem.
    q,
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

async function searchVideos(q: string): Promise<Clip[]> {
  const items = await searchRaw(q, 6);
  if (!items.length) return [];
  const durations = await fetchDurations(items.map(c => c.id));
  return items.map(c => ({ ...c, duration: durations[c.id] || null }));
}

// Words that carry no theme. The first group is ordinary English; the second
// is this site's own subject matter, dropped for the same reason invariant #13
// dropped the 'Joe Rogan ' prefix from the search query. Nearly every post here
// is a JRE clip, so leaving these in makes every derived query collapse back to
// "joe rogan" and the shelf recommends the show it is already full of, instead
// of the guests and subjects that are the actual theme.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'had', 'was', 'were',
  'are', 'you', 'your', 'but', 'not', 'all', 'can', 'out', 'get', 'got', 'his', 'her', 'him',
  'she', 'they', 'them', 'their', 'what', 'when', 'who', 'why', 'how', 'about', 'just', 'like',
  'one', 'two', 'some', 'more', 'most', 'than', 'then', 'there', 'here', 'been', 'being',
  'into', 'over', 'only', 'also', 'because', 'would', 'could', 'should', 'its', 'our', 'ours',
  'say', 'says', 'said', 'see', 'saw', 'new', 'old', 'off', 'too', 'very', 'really', 'thing',
  'things', 'much', 'many', 'even', 'still', 'back', 'know', 'think', 'going', 'gets', 'guy',
  'guys', 'part', 'best', 'good', 'great', 'funny', 'time', 'when', 'watch', 'talks', 'talking',
  // this site's own subject matter
  'joe', 'rogan', 'jre', 'experience', 'episode', 'episodes', 'podcast', 'podcasts',
  'clip', 'clips', 'full', 'official', 'video', 'videos', 'youtube', 'shorts', 'powerfuljre',
]);

function themeTokens(s: unknown): string[] {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/)
    // Pure numbers are episode numbers and timestamps, never themes.
    .filter(w => w.length >= 3 && w.length <= 24 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
}

// Recent clip posts in, up to REC_QUERIES YouTube queries out. Deterministic:
// the same rows must always produce the same queries, or the cache key moves
// and the shelf pays for a refresh it did not need.
function deriveThemes(rows: any[]): string[] {
  const termCount = new Map<string, number>();
  const chanCount = new Map<string, number>();
  for (const r of rows) {
    for (const w of themeTokens(r.caption)) termCount.set(w, (termCount.get(w) || 0) + 1);
    for (const w of themeTokens(r.video_title)) termCount.set(w, (termCount.get(w) || 0) + 1);
    const ch = String(r.video_channel || '').trim().slice(0, 60);
    // The show's own channel is the one thing the shelf exists to look past.
    if (ch && !/^powerfuljre$/i.test(ch)) chanCount.set(ch, (chanCount.get(ch) || 0) + 1);
  }
  // Count descending, then alphabetically. The tie-break is not cosmetic: two
  // terms on the same count must not swap places between runs, or an identical
  // corpus yields a different cache key and buys the same shelf twice.
  const rank = (m: Map<string, number>) => [...m.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(e => e[0]);
  const out: string[] = [];
  // Channels first: who people clip is a stronger signal than any single word,
  // and a channel name is already a phrase a search can use as it stands.
  for (const c of rank(chanCount)) { if (out.length >= REC_QUERIES) break; out.push(c); }
  // Then pairs of top terms. A pair is usually specific enough to name a
  // subject ("crowd work", "bear attack") where a lone word rarely is.
  const terms = rank(termCount);
  for (let i = 0; i + 1 < terms.length && out.length < REC_QUERIES; i += 2) {
    out.push(terms[i] + ' ' + terms[i + 1]);
  }
  if (!out.length && terms.length) out.push(terms[0]);
  return out.slice(0, REC_QUERIES).map(q => q.slice(0, 100));
}

async function recommendClips(queries: string[], exclude: Set<string>): Promise<Clip[]> {
  const perQuery: Omit<Clip, 'duration'>[][] = [];
  let failures = 0;
  for (const q of queries) {
    try { perQuery.push(await searchRaw(q, REC_SEARCH_MAX)); }
    catch (err) { failures++; console.error('Recommendation query failed (continuing)', q, err); }
  }
  // A partial shelf beats an error. Nothing at all from any query is a genuine
  // upstream problem, and the caller turns it into an empty shelf, not a
  // message — see the isRecommend branch at the call site.
  if (failures === queries.length) throw new Error('all recommendation queries failed');

  // Round-robin rather than concatenate, so a second theme is still visible
  // when the first returns a full page of its own.
  const seen = new Set<string>();
  const merged: Omit<Clip, 'duration'>[] = [];
  const maxLen = Math.max(0, ...perQuery.map(l => l.length));
  for (let i = 0; i < maxLen && merged.length < REC_RESULTS; i++) {
    for (const list of perQuery) {
      if (merged.length >= REC_RESULTS) break;
      const it = list[i];
      // Already clipped is the one thing this shelf must never show: it is a
      // "find your next clip" surface, not a list of what has been found.
      if (!it || exclude.has(it.id) || seen.has(it.id)) continue;
      seen.add(it.id);
      merged.push(it);
    }
  }
  if (!merged.length) return [];
  const durations = await fetchDurations(merged.map(c => c.id));
  return merged.map(c => ({ ...c, duration: durations[c.id] || null }));
}

async function lookupVideo(id: string): Promise<Clip[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search = new URLSearchParams({
    key: YT_KEY!, part: 'snippet,status,contentDetails', id,
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
    duration: parseISODuration(it.contentDetails?.duration || ''),
  }];
}

// contentDetails only exists on videos.list, not search.list, so getting
// duration for search results needs this second, batched call — one request
// for all <=6 ids rather than one per result. Fails soft: a duration hiccup
// must not turn a working search into an error, so this never throws — a
// missing entry just means no badge that time.
async function fetchDurations(ids: string[]): Promise<Record<string, string>> {
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.search = new URLSearchParams({ key: YT_KEY!, part: 'contentDetails', id: ids.join(',') }).toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error('videos.list(durations) ' + res.status);
    const data = await res.json();
    const out: Record<string, string> = {};
    for (const it of data.items || []) {
      const d = parseISODuration(it?.contentDetails?.duration || '');
      if (d) out[it.id] = d;
    }
    return out;
  } catch (err) {
    console.error('Duration lookup failed (non-fatal)', err);
    return {};
  }
}

// YouTube's contentDetails.duration is ISO-8601: PT1H2M3S -> "1:02:03",
// PT4M13S -> "4:13", PT45S -> "0:45". A live/unfinished upload's duration
// comes back as something this regex won't match (no T component or all-zero)
// — that correctly returns null rather than a bogus "0:00".
function parseISODuration(iso: string): string | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const h = Number(m[1] || 0), mi = Number(m[2] || 0), s = Number(m[3] || 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + pad(mi) + ':' + pad(s) : mi + ':' + pad(s);
}
