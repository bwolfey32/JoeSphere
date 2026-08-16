#!/usr/bin/env node
// Scheduled-source fetcher for The Rogansphere.
//
// Writes events.json — announced, publicly scheduled events only. It never
// invents an event and never claims Rogan will attend: every entry ships as
// "unconfirmed", because no public source verifies his commentary booking in
// advance. Clearing that badge is a human decision (see AGENTS.md #7).
//
// Contract with CI: if EVERY source fails, exit non-zero WITHOUT writing, so
// the workflow keeps the last good events.json instead of blanking the site.
//
// No dependencies, no build step. Requires Node 18+ (global fetch).

import { writeFile, readFile } from 'node:fs/promises';

const UA = 'JoeSphere/1.0 (unofficial Joe Rogan fan site; scheduled event sync)';
const WIKI = 'https://en.wikipedia.org/w/api.php';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 429/503 are "slow down", not "give up". Backing off and retrying keeps a
// momentary throttle from failing the whole source (and, with the carry-forward
// in main(), from stalling that source's rows for days).
async function fetchRetry(url, tries = 3) {
  let wait = 1500;
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status === 503;
    if (!retryable || i >= tries - 1) return res;
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30000) : wait);
    wait *= 2;
  }
}

async function api(params) {
  const url = WIKI + '?' + new URLSearchParams({ format: 'json', ...params });
  const res = await fetchRetry(url);
  if (!res.ok) throw new Error('wikipedia ' + res.status + ' for ' + (params.page || ''));
  return res.json();
}

// Section numbering shifts whenever an editor adds a heading, so resolve the
// index by name rather than hardcoding it.
async function findSectionIndex(page, wanted) {
  const data = await api({ action: 'parse', page, prop: 'sections' });
  const secs = data && data.parse && data.parse.sections;
  if (!Array.isArray(secs)) throw new Error('no section list');
  const hit = secs.find(s => String(s.line || '').toLowerCase().includes(wanted));
  if (!hit) throw new Error('no "' + wanted + '" section on ' + page);
  return hit.index;
}

