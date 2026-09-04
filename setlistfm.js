// Real, dated, crowd-sourced setlists from setlist.fm - what powers the
// poster generator (a specific past show: date, venue, actual songs played),
// since neither MusicBrainz (studio tracklists) nor SeatGeek (upcoming shows
// only) has that. Same best-effort/cached/never-throws shape as
// discogs.js and seatgeek.js.
//
// NOTE: written against setlist.fm's documented REST API (v1.0) shape from
// memory - this sandbox has no network access to verify field names against
// the live API, so the first real request against a live SETLISTFM_API_KEY
// is worth spot-checking in the server logs.

import { getCachedResponse, setCachedResponse } from './db.js';

const SETLISTFM_ROOT = 'https://api.setlist.fm/rest/1.0';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // a past show's setlist doesn't change
const REQUEST_SPACING_MS = 1000;

let queue = Promise.resolve();

function setlistfmFetch(url) {
  const cached = getCachedResponse(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const run = async () => {
    const res = await fetch(url, {
      headers: { 'x-api-key': process.env.SETLISTFM_API_KEY, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`setlist.fm ${res.status} for ${url}`);
    const data = await res.json();
    setCachedResponse(url, data, CACHE_TTL_MS);
    return data;
  };

  const result = queue.then(run);
  queue = result.catch(() => {}).then(() => new Promise((r) => setTimeout(r, REQUEST_SPACING_MS)));
  return result;
}

function mapSetlist(s) {
  const songs = (s.sets && s.sets.set ? s.sets.set : [])
    .flatMap((set) => (set.song || []).map((song) => song.name))
    .filter(Boolean);
  return {
    id: s.id,
    artist: s.artist ? s.artist.name : '',
    date: s.eventDate || '', // setlist.fm's own format: DD-MM-YYYY
    venue: s.venue ? s.venue.name : '',
    city: s.venue && s.venue.city ? s.venue.city.name : '',
    country: s.venue && s.venue.city && s.venue.city.country ? s.venue.city.country.name : '',
    tour: s.tour ? s.tour.name : null,
    songs,
  };
}

// artistName required; date (if given) narrows to one specific show, in
// setlist.fm's own DD-MM-YYYY format - the poster picker UI passes this once
// a visitor has narrowed down to their actual date.
export async function searchSetlists(artistName, { date, page = 1 } = {}) {
  if (!process.env.SETLISTFM_API_KEY || !artistName) return [];
  try {
    const params = new URLSearchParams({ artistName, p: String(page) });
    if (date) params.set('date', date);
    const data = await setlistfmFetch(`${SETLISTFM_ROOT}/search/setlists?${params}`);
    return (data.setlist || [])
      .map(mapSetlist)
      .filter((s) => s.songs.length); // a setlist entry with zero songs logged isn't useful for a poster
  } catch (err) {
    console.error('setlist.fm search failed for', artistName, ':', err.message);
    return [];
  }
}
