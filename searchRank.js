// Album search ranking. Searching "Pet Sounds" should put the Beach Boys album
// first, not a tribute record; "Born to Run" should be Springsteen, not a
// same-titled single by someone else. Score = how well the words match, plus how
// well-known the album is (number of releases on MusicBrainz, visits here, how
// many albums the artist has in the database), minus tribute/karaoke/demo signs.

export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(q) {
  return norm(q).split(' ').filter(Boolean);
}

const VARIANT_RE = /\b(working version|demos?|karaoke|tribute|instrumentals?|remix(es)?|live|sessions|outtakes|bootleg|reimagined|covers?|acoustic|a cappella|8 bit|lullaby|lullabies|rehearsals?|unplugged|in the style of|made famous)\b/;
const COPYCAT_ARTIST_RE = /\b(tribute|karaoke|rip ?off|cover band|covers|salute|lullaby|string quartet|vitamin string|piano players|sound ?alike|made famous|in the style of|wedding band|party band|experience|orchestra plays|ensemble plays|re ?creation)\b/;

function words(s) {
  return new Set(norm(s).split(' ').filter(Boolean));
}

// How well the query matches the title (and artist, for "pet sounds beach boys").
export function matchScore(q, a) {
  const nq = norm(q);
  const title = norm(a.title);
  const artist = norm(a.artist);
  if (!nq) return 0;
  if (title === nq) return 100;
  const qt = tokens(q);
  const tw = words(a.title);
  const aw = words(a.artist);
  // Title words + artist words together cover the query, and the title is fully named.
  const inTitle = qt.filter((t) => tw.has(t));
  const rest = qt.filter((t) => !tw.has(t));
  if (inTitle.length && rest.length && rest.every((t) => aw.has(t)) && [...tw].every((w) => qt.includes(w))) return 98;
  if (title.startsWith(`${nq} `)) return 70;
  if (qt.every((t) => tw.has(t))) return 60;
  if (title.includes(nq)) return 50;
  if (inTitle.length && rest.every((t) => aw.has(t))) return 45;
  if (artist === nq) return 40;
  if (qt.every((t) => aw.has(t))) return 30;
  return 10;
}

function log2(n) {
  return Math.log2(1 + Math.max(0, Number(n) || 0));
}

export function popularity(a) {
  return Math.min(30, log2(a.releaseCount) * 5)
    + Math.min(15, log2(a.views) * 3)
    + Math.min(15, log2(a.artistAlbums) * 4)
    + (a.coverArtUrl ? 2 : 0)
    + ((a.type || 'Album') === 'Album' ? 4 : 0);
}

export function penalty(q, a) {
  const nq = norm(q);
  let p = 0;
  const title = norm(a.title);
  const m = title.match(VARIANT_RE);
  if (m && !nq.includes(m[0])) p += 25;
  const artist = norm(a.artist);
  const c = artist.match(COPYCAT_ARTIST_RE);
  if (c && !nq.includes(c[0])) p += 35;
  if (artist === 'various artists' && !nq.includes('various')) p += 10;
  return p;
}

export function scoreAlbum(q, a) {
  return matchScore(q, a) + popularity(a) - penalty(q, a);
}

export function rankAlbums(q, list) {
  return list
    .map((a, i) => ({ a, s: scoreAlbum(q, a), i }))
    .sort((x, y) => y.s - x.s || String(x.a.date || '9999').localeCompare(String(y.a.date || '9999')) || x.i - y.i)
    .map((x) => x.a);
}

// True when the list already has something that looks like the album meant.
// An exact match only counts if it looks well known (several releases, an artist
// with many albums here, or real visits): "Hotel California" by a covers act is
// an exact title match, but not the album people mean.
export function hasStrongMatch(q, list) {
  return list.some((a) => matchScore(q, a) >= 98 && penalty(q, a) === 0
    && (a.known === true || (a.releaseCount || 0) >= 5));
}

// Strip ranking-only fields before sending results to the browser.
export function publicAlbum({ releaseCount, known, ...a }) {
  return a;
}
