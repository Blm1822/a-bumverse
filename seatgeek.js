// Optional: real upcoming tour dates for an artist, from SeatGeek's Platform
// API. Until now the "Find tickets" link on an artist page was just a blind
// SeatGeek search - this replaces it with actual shows (venue, city, date)
// when SeatGeek has any on file, same "enrich if we can, degrade to what we
// had before if we can't" shape as discogs.js.
//
// Entirely best-effort: no SEATGEEK_CLIENT_ID, no matching events, or any
// failure just means no upcoming-shows list for that artist - the page falls
// back to the generic search link, never an error for the caller.
//
// NOTE: written against SeatGeek's documented Platform API v2 shape from
// memory - this repo's sandbox has no network access to verify field names
// against the live API, so the very first real request against a live
// SEATGEEK_CLIENT_ID is worth spot-checking (e.g. via the server logs) once
// one's actually set, in case a field name has since changed.
//
// Same disk-persisted-cache shape as mb.js/discogs.js, reusing the same
// cache table since it's just URL -> JSON either way.

import { getCachedResponse, setCachedResponse } from './db.js';

const SEATGEEK_ROOT = 'https://api.seatgeek.com/2';
// Tour listings don't change minute to minute, and this is a "nice to have"
// enrichment, not something worth spending API quota refreshing constantly.
const CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const REQUEST_SPACING_MS = 1500;

let queue = Promise.resolve();

function seatgeekFetch(url) {
  const cached = getCachedResponse(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const run = async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SeatGeek ${res.status} for ${url}`);
    const data = await res.json();
    setCachedResponse(url, data, CACHE_TTL_MS);
    return data;
  };

  const result = queue.then(run);
  queue = result.catch(() => {}).then(() => new Promise((r) => setTimeout(r, REQUEST_SPACING_MS)));
  return result;
}

// SeatGeek's own affiliate redirect mechanics vary by program - once
// approved, confirm the actual tracking param/domain SeatGeek's affiliate
// dashboard specifies and adjust this if it differs from a simple query param.
function withAffiliateTag(url) {
  if (!url || !process.env.SEATGEEK_AFFILIATE_ID) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}aid=${encodeURIComponent(process.env.SEATGEEK_AFFILIATE_ID)}`;
}

// Exact (case-insensitive) performer-name match only - the /events search is
// a general text search and can surface tribute acts or loosely-related
// events for a fuzzy artist name, which would be actively misleading here.
function performerMatches(event, artistName) {
  const target = artistName.trim().toLowerCase();
  return (event.performers || []).some((p) => p.name && p.name.trim().toLowerCase() === target);
}

export async function getUpcomingShows(artistName, limit = 5) {
  if (!process.env.SEATGEEK_CLIENT_ID) return [];
  try {
    const params = new URLSearchParams({
      q: artistName,
      type: 'concert',
      'datetime_utc.gte': new Date().toISOString(),
      sort: 'datetime_utc.asc',
      per_page: String(limit * 3), // fetch extra since some get filtered by performerMatches
      client_id: process.env.SEATGEEK_CLIENT_ID,
    });
    const data = await seatgeekFetch(`${SEATGEEK_ROOT}/events?${params}`);
    return (data.events || [])
      .filter((e) => performerMatches(e, artistName))
      .slice(0, limit)
      .map((e) => ({
        date: e.datetime_local ? e.datetime_local.slice(0, 10) : null,
        venue: e.venue ? e.venue.name : null,
        city: e.venue ? [e.venue.city, e.venue.state].filter(Boolean).join(', ') : null,
        url: withAffiliateTag(e.url),
      }))
      .filter((s) => s.date && s.venue && s.url);
  } catch (err) {
    console.error('SeatGeek lookup failed for', artistName, ':', err.message);
    return [];
  }
}
