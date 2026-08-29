#!/usr/bin/env node
// Bulk importer: looks artists up on MusicBrainz and pulls their studio
// albums/EPs (tracklists + writer + performer credits) into our own DB.
//
// Usage:
//   node scripts/import.js "Ozzy Osbourne" "Black Sabbath"
//   node scripts/import.js --file artists.txt
//   node scripts/import.js "Ozzy Osbourne" --all      (include live/comp/etc)
//   node scripts/import.js "Ozzy Osbourne" --types Album,EP,Single

import fs from 'node:fs';
import { upsertArtist, upsertAlbum, albumExists, stats } from '../db.js';
import { searchArtist, getArtistReleaseGroups, getAlbumDetail } from '../mb.js';

const EXCLUDED_SECONDARY_TYPES = new Set([
  'Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street',
  'Demo', 'Interview', 'Audiobook', 'Spokenword',
]);

async function importArtist(name, { includeAll, types }) {
  console.log(`\n=== ${name} ===`);
  const artist = await searchArtist(name);
  if (!artist) {
    console.log('  not found on MusicBrainz, skipping');
    return { added: 0, skipped: 0, failed: 0 };
  }
  upsertArtist(artist);
  console.log(`  matched: ${artist.name}${artist.disambiguation ? ` (${artist.disambiguation})` : ''} [${artist.mbid}]`);

  const releaseGroups = await getArtistReleaseGroups(artist.mbid);
  const filtered = releaseGroups.filter((rg) => {
    if (!types.includes(rg.primaryType)) return false;
    if (includeAll) return true;
    return !rg.secondaryTypes.some((t) => EXCLUDED_SECONDARY_TYPES.has(t));
  });
  console.log(`  ${releaseGroups.length} release groups on MusicBrainz, ${filtered.length} match filters`);

  let added = 0, skipped = 0, failed = 0;
  for (const rg of filtered) {
    if (albumExists(rg.id)) {
      skipped++;
      continue;
    }
    try {
      const detail = await getAlbumDetail(rg.id);
      upsertAlbum(detail, [artist.mbid]);
      added++;
      console.log(`  + ${detail.title} (${detail.date || 'n/a'}) - ${detail.tracks.length} tracks`);
    } catch (err) {
      failed++;
      console.log(`  ! failed: ${rg.title} - ${err.message}`);
    }
  }
  console.log(`  ${name}: ${added} added, ${skipped} already had, ${failed} failed`);
  return { added, skipped, failed };
}

function parseArgs(argv) {
  const includeAll = argv.includes('--all');
  const rest = argv.filter((a) => a !== '--all');

  let types = ['Album', 'EP'];
  const typesIdx = rest.indexOf('--types');
  if (typesIdx !== -1) {
    types = rest[typesIdx + 1].split(',').map((s) => s.trim());
    rest.splice(typesIdx, 2);
  }

  let names = rest;
  const fileIdx = rest.indexOf('--file');
  if (fileIdx !== -1) {
    const filePath = rest[fileIdx + 1];
    names = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  }

  return { names, includeAll, types };
}

const { names, includeAll, types } = parseArgs(process.argv.slice(2));

if (!names.length) {
  console.log('Usage:');
  console.log('  node scripts/import.js "Artist One" "Artist Two"');
  console.log('  node scripts/import.js --file artists.txt');
  console.log('  node scripts/import.js "Artist" --all              (include live/comp/remix releases)');
  console.log('  node scripts/import.js "Artist" --types Album,EP,Single');
  process.exit(1);
}

const totals = { added: 0, skipped: 0, failed: 0 };
for (const name of names) {
  const r = await importArtist(name, { includeAll, types });
  totals.added += r.added;
  totals.skipped += r.skipped;
  totals.failed += r.failed;
}

console.log(`\nImport run complete: ${totals.added} added, ${totals.skipped} already in db, ${totals.failed} failed.`);
console.log('Database totals:', stats());
