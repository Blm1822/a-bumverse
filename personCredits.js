// A person's full career from MusicBrainz relationships ("IMDb for music credits").
//
// MusicBrainz attaches a person's credits to releases (producer on an album),
// recordings (guitar on a track) and works (wrote a song). Albumverse's album
// pages are release groups, so every credit is mapped to the release group of
// its original album, skipping compilations, live albums and remixes:
//   release   -> release search by id        -> its release group
//   recording -> recording search by id      -> earliest original album it's on
//   work      -> work lookup (its recordings) -> recording search -> earliest original album
// Releases and recordings are batched (~40 ids per search); songs are one request each
// (capped at 150), so a prolific songwriter takes a few minutes in the background.

import { mbFetch } from './mb.js';

const MB_ROOT = 'https://musicbrainz.org/ws/2';
const BATCH = 40;

// ---------------------------------------------------------------- roles
const CATEGORY_RULES = [
  ['producer', /produc/],
  ['songwriter', /^(writer|composer|lyricist|librettist|songwriter)$/],
  ['arrangement', /arrang|orchestrat|conduct/],
  ['engineering', /engineer|mix|master|record|sound|audio|editor|programming/],
  ['performer', /instrument|vocal|performer|performing|orchestra|chorus|choir|solo/],
];
export const CATEGORY_LABELS = {
  producer: 'Producer',
  songwriter: 'Songwriter',
  performer: 'Musician',
  arrangement: 'Arranger',
  engineering: 'Engineering & mixing',
  other: 'Other',
};

export function categoryOf(type) {
  const t = String(type || '').toLowerCase();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  return 'other';
}

// "instrument" + ['electric guitar'] -> "electric guitar"; "vocal" + ['lead vocals'] -> "lead vocals"
export function roleOf(rel) {
  const type = String(rel.type || '').toLowerCase();
  const attrs = (rel.attributes || []).map((a) => String(a).toLowerCase())
    .filter((a) => !['additional', 'co', 'guest', 'solo', 'executive', 'assistant', 'associate', 'minor', 'task'].includes(a));
  if ((type === 'instrument' || type === 'vocal') && attrs.length) return attrs.slice(0, 2).join(', ');
  if (type === 'vocal') return 'vocals';
  const lead = (rel.attributes || []).map((a) => String(a).toLowerCase()).find((a) => ['co', 'executive', 'assistant', 'associate', 'additional'].includes(a));
  return lead ? `${lead === 'co' ? 'co-' : `${lead} `}${type}` : type;
}

// ---------------------------------------------------------------- picking the album
const TYPE_RANK = { album: 0, ep: 1, single: 2 };

function rgOf(release) {
  const g = release['release-group'] || {};
  return {
    id: g.id,
    title: g.title || release.title,
    type: g['primary-type'] || null,
    secondary: g['secondary-types'] || [],
    date: g['first-release-date'] || release.date || null,
  };
}

// The original album/EP/single a track or release belongs to: no compilations, live
// albums, remixes or soundtracks; prefer albums, then the earliest date.
export function pickOriginal(releases) {
  const ok = (releases || [])
    .map(rgOf)
    .filter((g) => g.id && g.type && TYPE_RANK[String(g.type).toLowerCase()] !== undefined && !g.secondary.length);
  ok.sort((a, b) =>
    TYPE_RANK[String(a.type).toLowerCase()] - TYPE_RANK[String(b.type).toLowerCase()]
    || String(a.date || '9999').localeCompare(String(b.date || '9999')));
  return ok[0] || null;
}

