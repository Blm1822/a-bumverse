#!/usr/bin/env node
// Backfill: retroactively fetches each artist's MusicBrainz type (Person vs
// Group/Orchestra/etc) and life-span (birth/death dates), for artists saved
// before that existed (see life_span_checked_at in db.js) - most of these
// are stub rows created straight from track credits (session musicians,
// songwriters) that were never individually looked up on import. Powers "In
// Memoriam" (inMemoriam in db.js); the type check is what keeps a band's
// breakup from ever being mistaken for a member's death, since a Group
// artist's life-span.ended just means "no longer active".
//
// Same running pattern as scripts/backfill.js: meant to run once per boot as
// the last step of launchSeedImports, resuming wherever it left off.
//
// Usage: node scripts/backfill-lifespan.js

import { artistsNeedingLifespanCheck, countArtistsNeedingLifespanCheck, setArtistLifespan, stats } from '../db.js';
import { getArtistDetail } from '../mb.js';

const BATCH_SIZE = 50;

async function backfillOne(row) {
  try {
    const detail = await getArtistDetail(row.id);
    const diedDate = detail.type === 'Person' && detail.ended ? detail.endDate : null;
    setArtistLifespan(row.id, { type: detail.type, bornDate: detail.bornDate, diedDate });
    console.log(`  + ${row.name} (${row.views} views)${diedDate ? ` - died ${diedDate}` : ''}`);
  } catch (err) {
    // Best-effort, same as scripts/backfill.js: mark it checked anyway so a
    // permanently-broken/removed mbid doesn't get retried forever.
    setArtistLifespan(row.id);
    console.log(`  ! ${row.name}: ${err.message} (marked done, won't retry)`);
  }
}

const totalRemaining = countArtistsNeedingLifespanCheck();
console.log(`Artist life-span backfill starting: ${totalRemaining} artist(s) need checking.`);

let processed = 0;
while (true) {
  const batch = artistsNeedingLifespanCheck(BATCH_SIZE);
  if (!batch.length) break;
  for (const row of batch) {
    await backfillOne(row);
    processed++;
  }
  console.log(`  ...${processed} processed, ${countArtistsNeedingLifespanCheck()} remaining`);
}

console.log(`Artist life-span backfill run complete: ${processed} artist(s) checked.`);
console.log('Database totals:', stats());
