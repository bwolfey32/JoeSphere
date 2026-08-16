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

async function api(params) {
  const url = WIKI + '?' + new URLSearchParams({ format: 'json', ...params });
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
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
function parseTable(tableHtml) {
  const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  if (!rows.length) return [];
  const cols = [...rows[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map(m => clean(m[1]).toLowerCase());
  if (!cols.length) return [];
  const idx = name => cols.findIndex(c => c.startsWith(name));
  const iEvent = idx('event'), iDate = idx('date'), iVenue = idx('venue'), iLoc = idx('location');
  if (iEvent < 0 || iDate < 0) throw new Error('schedule table is missing Event/Date columns');

  const carry = new Map();
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = [...rows[r].matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/g)];
    if (!cells.length) continue;
    const row = [];
    let ci = 0;
    for (let col = 0; col < cols.length; col++) {
      const held = carry.get(col);
      if (held && held.rem > 0) { row[col] = held.val; held.rem--; continue; }
      if (ci >= cells.length) break;
      const attrs = cells[ci][1], body = cells[ci][2];
      ci++;
      // The sort key is machine-readable and locale-proof; the visible text
      // ("Nov 7, 2026") is not. Prefer it wherever the cell carries one.
      const sortable = body.match(/data-sort-value="0*(\d{4}-\d{2}-\d{2})/);
      const val = (col === iDate && sortable) ? sortable[1] : clean(body);
      row[col] = val;
      const span = attrs.match(/rowspan="?(\d+)/);
      if (span && +span[1] > 1) carry.set(col, { val: val, rem: +span[1] - 1 });
    }
    out.push({
      title: row[iEvent] || '',
      date: row[iDate] || '',
      venue: iVenue >= 0 ? (row[iVenue] || '') : '',
      loc: iLoc >= 0 ? (row[iLoc] || '') : ''
    });
  }
  return out;
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

async function fromWikipedia() {
  const page = 'List_of_UFC_events';
  const section = await findSectionIndex(page, 'scheduled');
  const data = await api({ action: 'parse', page, prop: 'text', section });
  const html = data && data.parse && data.parse.text && data.parse.text['*'];
  if (!html) throw new Error('empty section html');
  const table = html.match(/<table[^>]*>[\s\S]*?<\/table>/);
  if (!table) throw new Error('no table in scheduled section');

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set();
  const events = [];
  for (const r of parseTable(table[0])) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;   // unparseable date: skip, don't guess
    if (r.date < today) continue;                        // announced *upcoming* only
    if (!r.title) continue;
    const src = 'wikipedia:' + slug(r.title);
    if (seen.has(src)) continue;
    seen.add(src);
    const loc = [r.venue, r.loc].filter(Boolean).join(', ');
    events.push({
      src: src,
      date: r.date,
      title: r.title,
      loc: loc,
      type: 'broadcast',
      note: contextNote(r.title, r.loc),
      video: null,
      // No public source maps an event to a verified ticket page, so this
      // stays null and the site falls back to a clearly-labelled search link.
      ticket: null,
      flag: 'unconfirmed'
    });
  }
  if (!events.length) throw new Error('parsed 0 events — table shape probably changed');
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
    const views = approxViews((en.match(/views="(\d+)"/) || [])[1]);
    events.push({
      src: 'youtube:' + id,
      date,
      title,
      loc: '',
      type: 'podcast',
      note: views ? 'Episode release · ' + views + ' views at last sync.' : 'Episode release.',
      video: { kind: 'yt', id },
      ticket: null,
      flag: 'auto'
    });
  }
  if (!events.length) throw new Error('parsed 0 episodes — feed shape probably changed');
  return events;
}

// `prefix` is how a source's own rows are recognised in an existing
// events.json, so a source that fails this run can have its previous rows
// carried forward instead of vanishing (see main()).
const SOURCES = [
  { name: 'wikipedia:List_of_UFC_events', prefix: 'wikipedia:', run: fromWikipedia },
  { name: 'youtube:PowerfulJRE', prefix: 'youtube:', run: fromYouTube }
];

const OUT = new URL('../events.json', import.meta.url);

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
}

main().catch(err => { console.error('fatal:', err); process.exit(1); });