function clean(html) {
  return String(html)
    // <style>/<script> bodies survive naive tag-stripping and end up as text.
    // Wikipedia inlines a .sr-only rule inside table cells, which showed up
    // glued to the attendance value as ".mw-parser-output .sr-only{...}N/a".
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<sup\b[\s\S]*?<\/sup>/g, '')   // drop [1] citation markers
    .replace(/<[^>]+>/g, '')                 // strip tags
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, String.fromCharCode(39))
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#95;/g, '_')
    .replace(/&ndash;|&#8211;/g, '-')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

// Wikipedia's schedule table uses rowspan: a venue cell can cover several
// rows, and the rows underneath omit that cell entirely. Walking cells
// positionally without tracking the carry-over silently shifts every later
// column left — the reference column gets read as the venue. Hence the grid.
// Returns rows keyed by their column heading ("event", "date", "venue",
// "location", "attendance"...), plus `_link`: the wiki page title from the
// event cell, which is how the box-office lookup finds each event's article.
function parseTable(tableHtml) {
  const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  if (!rows.length) return [];
  const cols = [...rows[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map(m => clean(m[1]).toLowerCase().replace(/[^a-z#]/g, ''));
  if (!cols.length) return [];
  const iEvent = cols.indexOf('event'), iDate = cols.indexOf('date');
  if (iEvent < 0 || iDate < 0) throw new Error('table is missing Event/Date columns');

  const carry = new Map();
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = [...rows[r].matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/g)];
    if (!cells.length) continue;
    const row = {};
    let link = '', ci = 0;
    for (let col = 0; col < cols.length; col++) {
      const key = cols[col] || ('col' + col);
      const held = carry.get(col);
      if (held && held.rem > 0) { row[key] = held.val; held.rem--; continue; }
      if (ci >= cells.length) break;
      const attrs = cells[ci][1], body = cells[ci][2];
      ci++;
      if (col === iEvent) {
        const href = body.match(/href="\/wiki\/([^"#?]+)"/);
        if (href) { try { link = decodeURIComponent(href[1]); } catch { link = href[1]; } }
      }
      // The sort key is machine-readable and locale-proof; the visible text
      // ("Nov 7, 2026") is not. Prefer it wherever the cell carries one.
      const sortable = body.match(/data-sort-value="0*(\d{4}-\d{2}-\d{2})/);
      const val = (col === iDate && sortable) ? sortable[1] : clean(body);
      row[key] = val;
      const span = attrs.match(/rowspan="?(\d+)/);
      if (span && +span[1] > 1) carry.set(col, { val: val, rem: +span[1] - 1 });
    }
    row._link = link;
    out.push(row);
  }
  return out;
}

// Attendance cells are inconsistent: real figures ("18,623"), an em-dash plus
// "N/a" for closed-door Apex cards, and blanks for events too recent to have
// been reported. Anything that isn't a plausible crowd is null, never 0 —
// a zero would drag every average down and read as "nobody came".
function parseCount(s) {
  if (!s) return null;
  const m = String(s).replace(/,/g, '').match(/\d{3,}/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 100 && n <= 200000 ? n : null;
}
function parseMoney(s) {
  if (!s) return null;
  const m = String(s).replace(/,/g, '').match(/\d{4,}/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// Descriptive only, and deliberately not a prediction: it restates which card
// types he has historically called, which is what the Unconfirmed badge means.
function contextNote(title, location) {
  const intl = location && !/\bU\.?S\.?A?\.?$/.test(location.trim());
  if (intl) return 'International card — historically not one he calls.';
  if (/fight night/i.test(title)) return 'Fight Night — historically not one he calls.';
  if (/^UFC\s+\d+/i.test(title)) return 'US numbered card — the type he has historically called.';
  return '';
}

const PAST_LIMIT = 20;      // recent past cards pulled into the feed
const GATE_LOOKUPS = 12;    // of those, how many get an article fetch for `gate`
// Firing the article lookups back to back earns an immediate HTTP 429 and
// half the gate figures come back empty. Space them out: this job runs twice
// a week and has no deadline, so there is no reason to hammer the API.
const REQUEST_GAP_MS = 700;

async function sectionTable(page, wanted) {
  const section = await findSectionIndex(page, wanted);
  const data = await api({ action: 'parse', page, prop: 'text', section });
  const html = data && data.parse && data.parse.text && data.parse.text['*'];
  if (!html) throw new Error('empty section html for ' + wanted);
  const table = html.match(/<table[^>]*>[\s\S]*?<\/table>/);
  if (!table) throw new Error('no table in ' + wanted + ' section');
  return parseTable(table[0]);
}

// Attendance is already a column on the past-events table, but `gate` only
// exists in each event article's infobox, so it costs one request per event.
// Bounded to the most recent handful — this runs twice a week and should stay
// a polite neighbour.
async function boxOffice(title) {
  const data = await api({ action: 'parse', page: title, prop: 'wikitext', section: 0 });
  const wt = data && data.parse && data.parse.wikitext && data.parse.wikitext['*'];
  if (!wt) return {};
  const grab = k => {
    const m = wt.match(new RegExp('\\|\\s*' + k + '\\s*=\\s*([^\\n|]*)'));
    return m ? m[1] : '';
  };
  return { attendance: parseCount(grab('attendance')), gate: parseMoney(grab('gate')) };
}

function toEvent(r, extra) {
  const loc = [r.venue, r.location].filter(Boolean).join(', ');
  return Object.assign({
    src: 'wikipedia:' + slug(r.event),
    date: r.date,
    title: r.event,
    loc: loc,
    type: 'broadcast',
    note: contextNote(r.event, r.location),
    video: null,
    // No public source maps an event to a verified ticket page, so this stays
    // null and the site falls back to a clearly-labelled search link.
    ticket: null,
    flag: 'unconfirmed'
  }, extra || {});
}

async function fromWikipedia() {
  const page = 'List_of_UFC_events';
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set();
  const events = [];
  const add = e => { if (!seen.has(e.src)) { seen.add(e.src); events.push(e); } };

  for (const r of await sectionTable(page, 'scheduled')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;  // unparseable: skip, don't guess
    if (r.date < today || !r.event) continue;
    add(toEvent(r));
  }
  const scheduled = events.length;
  if (!scheduled) throw new Error('parsed 0 scheduled events — table shape probably changed');

  // Past cards carry the box-office numbers the Insights tab reports on, and
  // they also give the feed something between the upcoming fights and the
  // episode releases instead of one hard jump.
  const past = (await sectionTable(page, 'past'))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date < today && r.event)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, PAST_LIMIT);

  for (let i = 0; i < past.length; i++) {
    const r = past[i];
    const box = { attendance: parseCount(r.attendance), gate: null };
    if (i < GATE_LOOKUPS && r._link) {
      try {
        await sleep(REQUEST_GAP_MS);
        const b = await boxOffice(r._link);
        if (b.attendance != null) box.attendance = b.attendance;
        if (b.gate != null) box.gate = b.gate;
      } catch (err) {
        console.error('    (gate lookup failed for ' + r._link + ': ' + err.message + ')');
      }
    }
    add(toEvent(r, (box.attendance != null || box.gate != null) ? { box: box } : {}));
  }
  console.log('    scheduled: ' + scheduled + ', past: ' + (events.length - scheduled) +
    ', with box office: ' + events.filter(e => e.box).length);
  return events;
}

// ── JRE episode releases ─────────────────────────────────────────────────────
// The channel's Atom feed is public and needs no API key or quota. It carries
// the video id, which the page already knows how to turn into a thumbnail and
// an embed (parseVideo0 + CLIPSRC), so episodes arrive with artwork for free.
//
// Unlike a fight card, these are *released*, not scheduled: the date is in the
// past and his participation is not in question — it is his own show — so they
// ship flagged "auto" rather than "unconfirmed". They also carry no venue. The
// studio's city is public, but asserting he was physically somewhere on a given
// day is a location claim this project does not make, so loc stays empty.
const JRE_CHANNEL = 'UCzQUP1qoWDoEbmsQxvdjxgQ';   // PowerfulJRE

function approxViews(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(v);
}

async function fromYouTube() {
  const url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + JRE_CHANNEL;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('youtube feed ' + res.status);
  const xml = await res.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  if (!entries.length) throw new Error('no <entry> elements — feed shape changed');

  const events = [];
  for (const en of entries) {
    const id = (en.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1] || '';
    // Same charset the page enforces before anything reaches an iframe. A feed
    // that hands us something else is skipped, not coerced.
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) continue;
    const title = clean((en.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const date = ((en.match(/<published>(\d{4}-\d{2}-\d{2})/) || [])[1]) || '';
    if (!title || !date) continue;
    const rawViews = Number((en.match(/views="(\d+)"/) || [])[1]);
    const views = Number.isFinite(rawViews) && rawViews > 0 ? rawViews : null;
    events.push({
      src: 'youtube:' + id,
      date,
      title,
      loc: '',
      type: 'podcast',
      note: views ? 'Episode release · ' + approxViews(views) + ' views at last sync.'
                  : 'Episode release.',
      video: { kind: 'yt', id },
      // Kept as a number as well as prose: the Insights tab does arithmetic on
      // it, and the history file tracks how it grows after release.
      views: views,
      ticket: null,
      flag: 'auto'
    });
  }

  // The RSS feed only ever carries the latest 15 uploads. With an API key we
  // can walk the uploads playlist for real depth; without one the site still
  // works, just with a shorter window. Never fail the source over a missing or
  // rejected key — it is strictly an enhancement.
  const key = process.env.YOUTUBE_API_KEY;
  if (key) {
    try {
      const deeper = await fromYouTubeApi(key);
      const have = new Set(events.map(e => e.src));
      let added = 0;
      for (const e of deeper) if (!have.has(e.src)) { events.push(e); have.add(e.src); added++; }
      console.log('    +' + added + ' older episodes via YouTube Data API');
    } catch (err) {
      console.error('    (YouTube Data API skipped: ' + err.message + ')');
    }
  }

  if (!events.length) throw new Error('parsed 0 episodes — feed shape probably changed');
  return events;
}

const API_PAGES = 4;   // 50 videos per page

async function fromYouTubeApi(key) {
  const yt = async (path, params) => {
    const url = 'https://www.googleapis.com/youtube/v3/' + path + '?' +
      new URLSearchParams(Object.assign({ key: key }, params));
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(path + ' ' + res.status);
    return res.json();
  };
  const ch = await yt('channels', { part: 'contentDetails', id: JRE_CHANNEL });
  const uploads = ch.items && ch.items[0] &&
    ch.items[0].contentDetails.relatedPlaylists.uploads;
  if (!uploads) throw new Error('no uploads playlist');

  const ids = [];
  let pageToken = '';
  for (let p = 0; p < API_PAGES; p++) {
    const pl = await yt('playlistItems',
      Object.assign({ part: 'contentDetails', playlistId: uploads, maxResults: '50' },
        pageToken ? { pageToken: pageToken } : {}));
    for (const it of pl.items || []) {
      const vid = it.contentDetails && it.contentDetails.videoId;
      if (/^[A-Za-z0-9_-]{11}$/.test(vid || '')) ids.push(vid);
    }
    pageToken = pl.nextPageToken || '';
    if (!pageToken) break;
  }
  if (!ids.length) throw new Error('no videos in uploads playlist');

  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const vs = await yt('videos', { part: 'snippet,statistics', id: chunk.join(',') });
    for (const v of vs.items || []) {
      const id = v.id;
      if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) continue;
      const title = clean(v.snippet && v.snippet.title);
      const date = String((v.snippet && v.snippet.publishedAt) || '').slice(0, 10);
      if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const n = Number(v.statistics && v.statistics.viewCount);
      const views = Number.isFinite(n) && n > 0 ? n : null;
      out.push({
        src: 'youtube:' + id,
        date, title, loc: '', type: 'podcast',
        note: views ? 'Episode release · ' + approxViews(views) + ' views at last sync.'
                    : 'Episode release.',
        video: { kind: 'yt', id }, views: views, ticket: null, flag: 'auto'
      });
    }
  }
  return out;
}

// `prefix` is how a source's own rows are recognised in an existing
// events.json, so a source that fails this run can have its previous rows
// carried forward instead of vanishing (see main()).
const SOURCES = [
  { name: 'wikipedia:List_of_UFC_events', prefix: 'wikipedia:', run: fromWikipedia },
  { name: 'youtube:PowerfulJRE', prefix: 'youtube:', run: fromYouTube }
];

const OUT = new URL('../events.json', import.meta.url);
const HIST = new URL('../view-history.json', import.meta.url);

// A view count is a snapshot; the interesting figure is how it moves. Each run
// appends one dated sample per episode so the site can show growth after
// release, which no single API call can tell you. Samples are only appended
// when the number actually changed, so a stalled source doesn't inflate the
// file, and each series is capped so it can't grow without bound.
const HIST_MAX_SAMPLES = 60;

async function recordViewHistory(events) {
  const withViews = events.filter(e => e.video && e.video.id && Number.isFinite(e.views));
  if (!withViews.length) { console.log('No view data this run — history unchanged.'); return; }

  let hist = { series: {} };
  try {
    const prev = JSON.parse(await readFile(HIST, 'utf8'));
    if (prev && prev.series && typeof prev.series === 'object') hist = prev;
  } catch { /* first run */ }

  const day = new Date().toISOString().slice(0, 10);
  let touched = 0;
  for (const e of withViews) {
    const series = hist.series[e.video.id] || (hist.series[e.video.id] = []);
    const last = series[series.length - 1];
    if (last && last[0] === day) { last[1] = e.views; continue; }   // same day: correct in place
    if (last && last[1] === e.views) continue;                      // unchanged: nothing to record
    series.push([day, e.views]);
    if (series.length > HIST_MAX_SAMPLES) series.splice(0, series.length - HIST_MAX_SAMPLES);
    touched++;
  }
  hist.generated = new Date().toISOString();
  await writeFile(HIST, JSON.stringify(hist, null, 2) + '\n');
  console.log('view-history.json — ' + Object.keys(hist.series).length +
    ' episodes tracked, ' + touched + ' new sample(s).');
}

async function readExisting() {
  try {
    const prev = JSON.parse(await readFile(OUT, 'utf8'));
    return Array.isArray(prev.events) ? prev.events : [];
  } catch { return []; }   // first run, or unreadable: nothing to carry
}

async function main() {
  const all = [];
  const failed = [];
  for (const s of SOURCES) {
    try {
      const got = await s.run();
      console.log('OK  ' + s.name + ': ' + got.length + ' events');
      all.push(...got);
    } catch (err) {
      console.error('ERR ' + s.name + ': ' + err.message);
      failed.push(s);
    }
  }

  if (failed.length === SOURCES.length) {
    console.error('\nAll sources failed — leaving the existing events.json untouched.');
    process.exit(1);
  }

  // One source being down must not delete the other's content. Without this,
  // a single flaky fetch republishes the file without those rows and the site
  // silently loses a whole category until the next run days later. Carried
  // rows are last-known-good, so a cancelled event can linger for one cycle —
  // that is the lesser of the two failures, and it self-corrects next run.
  if (failed.length) {
    const prev = await readExisting();
    for (const s of failed) {
      const kept = prev.filter(e => typeof e.src === 'string' && e.src.startsWith(s.prefix));
      if (kept.length) {
        console.log('  ↳ carried forward ' + kept.length + ' previous rows from ' + s.name);
        all.push(...kept);
      }
    }
  }

  const seen = new Set();
  const events = all
    .filter(e => !seen.has(e.src) && seen.add(e.src))
    .sort((a, b) => a.date.localeCompare(b.date));

  const payload = { generated: new Date().toISOString(), events: events };
  await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log('\nWrote events.json — ' + events.length + ' events, ' +
    failed.length + ' source(s) failed.');

  await recordViewHistory(events);
}

main().catch(err => { console.error('fatal:', err); process.exit(1); });
