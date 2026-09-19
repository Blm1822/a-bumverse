// Faster death-detection for In Memoriam. The MusicBrainz-based recheck (see
// LIFESPAN_RECHECK_DAYS in db.js) works, but MusicBrainz's own crowd-edited
// data can take weeks to record a death after the fact. Wikidata is usually
// updated within hours for anyone notable enough to have a MusicBrainz
// artist page - and its items for musicians almost always carry the
// MusicBrainz artist ID (P434) as an identifier alongside date of death
// (P570), so this queries for exactly that combination and matches straight
// against this app's own mbid column - no fuzzy name matching needed.
//
// Best-effort, same shape as every other optional integration here: no
// network access, an empty result, or a failed request just means nothing
// updates this cycle - never an error that could take down the scheduler.
// Runs independently of MusicBrainz's rate-limited budget entirely (a
// different host, a handful of requests a day), so it needs no coordination
// with the import/backfill chain in server.js.

import { setArtistDeathFromExternalSource } from './db.js';
import { checkAndPostDaily } from './socialPoster.js';
import { checkAndPostShort } from './youtubeShort.js';

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'Albumverse/0.3.0 (music database project; contact: none)';
// Generous window - rechecking the same already-recorded death costs nothing
// (setArtistDeathFromExternalSource no-ops once died_date already matches),
// so a wide net just means never missing one to a slow Wikidata edit.
const LOOKBACK_DAYS = 90;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours

function buildQuery() {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return `SELECT ?mbid ?dod WHERE {
    ?person wdt:P434 ?mbid .
    ?person wdt:P570 ?dod .
    FILTER(?dod >= "${cutoff}"^^xsd:dateTime)
  }`;
}

export async function fetchRecentDeaths() {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(buildQuery())}&format=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
  });
  if (!res.ok) throw new Error(`Wikidata SPARQL ${res.status}`);
  const data = await res.json();
  return data.results.bindings.map((b) => ({
    mbid: b.mbid.value,
    diedDate: b.dod.value.slice(0, 10),
  }));
}

// Exported so /admin/check-deaths-now (server.js) can trigger this on
// demand instead of waiting up to CHECK_INTERVAL_MS for the next scheduled
// pass - useful right after manually importing an artist whose death is
// already public knowledge but wasn't in the library yet to be checked.
export async function checkForDeaths() {
  try {
    const deaths = await fetchRecentDeaths();
    const newlyMarked = [];
    for (const { mbid, diedDate } of deaths) {
      if (setArtistDeathFromExternalSource(mbid, diedDate)) {
        newlyMarked.push({ mbid, diedDate });
        console.log(`Wikidata death check: ${mbid} died ${diedDate}`);
      }
    }
    if (newlyMarked.length) {
      console.log(`Wikidata death check: ${newlyMarked.length} artist(s) newly marked`);
      // Don't wait for the posters' own hourly timers to happen to tick -
      // a freshly-flagged death is exactly the case worth posting about
      // same-day rather than up to an hour late. Both functions already
      // re-check hasPostedToday/hasPostedAboutItem themselves, so calling
      // them here just means "check right now" - never a duplicate post.
      await checkAndPostDaily().catch((err) => console.error('immediate Bluesky post check failed:', err.message));
      await checkAndPostShort().catch((err) => console.error('immediate YouTube post check failed:', err.message));
    }
    return { checked: deaths.length, newlyMarked };
  } catch (err) {
    console.error('Wikidata death check failed:', err.message);
    return { error: err.message };
  }
}

export function startWikidataDeathCheck() {
  checkForDeaths();
  setInterval(checkForDeaths, CHECK_INTERVAL_MS).unref();
}
