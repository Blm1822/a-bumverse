#!/usr/bin/env node
// Backfill: retroactively fetches genre + Discogs credit data for albums
// imported before that enrichment existed (see the enriched_at column in
// db.js's migration block). Processes most-viewed-first (see
// albumsNeedingEnrichment) so limited API throughput goes toward what
// visitors are actually looking at, not an arbitrary slice of the library.
//
// This is meant to run forever in the background on the server (see
// launchSeedImports in server.js) - not a one-off task you babysit to
// completion. At MusicBrainz's ~1 req/1.3s pace, backfilling a large
// existing library can take days, same order of magnitude as the initial
// import. It's idempotent and cheap to resume: each run just picks up
// whatever's still unenriched.
//
// Usage: node scripts/backfill.js

import {
  albumsNeedingEnrichment,
  countAlbumsNeedingEnrichment,
  getAlbumArtistMbids,
  upsertAlbum,
  setAlbumCredits,
  markEnriched,
  stats,
} from '../db.js';
import { getAlbumDetail } from '../mb.js';
import { findDiscogsCredits } from '../discogs.js';

const BATCH_SIZE = 50;

async function backfillOne(row) {
  try {
    const artistMbids = getAlbumArtistMbids(row.id);
    const detail = await getAlbumDetail(row.id);
    upsertAlbum(detail, artistMbids);
    const discogsCredits = await findDiscogsCredits(detail.artist, detail.title);
    if (discogsCredits.length) setAlbumCredits(row.id, discogsCredits);
    markEnriched(row.id);
    console.log(`  + ${row.title} (${row.views} views)${discogsCredits.length ? `, ${discogsCredits.length} Discogs credits` : ''}`);
  } catch (err) {
    // Best-effort: mark it done anyway so a permanently-broken/removed
    // release-group doesn't get retried forever, burning API budget on
    // nothing. That album just stays without genre/Discogs data - same
    // outcome as MusicBrainz genuinely having none for it.
    markEnriched(row.id);
    console.log(`  ! ${row.title}: ${err.message} (marked done, won't retry)`);
  }
}

const totalRemaining = countAlbumsNeedingEnrichment();
console.log(`Backfill starting: ${totalRemaining} album(s) need enrichment.`);

let processed = 0;
while (true) {
  const batch = albumsNeedingEnrichment(BATCH_SIZE);
  if (!batch.length) break;
  for (const row of batch) {
    await backfillOne(row);
    processed++;
  }
  console.log(`  ...${processed} processed, ${countAlbumsNeedingEnrichment()} remaining`);
}

console.log(`Backfill run complete: ${processed} album(s) enriched.`);
console.log('Database totals:', stats());
