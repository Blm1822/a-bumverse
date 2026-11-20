// Song-by-song credits: who played on each track.
//
// Two sources. MusicBrainz recording relationships (who played what on this
// recording) come in with the album fetch in mb.js. Discogs often has more:
// credits listed under each track, and album credits scoped to tracks
// ("Guitar - tracks A1, B2 to B4"). This module maps those Discogs credits onto
// our tracks, and runs a background job that refreshes albums saved before
// either source was used this way, most-viewed first.

import { runInBackground } from './lanes.js';
import { cleanDiscogsName, discogsAlbumCredits, findDiscogsRelease } from './discogs.js';
import { getAlbumDetail } from './mb.js';
import {
  albumsNeedingSongCredits, saveSongCredits, albumSongCreditsAt, savedRecordings, requeueAlbumsWithoutMusicians,
  upsertArtist, upsertAlbum, setAlbumCredits, markEnriched, markSongCredits,
} from './db.js';

const WRITER_RE = /writ|compos|lyric|music by|words by|songwriter/i;
// Credits that are about the physical record or the business, not the song.
const SKIP_RE = /lacquer|master|design|artwork|art direction|photo|liner|legal|management|a&r|layout|illustrat|sleeve|cover|booking|coordinat|copyright|phonographic|licensed|manufactur|distribut|pressed|marketing|styl|hair|make-?up|costume|graphics|lettering/i;

export function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Discogs "tracks" scope: "A1, B2 to B4", "1 to 3, 5", "1-3 to 1-5". Returns the
// indexes into `positions` (the release's track positions, in order).
export function parseTrackSpec(spec, positions) {
  const out = new Set();
  if (!spec) return out;
  const idx = (p) => positions.findIndex((x) => x.toLowerCase() === p.trim().toLowerCase());
  for (const part of String(spec).split(',')) {
    const range = part.split(/\s+to\s+/i);
    if (range.length === 2) {
      const a = idx(range[0]);
      const b = idx(range[1]);
      if (a >= 0 && b >= a) for (let i = a; i <= b; i++) out.add(i);
    } else {
      const i = idx(part);
      if (i >= 0) out.add(i);
    }
  }
  return out;
}

// Per Discogs track: [{ title, credits: [{ name, role }] }].
export function discogsTrackCredits(release) {
  const tracks = ((release && release.tracklist) || []).filter((t) => (t.type_ || 'track') === 'track');
  const positions = tracks.map((t) => String(t.position || ''));
  const out = tracks.map((t) => ({
    title: t.title,
    credits: (t.extraartists || []).filter((a) => a.name && a.role).map((a) => ({ name: cleanDiscogsName(a), role: a.role })),
  }));
  for (const a of (release && release.extraartists) || []) {
    if (!a.tracks || !a.name || !a.role) continue;
    for (const i of parseTrackSpec(a.tracks, positions)) out[i].credits.push({ name: cleanDiscogsName(a), role: a.role });
  }
  return out;
}