const creditName = (ac) => (ac || []).map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim();

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------- turning MB responses into rows
// Pure: relations (artist lookup) + search results -> credit rows. Tested with fixtures.
export function buildRows({ relations, releasesById, recordingsById, recordingsByWork = new Map() }) {
  // An album's year = the earliest date we saw for any release of it (search results are often
  // reissues: a 2018 pressing of a 1984 album still belongs to the 1984 release group).
  const firstDate = new Map();
  const see = (rel) => {
    const g = rel?.['release-group'];
    const d = g?.['first-release-date'] || rel?.date;
    if (!g?.id || !d) return;
    const cur = firstDate.get(g.id);
    if (!cur || String(d) < String(cur)) firstDate.set(g.id, d);
  };
  for (const r of releasesById.values()) see(r);
  for (const r of recordingsById.values()) for (const x of r.releases || []) see(x);
  for (const list of recordingsByWork.values()) for (const r of list) for (const x of r.releases || []) see(x);
  const rows = [];
  for (const rel of relations || []) {
    const target = rel['target-type'];
    if (rel.direction === 'backward' && target !== 'work') continue;   // e.g. "is member of" style links
    const category = categoryOf(rel.type);
    const role = roleOf(rel);
    let album = null;
    let song = null;
    let by = '';
    if (target === 'release') {
      const r = releasesById.get(rel.release?.id);
      album = r ? pickOriginal([r]) : null;
      by = r ? creditName(r['artist-credit']) : '';
    } else if (target === 'recording') {
      const r = recordingsById.get(rel.recording?.id);
      song = rel.recording?.title || r?.title || null;
      album = r ? pickOriginal(r.releases) : null;
      by = r ? creditName(r['artist-credit']) : '';
    } else if (target === 'work') {
      song = rel.work?.title || null;
      const recs = recordingsByWork.get(rel.work?.id) || [];
      let best = null;
      for (const r of recs) {
        const pick = pickOriginal(r.releases);
        if (pick && (!best || String(pick.date || '9999') < String(best.album.date || '9999'))) best = { album: pick, by: creditName(r['artist-credit']) };
      }
      if (best) { album = best.album; by = best.by; }
    } else {
      continue;
    }
    if (!album) continue;
    if (firstDate.has(album.id)) album = { ...album, date: firstDate.get(album.id) };
    rows.push({
      category, role, rgId: album.id, rgTitle: album.title, rgType: album.type,
      date: album.date, by, song, source: target,
    });
  }
  // One row per (album, category, role, song): the same credit often appears on a release and its recordings.
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.rgId}|${r.category}|${r.role}|${r.song || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- fetching
function chunks(xs, n) {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function search(entity, field, ids) {
  const q = ids.map((id) => `${field}:${id}`).join(' OR ');
  const url = `${MB_ROOT}/${entity}/?query=${encodeURIComponent(q)}&fmt=json&limit=100`;
  const data = await mbFetch(url);
  return data[`${entity}s`] || [];
}

// limits keep one prolific person from monopolising the shared MusicBrainz queue
export async function fetchPersonCredits(mbid, { maxRecordings = 600, maxWorks = 150 } = {}) {
  const lookup = await mbFetch(`${MB_ROOT}/artist/${mbid}?inc=release-rels+recording-rels+work-rels&fmt=json`);
  const relations = lookup.relations || [];
  const ids = (t, key) => [...new Set(relations.filter((r) => r['target-type'] === t).map((r) => r[key]?.id).filter(Boolean))];
  const releaseIds = ids('release', 'release');
  const recordingIds = ids('recording', 'recording').slice(0, maxRecordings);
  const workIds = ids('work', 'work').slice(0, maxWorks);

  const releasesById = new Map();
  for (const c of chunks(releaseIds, BATCH)) for (const r of await search('release', 'reid', c)) releasesById.set(r.id, r);
  const recordingsById = new Map();
  for (const c of chunks(recordingIds, BATCH)) for (const r of await search('recording', 'rid', c)) recordingsById.set(r.id, r);
  // Songs: one lookup per work for its recordings (confirmed supported), then those
  // recordings' albums via the same batched search as above.
  const recIdsByWork = new Map();
  const needed = new Set();
  for (const wid of workIds) {
    const w = await mbFetch(`${MB_ROOT}/work/${wid}?inc=recording-rels&fmt=json`);
    const recIds = (w.relations || []).filter((r) => r['target-type'] === 'recording' && r.recording?.id)
      .map((r) => r.recording.id).slice(0, 8);
    recIdsByWork.set(wid, recIds);
    for (const id of recIds) if (!recordingsById.has(id)) needed.add(id);
  }
  for (const c of chunks([...needed], BATCH)) for (const r of await search('recording', 'rid', c)) recordingsById.set(r.id, r);
  const recordingsByWork = new Map();
  for (const [wid, ids] of recIdsByWork) recordingsByWork.set(wid, ids.map((id) => recordingsById.get(id)).filter(Boolean));
  return {
    rows: buildRows({ relations, releasesById, recordingsById, recordingsByWork }),
    relationCount: relations.length,
    type: lookup.type || null,
    name: lookup.name,
  };
}

// ---------------------------------------------------------------- background filling
// One person at a time, each MusicBrainz call awaited before the next, so a visitor's
// album lookup never waits behind more than one background request. People whose page
// was just opened jump the queue. Set PERSON_ENRICH=off to disable.
import { savePersonCredits, nextPeopleToEnrich } from './db.js';

const priority = [];
const failures = new Map();
let busy = false;

export function prioritizePerson(mbid) {
  if (!priority.includes(mbid)) priority.unshift(mbid);
  if (priority.length > 50) priority.length = 50;
}

export async function enrichPerson(mbid) {
  const { rows, relationCount } = await fetchPersonCredits(mbid);
  savePersonCredits(mbid, rows);
  return { rows: rows.length, relationCount };
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const ok = (id) => !failures.has(id) || failures.get(id) < now;
    let mbid = priority.shift();
    while (mbid && !ok(mbid)) mbid = priority.shift();
    if (!mbid) mbid = nextPeopleToEnrich(25).map((p) => p.mbid).find(ok);
    if (!mbid) return;
    try {
      const r = await enrichPerson(mbid);
      console.log(`[people] ${mbid}: ${r.rows} credits from ${r.relationCount} relationships`);
    } catch (err) {
      failures.set(mbid, now + 6 * 60 * 60 * 1000);    // try again in 6 hours
      console.log(`[people] ${mbid} failed: ${err.message}`);
    }
  } finally {
    busy = false;
  }
}

export function startPersonEnricher({ everyMs = 15000, startAfterMs = 60000 } = {}) {
  if (process.env.PERSON_ENRICH === 'off') {
    console.log('person credits enricher off (PERSON_ENRICH=off)');
    return;
  }
  setTimeout(() => {
    tick();
    setInterval(tick, everyMs).unref();
  }, startAfterMs).unref();
}
