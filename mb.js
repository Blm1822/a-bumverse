// Shared, rate-limited MusicBrainz client. MusicBrainz asks unauthenticated
// clients to stay at ~1 request/second, so every call funnels through one
// serialized queue with a disk-persisted cache (survives restarts/deploys)
// to avoid re-hitting it needlessly.
import { getCachedResponse, setCachedResponse } from './db.js';
import { pacedQueue } from './lanes.js';

const MB_ROOT = 'https://musicbrainz.org/ws/2';
export const CAA_ROOT = 'https://coverartarchive.org';
const USER_AGENT = 'Albumverse/0.3.0 (music database project; contact: none)';

const queue = pacedQueue(1300); // visitor requests jump ahead of background jobs
const CACHE_TTL_MS = 1000 * 60 * 30;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
          await sleep(1500 * attempt);
          continue;
        }
        throw new Error(`MusicBrainz ${res.status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

export function mbFetch(url) {
  const cached = getCachedResponse(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const run = () =>
    runWithRetry(url).then((data) => {
      setCachedResponse(url, data, CACHE_TTL_MS);
      return data;
    });

  return queue.add(run);
}

export async function searchReleaseGroups(query, limit = 15) {
  const url = `${MB_ROOT}/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;
  const data = await mbFetch(url);
  return (data['release-groups'] || []).map((rg) => ({
    id: rg.id,
    title: rg.title,
    type: rg['primary-type'] || 'Release',
    date: rg['first-release-date'] || '',
    artist: (rg['artist-credit'] || []).map((a) => a.name).join(', '),
    releaseCount: rg.count || null,
  }));
}

// Albums whose title is exactly the query, up to 100, each with its release count
// (MusicBrainz's plain search scores every exact title the same, so the famous
// album can be missing from the first page; the release count finds it).
export async function searchAlbumsByTitle(title, limit = 100) {
  const q = `releasegroup:"${String(title).replace(/["\\]/g, ' ')}" AND primarytype:album`;
  return searchReleaseGroups(q, limit);
}

export async function searchArtist(name) {
  const url = `${MB_ROOT}/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=5`;
  const data = await mbFetch(url);
  const best = (data.artists || [])[0];
  if (!best) return null;
  return { mbid: best.id, name: best.name, disambiguation: best.disambiguation || null };
}

// type + life-span (birth/death) - core fields on the Artist resource, no
// `inc` needed. Returns raw-ish data; it's up to the caller to decide what
// "ended" means (a Group ending is a breakup, not a death - only a Person
// with ended:true is someone who died).
export async function getArtistDetail(mbid) {
  const url = `${MB_ROOT}/artist/${mbid}?fmt=json`;
  const artist = await mbFetch(url);
  const lifeSpan = artist['life-span'] || {};
  return {
    type: artist.type || null,
    bornDate: lifeSpan.begin || null,
    endDate: lifeSpan.end || null,
    ended: !!lifeSpan.ended,
  };
}

export async function getArtistReleaseGroups(artistMbid) {
  const groups = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = `${MB_ROOT}/release-group?artist=${artistMbid}&fmt=json&limit=${limit}&offset=${offset}`;
    const data = await mbFetch(url);
    for (const rg of data['release-groups'] || []) {
      groups.push({
        id: rg.id,
        title: rg.title,
        primaryType: rg['primary-type'] || 'Other',
        secondaryTypes: rg['secondary-types'] || [],
        date: rg['first-release-date'] || '',
      });
    }
    offset += limit;
    if (offset >= (data['release-group-count'] || 0)) break;
  }
  return groups;
}

// Readable role for a MusicBrainz artist relationship: instrument and vocal
// relationships are named by their attributes ("guitar", "lead vocals"); other
// types keep the type ("producer", or "executive producer" with an attribute).
export function relRole(rel) {
  const attrs = rel.attributes || [];
  if (rel.type === 'instrument' || rel.type === 'vocal') return attrs.length ? attrs.join(', ') : rel.type;
  return attrs.length ? `${attrs.join(', ')} ${rel.type}` : rel.type;
}

// Which of an album's releases to read credits from. MusicBrainz lists them in
// no useful order, and a regional or late reissue often has its own recordings
// with nothing linked (Thriller and Nevermind both landed on one). Prefer an
// official release, with the album's own title, from a main English-language
// market, in Latin script, earliest first.
const MAIN_MARKETS = new Set(['US', 'GB', 'XW', 'XE', 'CA', 'AU']);
export function rankReleases(rgTitle, releases) {
  const score = (r) => (r.status === 'Official' ? 100 : 0)
    + (MAIN_MARKETS.has(r.country) ? 20 : 0)
    + (r.title === rgTitle ? 10 : 0)
    + ((r['text-representation'] || {}).script === 'Latn' ? 5 : 0)
    + (r.date ? 5 : 0);
  return [...releases].sort((a, b) => score(b) - score(a) || String(a.date || '9999').localeCompare(String(b.date || '9999')));
}

