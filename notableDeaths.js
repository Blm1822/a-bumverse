// Tributes for well-known musicians who aren't on Albumverse yet.
//
// The Wikidata death check (wikidataDeaths.js) only ever matched artists
// already in this database, so when a famous musician who wasn't here died,
// the site and the YouTube channel missed it entirely - and "Remembering ..."
// Shorts are the channel's best format by far. This adds them first: the
// artist, their life span, and a handful of studio albums (so the page and
// the Short have cover art), then the normal death check marks them and the
// posters do the rest.
//
// "Well known" = a Wikipedia article in at least MIN_WIKI_LANGUAGES languages
// (Wikidata sitelinks), which keeps this to people with a real audience.
// Only recent deaths (MAX_AGE_DAYS) - a tribute weeks later isn't timely.
import { getArtistLocal, upsertArtist, setArtistLifespan, upsertAlbum, setAlbumCredits, markSongCredits, markEnriched, albumExists, getAppState, setAppState } from './db.js';
import { getArtistDetail, getArtistReleaseGroups, getAlbumDetail } from './mb.js';
import { addDiscogsCredits } from './trackCredits.js';

export const MIN_WIKI_LANGUAGES = 15;
export const MAX_AGE_DAYS = 14;
const MAX_IMPORTS_PER_CHECK = 3;
const ALBUMS_PER_ARTIST = 10;
const EXCLUDED = new Set(['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Interview', 'Audiobook', 'Spokenword']);
const triedKey = (mbid) => `notable_death_import:${mbid}`;

// Which reported deaths to add: notable, recent, not already here, not tried before.
export function pickNotableMissing(deaths, { exists, tried, now = Date.now() }) {
  const cutoff = new Date(now - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
  const seen = new Set();
  return deaths
    .filter((d) => d.links >= MIN_WIKI_LANGUAGES && d.diedDate >= cutoff && !exists(d.mbid) && !tried(d.mbid))
    .filter((d) => !seen.has(d.mbid) && seen.add(d.mbid))
    .sort((a, b) => b.links - a.links)
    .slice(0, MAX_IMPORTS_PER_CHECK);
}

// Most recent studio albums/EPs first is wrong for a tribute - the classics
// are what people look for - so take them in release order.
export function pickAlbums(releaseGroups) {
  return releaseGroups
    .filter((rg) => ['Album', 'EP'].includes(rg.primaryType) && !rg.secondaryTypes.some((t) => EXCLUDED.has(t)))
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')))
    .slice(0, ALBUMS_PER_ARTIST);
}

export async function importNotableDeaths(deaths, deps = {}) {
  const exists = deps.exists || ((mbid) => !!getArtistLocal(mbid));
  const tried = deps.tried || ((mbid) => !!getAppState(triedKey(mbid)));
  const markTried = deps.markTried || ((mbid) => setAppState(triedKey(mbid), new Date().toISOString()));
  const mb = deps.mb || { getArtistDetail, getArtistReleaseGroups, getAlbumDetail };
  const out = [];
  for (const d of pickNotableMissing(deaths, { exists, tried })) {
    markTried(d.mbid); // one attempt per person, even if MusicBrainz hiccups
    try {
      const detail = await mb.getArtistDetail(d.mbid);
      if (!detail?.name || detail.type === 'Group') continue;
      (deps.upsertArtist || upsertArtist)({ mbid: d.mbid, name: detail.name, disambiguation: detail.disambiguation });
      (deps.setArtistLifespan || setArtistLifespan)(d.mbid, { type: detail.type, bornDate: detail.bornDate, diedDate: detail.endDate || d.diedDate });
      let added = 0;
      for (const rg of pickAlbums(await mb.getArtistReleaseGroups(d.mbid))) {
        if ((deps.albumExists || albumExists)(rg.id)) continue;
        try {
          const album = await mb.getAlbumDetail(rg.id);
          if (deps.saveAlbum) deps.saveAlbum(album, d.mbid);
          else {
            const { albumCredits } = await addDiscogsCredits(album);
            upsertAlbum(album, [d.mbid]);
            if (albumCredits.length) setAlbumCredits(album.id, albumCredits);
            markSongCredits(album.id);
            markEnriched(album.id);
          }
          added++;
        } catch (err) {
          console.error(`notable-death import: album ${rg.title} failed:`, err.message);
        }
      }
      console.log(`Notable death: added ${detail.name} (${d.links} Wikipedia languages, died ${d.diedDate}) with ${added} albums`);
      out.push({ mbid: d.mbid, name: detail.name, albums: added });
    } catch (err) {
      console.error(`notable-death import failed for ${d.mbid}:`, err.message);
    }
  }
  return out;
}
