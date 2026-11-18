// The homepage's data (/api/home): what people are looking up, a person spotlight, two
// credits stories, and what came out on this day. Built from live data and cached for
// 10 minutes, so the homepage stays fast and changes through the day.

import { stats, topPeople, peopleForShort, albumsForCreditsShort, getArtistLocal, getAlbumLocal,
  getPersonCredits, onThisDayAlbums } from './db.js';
import { personCreditGroups, personSummary, knownFor, summarizeCredits } from './credits.js';

const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, data: null };

function dayIndex(date = new Date()) {
  return Math.floor(date.getTime() / 86400000);
}

function list(xs) {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function personCard(id) {
  const person = getArtistLocal(id);
  if (!person) return null;
  person.creditGroups = personCreditGroups(person, getPersonCredits(id));
  const s = personSummary(person);
  return { person, s };
}

// Short role line for lists: "Guitar, songwriter · The Used"
function roleLineOf(id) {
  const c = personCard(id);
  if (!c) return '';
  const line = c.s.roleLine;
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : '';
}

// Classical and other long-dead composers show up as "songwriters" on dozens of
// albums (Vivaldi on 23). True, but not who the homepage is about: keep them out
// of the spotlight and stories (their pages and search are unaffected).
const OLD_MASTER_RE = /\b(baroque|classical(?:-era)? composer|romantic(?:-era)? composer|opera composer|renaissance composer|composer of the (?:baroque|classical|romantic))\b/i;
export function isOldMaster(person) {
  const born = parseInt(String(person?.bornDate || '').slice(0, 4), 10);
  if (born && born < 1900) return true;
  const died = parseInt(String(person?.diedDate || '').slice(0, 4), 10);
  if (died && died < 1950) return true;
  const text = `${person?.disambiguation || ''} ${String(person?.bio || '').slice(0, 300)}`;
  if (OLD_MASTER_RE.test(text)) return true;
  // Wikipedia openings: "Antonio Vivaldi (4 March 1678 – 28 July 1741) was ..."
  const m = String(person?.bio || '').slice(0, 200).match(/\([^)]*?\b(1[0-8]\d\d)\b/);
  return !!m;
}

export function pickSpotlight(candidates, today = new Date()) {
  if (!candidates.length) return null;
  return candidates[dayIndex(today) % candidates.length];
}

function spotlight(rich) {
  const pick = pickSpotlight(rich.slice(0, 10));
  if (!pick) return null;
  const c = personCard(pick.id);
  if (!c) return null;
  const count = (k) => c.person.creditGroups.find((g) => g.key === k)?.count || 0;
  const stats = [
    { label: 'albums credited', value: c.s.nCredits },
    ...['producer', 'songwriter', 'performer']
      .map((k) => ({ k, n: count(k) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 2)
      .map((x) => ({ label: { producer: 'as producer', songwriter: 'as songwriter', performer: 'as musician' }[x.k], value: x.n })),
  ];
  const label = { producer: 'Producer spotlight', songwriter: 'Songwriter spotlight', performer: 'Musician spotlight' }[c.person.creditGroups[0]?.key] || 'Spotlight';
  return {
    id: c.person.id, name: c.person.name, label,
    roleLine: c.s.roleLine ? c.s.roleLine.charAt(0).toUpperCase() + c.s.roleLine.slice(1) : '',
    stats, knownFor: knownFor(c.s, 4),
  };
}

export function songwriterStory(person, groups) {
  const g = groups.find((x) => x.key === 'songwriter');
  if (!g || g.count < 5) return null;
  const acts = [];
  for (const it of g.items) {
    const by = (it.by || '').trim();
    if (by && !acts.includes(by) && by.toLowerCase() !== person.name.toLowerCase()) acts.push(by);
    if (acts.length === 4) break;
  }
  return {
    kind: 'Songwriter', href: `/artist/${person.id}`, cta: 'See the songs',
    title: `${person.name}’s songs are on ${g.count} albums`,
    text: acts.length >= 2 ? `Recorded by ${list(acts)}.` : '',
  };
}

export function albumStory(album, groups) {
  const producers = (groups.find((g) => g.key === 'producers')?.people || [])
    .filter((p) => !(p.roles || []).every((r) => /assist|executive|associate|additional|coordinat/i.test(r)))
    .slice(0, 3).map((p) => p.name);
  if (!producers.length) return null;
  return {
    kind: 'Who played on', href: `/album/${album.id}`, cta: 'See the credits',
    title: `Who played on ${album.title}?`,
    text: `${album.artist}${album.date ? `, ${String(album.date).slice(0, 4)}` : ''}. Produced by ${list(producers)}. Every musician and writer, track by track.`,
    coverArtUrl: album.coverArtUrl || null,
  };
}

export function buildHome() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  const rich = peopleForShort(40, { unposted: false }).filter((p) => !isOldMaster(getArtistLocal(p.id)));
  const looked = topPeople(7, 6).map((p) => ({ id: p.id, name: p.name, imageUrl: p.imageUrl, roleLine: roleLineOf(p.id) }));
  const chips = (looked.length >= 3 ? looked : rich.slice(0, 6)).map((p) => ({ id: p.id, name: p.name }));
  const spot = spotlight(rich);

  const stories = [];
  for (const p of rich) {
    if (spot && p.id === spot.id) continue;
    const c = personCard(p.id);
    const st = c && songwriterStory(c.person, c.person.creditGroups);
    if (st) { stories.push(st); break; }
  }
  const albums = albumsForCreditsShort(10, { unposted: false });
  if (albums.length) {
    const pick = albums[dayIndex() % albums.length];
    const album = getAlbumLocal(pick.id);
    const st = album && albumStory(album, summarizeCredits(album));
    if (st) stories.push(st);
  }

  const data = {
    albumCount: stats().albums,
    chips,
    spotlight: spot,
    stories,
    mostLooked: looked,
    onThisDay: onThisDayAlbums(4),
  };
  cache = { at: Date.now(), data };
  return data;
}