// Match Discogs tracks to ours by title. Returns null when too few titles match,
// which usually means the Discogs search found a different record.
export function matchTracks(ours, theirs) {
  if (!ours.length || !theirs.length) return null;
  const byTitle = new Map();
  theirs.forEach((t, i) => {
    const k = normTitle(t.title);
    if (k && !byTitle.has(k)) byTitle.set(k, i);
  });
  const map = ours.map((t) => (byTitle.has(normTitle(t.title)) ? byTitle.get(normTitle(t.title)) : -1));
  const hits = map.filter((i) => i >= 0).length;
  if (hits / ours.length < 0.6) return null;
  return map;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => {
    const k = `${c.name.toLowerCase()}|${String(c.role || '').toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Add Discogs song credits to an album's tracks (in place). Musicians and
// producers go to performers; Discogs writers only fill songs MusicBrainz left
// without any. Returns how many songs gained a credit.
export function mergeDiscogsIntoTracks(tracks, release) {
  const theirs = discogsTrackCredits(release);
  const map = matchTracks(tracks, theirs);
  if (!map) return 0;
  let gained = 0;
  tracks.forEach((t, i) => {
    if (map[i] < 0) return;
    const credits = theirs[map[i]].credits.filter((c) => !SKIP_RE.test(c.role));
    const writers = credits.filter((c) => WRITER_RE.test(c.role));
    const players = credits.filter((c) => !WRITER_RE.test(c.role));
    const before = (t.performers || []).length + (t.writers || []).length;
    // Someone MusicBrainz already credits on this song keeps that (linked) entry.
    const known = new Set((t.performers || []).map((p) => p.name.toLowerCase()));
    const extra = players.filter((c) => !known.has(c.name.toLowerCase()));
    t.performers = dedupe([...(t.performers || []), ...extra.map((c) => ({ name: c.name, role: c.role, mbid: null }))]);
    if (!(t.writers || []).length && writers.length) t.writers = dedupe(writers.map((c) => ({ name: c.name, role: c.role, mbid: null })));
    if ((t.performers || []).length + (t.writers || []).length > before) gained++;
  });
  return gained;
}

// Full credit pass for a freshly fetched MusicBrainz album: Discogs per-song
// credits merged into detail.tracks, and the album-wide credit list
// (MusicBrainz release credits plus Discogs credits) returned for album_credits.
export async function addDiscogsCredits(detail) {
  const release = await findDiscogsRelease(detail.artist, detail.title);
  const gained = release ? mergeDiscogsIntoTracks(detail.tracks || [], release) : 0;
  const albumCredits = [...(detail.releaseCredits || []), ...discogsAlbumCredits(release)];
  return { albumCredits, gained };
}

// ---------------------------------------------------------------- background refresh
// Albums saved before this existed have no per-song musicians. Refresh them one
// at a time, most-viewed first; an album someone opens jumps the line.
// SONG_CREDITS=off turns this off.

const jumpQueue = [];
const failed = new Set();

export function prioritizeAlbum(mbid) {
  if (process.env.SONG_CREDITS === 'off' || jumpQueue.includes(mbid) || jumpQueue.length > 50) return;
  if (albumSongCreditsAt(mbid) === null) jumpQueue.push(mbid);
}

// Fetch an album in full (songs, writers, musicians, Discogs credits) and save it,
// replacing what was saved before. Used for albums opened for the first time
// and when a refresh lands on a different release than the one saved.
export async function importAlbum(mbid) {
  const detail = await getAlbumDetail(mbid);
  const artistMbids = [];
  for (const credit of detail.artistCredits || []) {
    upsertArtist({ mbid: credit.mbid, name: credit.name, disambiguation: null });
    artistMbids.push(credit.mbid);
  }
  // Discogs per-song credits go into detail.tracks before saving.
  const { albumCredits } = await addDiscogsCredits(detail);
  upsertAlbum(detail, artistMbids);
  if (albumCredits.length) setAlbumCredits(mbid, albumCredits);
  markEnriched(mbid);
  markSongCredits(mbid);
  return detail;
}

export async function refreshAlbumSongCredits(mbid) {
  try {
    // Writers are already saved; skip the per-song work lookups...
    const detail = await getAlbumDetail(mbid, { works: false });
    const saved = new Set(savedRecordings(mbid));
    const same = (detail.tracks || []).filter((t) => saved.has(t.recordingMbid)).length;
    // ...unless the fetch read a different release than the one saved (its songs,
    // titles and writers may differ too): then re-import the album in full.
    if (detail.tracks.length && same / detail.tracks.length < 0.6) {
      const full = await importAlbum(mbid);
      return { songs: full.tracks.filter((t) => t.performers.length).length, reimported: true };
    }
    const { albumCredits, gained } = await addDiscogsCredits(detail);
    const n = saveSongCredits(mbid, detail.tracks, albumCredits, detail.releaseCount);
    return { songs: n, gained };
  } catch (err) {
    // Not marked done: skipped for the rest of this run, tried again after a restart.
    failed.add(mbid);
    console.error('song credits refresh failed', mbid, err.message);
    return null;
  }
}

let running = false;
let backlog = [];
async function tick() {
  if (running) return;
  running = true;
  try {
    if (!jumpQueue.length && !backlog.length) backlog = albumsNeedingSongCredits(50 + failed.size).map((r) => r.id).filter((id) => !failed.has(id));
    const mbid = jumpQueue.shift() || backlog.shift();
    if (mbid && !failed.has(mbid) && albumSongCreditsAt(mbid) === null) await refreshAlbumSongCredits(mbid);
  } finally {
    running = false;
  }
}

export function startSongCreditsRefresh({ everyMs = 4000, startAfterMs = 90000 } = {}) {
  if (process.env.SONG_CREDITS === 'off') {
    console.log('song credits refresh off (SONG_CREDITS=off)');
    return;
  }
  const requeued = requeueAlbumsWithoutMusicians();
  if (requeued) console.log(`song credits: ${requeued} albums with no musicians queued for another look`);
  // Background lane: visitors' MusicBrainz/Discogs requests go ahead of these.
  const bgTick = () => runInBackground(tick);
  setTimeout(() => {
    bgTick();
    setInterval(bgTick, everyMs).unref();
  }, startAfterMs).unref();
}
