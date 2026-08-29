// Optional second data source. MusicBrainz's performer credits are much less
// consistently filled in than Discogs' (see README) - once an album is saved
// from MusicBrainz, we try to find the same release on Discogs and pull its
// extra credits (producer, engineer, session musicians, ...) in as a
// supplementary "additional credits" list on the album page.
//
// Entirely best-effort: no DISCOGS_TOKEN, no match, or any failure just means
// no extra credits for that album - never an error for the caller. Discogs
// matching is a plain artist+title text search (Discogs isn't keyed by
// MusicBrainz id), so a wrong or missing match is expected sometimes; that's
// an acceptable cost for a supplementary, non-essential lookup.
//
// Same disk-persisted-cache + serialized-queue shape as mb.js, reusing the
// same cache table since it's just URL -> JSON either way. Discogs allows
// 60 req/min with a token, 25/min without - paced conservatively here so an
// import run stays well under either.

import { getCachedResponse, setCachedResponse } from './db.js';

const DISCOGS_ROOT = 'https://api.discogs.com';
const USER_AGENT = 'Albumverse/0.3.0 (music database project; contact: none)';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // release data barely changes - cache a full day.
const REQUEST_SPACING_MS = 2500;

let queue = Promise.resolve();

function authHeaders() {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (process.env.DISCOGS_TOKEN) headers.Authorization = `Discogs token=${process.env.DISCOGS_TOKEN}`;
  return headers;
}

function discogsFetch(url) {
  const cached = getCachedResponse(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const run = async () => {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Discogs ${res.status} for ${url}`);
    const data = await res.json();
    setCachedResponse(url, data, CACHE_TTL_MS);
    return data;
  };

  const result = queue.then(run);
  queue = result.catch(() => {}).then(() => new Promise((r) => setTimeout(r, REQUEST_SPACING_MS)));
  return result;
}

// Best-guess match: search by "<artist> <title>", take the first release
// result. Returns [] (never throws) on no match, no token issues, or any
// network/API failure.
export async function findDiscogsCredits(artist, title) {
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const searchUrl = `${DISCOGS_ROOT}/database/search?q=${q}&type=release&per_page=1&page=1`;
    const search = await discogsFetch(searchUrl);
    const hit = (search.results || [])[0];
    if (!hit || !hit.id) return [];

    const releaseUrl = `${DISCOGS_ROOT}/releases/${hit.id}`;
    const release = await discogsFetch(releaseUrl);
    return (release.extraartists || [])
      .filter((a) => a.name && a.role)
      .map((a) => ({ name: a.name, role: a.role, source: 'discogs' }));
  } catch (err) {
    console.error('Discogs lookup failed for', `${artist} - ${title}`, ':', err.message);
    return [];
  }
}