async function readRelease(releaseId) {
  const relUrl =
    `${MB_ROOT}/release/${releaseId}` +
    // artist-rels is what brings in who played on each recording (instrument,
    // vocal, producer...). Without it, recording-level-rels only returned works.
    `?inc=recordings+artist-credits+artist-rels+recording-level-rels+work-rels+work-level-rels+labels&fmt=json`;
  const release = await mbFetch(relUrl);

  const tracks = [];
  const workIds = new Set();
  for (const medium of release.media || []) {
    for (const track of medium.tracks || []) {
      const recording = track.recording || {};
      const performers = [];
      let workRef = null;

      for (const rel of recording.relations || []) {
        if (rel['target-type'] === 'artist' && rel.artist) {
          performers.push({
            name: rel.artist.name,
            mbid: rel.artist.id,
            role: relRole(rel),
          });
        } else if (rel['target-type'] === 'work' && rel.work) {
          workRef = { id: rel.work.id, title: rel.work.title };
          workIds.add(rel.work.id);
        }
      }

      tracks.push({
        position: track.position,
        title: track.title,
        length: track.length,
        artist: (track['artist-credit'] || []).map((a) => a.name).join(', '),
        recordingMbid: recording.id,
        performers,
        workId: workRef ? workRef.id : null,
      });
    }
  }
  return { release, tracks, workIds, withPerformers: tracks.filter((t) => t.performers.length).length };
}

// Pick a representative release for a release-group and pull its full
// tracklist + credits (performers directly, writers via each track's work).
export async function getAlbumDetail(rgId, { works = true } = {}) {
  const rgUrl = `${MB_ROOT}/release-group/${rgId}?inc=releases+artist-credits+genres&fmt=json`;
  const rg = await mbFetch(rgUrl);

  // MusicBrainz genres are community-voted; count is the vote tally. Keep the
  // handful that actually got votes, strongest first, so a release with
  // dozens of low-signal tags doesn't dump them all onto the album page.
  const genres = (rg.genres || [])
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((g) => g.name);

  const releases = rg.releases || [];
  if (!releases.length) throw new Error('no releases found for this release-group');

  // Try the most likely "main" release first; if none of its songs credit any
  // musicians (a regional pressing with its own, unlinked recordings, say), try
  // the next one and keep whichever credits more songs.
  const ranked = rankReleases(rg.title, releases);
  let best = null;
  for (const candidate of ranked.slice(0, 2)) {
    const r = await readRelease(candidate.id);
    if (!best || r.withPerformers > best.withPerformers) best = r;
    if (best.withPerformers > 0) break;
  }
  const { release, tracks, workIds } = best;

  const workCredits = {};
  for (const workId of works ? workIds : []) {
    try {
      const workUrl = `${MB_ROOT}/work/${workId}?inc=artist-rels&fmt=json`;
      const work = await mbFetch(workUrl);
      workCredits[workId] = (work.relations || [])
        .filter((r) => r['target-type'] === 'artist' && r.artist)
        .map((r) => ({
          name: r.artist.name,
          mbid: r.artist.id,
          role: r.attributes && r.attributes.length ? r.attributes.join(', ') : r.type,
        }));
    } catch {
      workCredits[workId] = [];
    }
  }

  for (const t of tracks) {
    t.writers = t.workId ? workCredits[t.workId] || [] : [];
    delete t.workId;
  }

  // Credits on the release as a whole (often producer, engineers, the band).
  const releaseCredits = (release.relations || [])
    .filter((r) => r['target-type'] === 'artist' && r.artist)
    .map((r) => ({
      name: r.artist.name,
      role: relRole(r),
      source: 'musicbrainz',
    }));

  return {
    id: rg.id,
    title: rg.title,
    type: rg['primary-type'] || 'Release',
    date: release.date || rg['first-release-date'] || '',
    artist: (rg['artist-credit'] || []).map((a) => a.name).join(', '),
    artistCredits: (rg['artist-credit'] || [])
      .filter((a) => a.artist)
      .map((a) => ({ mbid: a.artist.id, name: a.artist.name })),
    label: (release['label-info'] || []).map((l) => l.label && l.label.name).filter(Boolean).join(', '),
    coverArtUrl: `${CAA_ROOT}/release-group/${rg.id}/front-250`,
    genres,
    tracks,
    releaseCredits,
    // A lookup lists at most 25 releases, so this tops out at 25: enough to tell
    // a one-off tribute record from a classic that's been reissued many times.
    releaseCount: releases.length,
  };
}
