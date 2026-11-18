// Album credits, grouped the way people search for them ("who produced X",
// "who played drums on X"). Built from the same album object getAlbumLocal()
// returns: per-track writers/performers (MusicBrainz) + album-level credits
// (Discogs). Used three ways so they always agree: the visible "Credits"
// summary (via /api/album), the server-rendered HTML Google reads without
// running JavaScript, and the page's meta description.

const GROUPS = [
  { key: 'other', label: 'Other credits', re: /coordinat|management|a&r|legal|booking/i },
  { key: 'producers', label: 'Produced by', re: /produc/i },
  { key: 'writers', label: 'Written by', re: /writ|lyric|compos|music by|songwriter/i },
  { key: 'engineering', label: 'Recording, mixing & mastering', re: /engineer|mix|master|record|remaster/i },
  { key: 'arrangement', label: 'Arrangement & conducting', re: /arrang|conduct|orchestrat/i },
  { key: 'artwork', label: 'Artwork & design', re: /photo|design|art direction|artwork|layout|illustrat|cover|sleeve|liner/i },
];
const MUSICIANS = { key: 'musicians', label: 'Musicians' };

// Assistant / executive / associate credits rank after the main ones ("producer" before
// "producer [assistant]"), and aren't the names the description leads with.
const MINOR = /assist|executive|associate|additional|co-|coordinat/i;
function minor(roles) {
  return roles.length && roles.every((r) => MINOR.test(r)) ? 1 : 0;
}

function groupFor(role, fallback) {
  for (const g of GROUPS) if (g.re.test(role || '')) return g;
  return fallback;
}

function add(map, group, person, role, trackNo) {
  if (!person || !person.name) return;
  if (!map.has(group.key)) map.set(group.key, { ...group, people: new Map() });
  const people = map.get(group.key).people;
  const k = person.name.trim().toLowerCase();
  if (!people.has(k)) people.set(k, { name: person.name.trim(), mbid: person.mbid || null, roles: new Set(), tracks: new Set() });
  const p = people.get(k);
  if (role) p.roles.add(String(role).trim().toLowerCase());
  if (trackNo != null) p.tracks.add(trackNo);
  if (!p.mbid && person.mbid) p.mbid = person.mbid;
}

export function summarizeCredits(album) {
  const map = new Map();
  const writersGroup = GROUPS.find((g) => g.key === 'writers');
  for (const t of album?.tracks || []) {
    for (const w of t.writers || []) add(map, writersGroup, w, w.role, t.position);
    for (const p of t.performers || []) add(map, groupFor(p.role, MUSICIANS), p, p.role, t.position);
  }
  for (const c of album?.credits || []) add(map, groupFor(c.role, MUSICIANS), c, c.role, null);

  const order = ['producers', 'writers', 'musicians', 'engineering', 'arrangement', 'artwork', 'other'];
  const nTracks = (album?.tracks || []).length;
  return order
    .filter((k) => map.has(k))
    .map((k) => {
      const g = map.get(k);
      const people = [...g.people.values()]
        .map((p) => ({
          name: p.name,
          mbid: p.mbid,
          roles: [...p.roles].filter(Boolean).slice(0, 4),
          tracks: p.tracks.size,
          allTracks: nTracks > 1 && p.tracks.size === nTracks,
        }))
        .sort((a, b) => minor(a.roles) - minor(b.roles) || b.tracks - a.tracks || a.name.localeCompare(b.name));
      return { key: k, label: g.label, people };
    });
}

function names(groups, key, n) {
  const g = groups.find((x) => x.key === key);
  if (!g) return [];
  const main = g.people.filter((p) => !minor(p.roles));
  return (main.length ? main : g.people).slice(0, n).map((p) => p.name);
}

function list(xs) {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

// "Who wrote, produced and played on Rumours (1977) by Fleetwood Mac. Produced by …; written by …"
export function creditsDescription(album, groups = summarizeCredits(album), max = 158) {
  const year = album?.date ? ` (${String(album.date).slice(0, 4)})` : '';
  let s = `Who wrote, produced and played on ${album.title}${year} by ${album.artist}.`;
  const parts = [];
  const prod = names(groups, 'producers', 2);
  const writ = names(groups, 'writers', 3);
  const mus = names(groups, 'musicians', 3);
  if (prod.length) parts.push(`Produced by ${list(prod)}`);
  if (writ.length) parts.push(`written by ${list(writ)}`);
  if (mus.length) parts.push(`with ${list(mus)}`);
  if (parts.length) s += ` ${parts.join('; ')}.`;
  s += ' Full track-by-track credits.';
  if (s.length > max) s = s.slice(0, max - 1).replace(/[\s,;.]+\S*$/, '') + '…';
  return s;
}

export function creditsTitle(album) {
  return `${album.title} by ${album.artist}: Credits & Personnel`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Plain HTML for the server-rendered page: crawlers see the credits in the
// first response. The front end removes this block and renders the same data.
export function creditsHtml(album, groups = summarizeCredits(album)) {
  const person = (p) => {
    const who = p.mbid ? `<a href="/artist/${esc(p.mbid)}">${esc(p.name)}</a>` : esc(p.name);
    const roles = p.roles.length ? ` <span class="role">(${esc(p.roles.join(', '))})</span>` : '';
    return `<li>${who}${roles}</li>`;
  };
  const sections = groups
    .map((g) => `<h3>${esc(g.label)}</h3><ul>${g.people.slice(0, 40).map(person).join('')}</ul>`)
    .join('');
  const tracks = (album.tracks || [])
    .map((t) => {
      const w = (t.writers || []).map((x) => esc(x.name)).join(', ');
      const pf = (t.performers || []).map((x) => `${esc(x.name)}${x.role ? ` (${esc(x.role)})` : ''}`).join(', ');
      return `<li>${esc(t.position)}. ${esc(t.title)}${w ? ` — written by ${w}` : ''}${pf ? `; performed by ${pf}` : ''}</li>`;
    })
    .join('');
  return `<article class="ssr-album">
  <h1>${esc(album.title)} credits</h1>
  <p>${esc(album.artist)}${album.date ? ` · ${esc(album.date)}` : ''}${album.label ? ` · ${esc(album.label)}` : ''}</p>
  ${sections || '<p>No credits recorded yet.</p>'}
  ${tracks ? `<h2>Track-by-track credits</h2><ol>${tracks}</ol>` : ''}
</article>`;
}

// ---------------------------------------------------------------- people (artist pages)
// Most of Albumverse's Google impressions are searches for individual musicians,
// songwriters and producers by name, landing on /artist/ pages. These build the
// role line, title, description and server-rendered HTML for those pages.

const ROLE_ALIASES = [
  [/^(writer|composer|lyricist|songwriter|written-by|written by|music by|lyrics by|composed by)$/, 'songwriter'],
  [/produc/, 'producer'],
  [/engineer|record/, 'engineer'],
  [/mix/, 'mixing'],
  [/master/, 'mastering'],
  [/^(lead vocals|vocals|vocal|voice|backing vocals|background vocals)$/, 'vocals'],
  [/^(performer|instrument|performing orchestra)$/, 'performer'],
  [/guitar/, 'guitar'],
  [/bass/, 'bass'],
  [/drum|percussion/, 'drums'],
  [/keyboard|piano|synth|organ/, 'keyboards'],
  [/vocal/, 'vocals'],
];

export function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase().replace(/\s*[([].*[)\]]$/, '');
  for (const [re, label] of ROLE_ALIASES) if (re.test(r)) return label;
  return r;
}

const CATEGORY_ORDER = ['producer', 'songwriter', 'performer', 'arrangement', 'engineering', 'other'];
const CATEGORY_LABEL = { producer: 'Producer', songwriter: 'Songwriter', performer: 'Musician', arrangement: 'Arranger', engineering: 'Engineering & mixing', other: 'Other' };
const CATEGORY_NOUN = { producer: 'producer', songwriter: 'songwriter', arrangement: 'arranger', engineering: 'engineer' };

// IMDb-style groups: one entry per album per category, newest first, with the person's
// roles and the songs they're credited on. rows = getPersonCredits() (full career from
// MusicBrainz); without them, falls back to the albums already on the site.
export function personCreditGroups(artist, rows) {
  const src = rows && rows.length ? rows : localRows(artist);
  const groups = new Map();
  for (const r of src) {
    const cat = CATEGORY_ORDER.includes(r.category) ? r.category : 'other';
    if (!groups.has(cat)) groups.set(cat, new Map());
    const g = groups.get(cat);
    if (!g.has(r.rgId)) g.set(r.rgId, { id: r.rgId, title: r.rgTitle, type: r.rgType || null, date: r.date || null, by: r.byArtist || r.by || '', roles: new Set(), songs: new Set() });
    const it = g.get(r.rgId);
    if (r.role) it.roles.add(r.role);
    if (r.song) it.songs.add(r.song);
    if (!it.date && r.date) it.date = r.date;
  }
  return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => {
    const items = [...groups.get(c).values()]
      .map((it) => ({ ...it, roles: [...it.roles].slice(0, 4), songs: [...it.songs].slice(0, 6), songCount: it.songs.size }))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return { key: c, label: CATEGORY_LABEL[c], count: items.length, items };
  }).sort((a, b) => b.count - a.count || CATEGORY_ORDER.indexOf(a.key) - CATEGORY_ORDER.indexOf(b.key));
}

function localRows(artist) {
  const out = [];
  for (const a of artist?.appearances || []) {
    const roles = (a.roles || []).length ? a.roles : ['performer'];
    for (const role of roles) {
      const n = normalizeRole(role);
      const category = n === 'songwriter' ? 'songwriter' : n === 'producer' ? 'producer'
        : /engineer|mixing|mastering/.test(n) ? 'engineering' : /arrang|conduct/.test(n) ? 'arrangement' : 'performer';
      out.push({ category, role, rgId: a.id, rgTitle: a.title, date: a.date, by: a.artist });
    }
  }
  return out;
}

export function personSummary(artist, groups = artist?.creditGroups || personCreditGroups(artist, null)) {
  const nouns = [];
  // weigh songwriting by songs written, not albums, so a hit songwriter reads as a songwriter
  const weight = (g) => (g.key === 'songwriter' ? g.items.reduce((n, it) => n + Math.max(1, it.songCount || 0), 0) : g.count);
  for (const g of [...groups].sort((a, b) => weight(b) - weight(a))) {
    if (nouns.length >= 2) break;
    if (g.key === 'performer') {
      const counts = new Map();
      for (const it of g.items) for (const r of it.roles) counts.set(normalizeRole(r), (counts.get(normalizeRole(r)) || 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && top[0] !== 'performer') nouns.push(top[0]);
      else nouns.push('musician');
    } else if (CATEGORY_NOUN[g.key]) {
      nouns.push(CATEGORY_NOUN[g.key]);
    }
  }
  const acts = new Map();
  const self = String(artist?.name || '').toLowerCase();
  const albums = new Map();
  for (const g of groups) for (const it of g.items) {
    albums.set(it.id, it);
    const who = (it.by || '').trim();
    if (who && who.toLowerCase() !== self) acts.set(who, (acts.get(who) || 0) + 1);
  }
  const topActs = [...acts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  let roleLine = '';
  if (nouns.length) roleLine = nouns.join(', ') + (topActs[0] ? ` · ${topActs[0]}` : '');
  else if (artist?.disambiguation) roleLine = artist.disambiguation;
  // notable titles: the earliest album with each of their most frequent collaborators
  const notable = [];
  for (const act of topActs.slice(0, 5)) {
    const first = [...albums.values()].filter((a) => a.by === act).sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')))[0];
    if (first && !notable.includes(first.title)) notable.push(first.title);
  }
  for (const a of albums.values()) if (notable.length < 3 && !notable.includes(a.title)) notable.push(a.title);
  const actCounts = [...acts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, albums: n }));
  return { roleLine, topRoles: nouns, topActs, actCounts, nAlbums: (artist?.albums || []).length, nCredits: albums.size, notable, groups };
}

// IMDb "Known for": one defining album with each of their most frequent collaborators
// (albums before singles, earliest first), topped up from the rest of their credits.
export function knownFor(s, n = 4) {
  const items = new Map();
  for (const g of s.groups || []) for (const it of g.items) {
    if (!items.has(it.id)) items.set(it.id, { ...it, category: g.label });
  }
  const all = [...items.values()];
  const rank = (a, b) => (a.type === 'Album' ? 0 : 1) - (b.type === 'Album' ? 0 : 1)
    || String(a.date || '9999').localeCompare(String(b.date || '9999'));
  const out = [];
  for (const act of s.topActs || []) {
    const pick = all.filter((a) => a.by === act).sort(rank)[0];
    if (pick && !out.includes(pick)) out.push(pick);
    if (out.length === n) break;
  }
  for (const a of all.sort(rank)) {
    if (out.length >= n) break;
    if (!out.includes(a)) out.push(a);
  }
  return out.slice(0, n).map((a) => ({ id: a.id, title: a.title, date: a.date, by: a.by, type: a.type, category: a.category,
    coverArtUrl: `https://coverartarchive.org/release-group/${a.id}/front-250` }));
}

const isGroup = (artist) => String(artist?.type || '').toLowerCase() === 'group';

export function personTitle(artist, s = personSummary(artist)) {
  if (isGroup(artist)) return `${artist.name}: Discography & Album Credits`;
  const tries = [];
  if (s.roleLine) tries.push(`${artist.name}: ${s.roleLine} · Credits & Albums`);
  if (s.topRoles.length) tries.push(`${artist.name}: ${s.topRoles.slice(0, 2).join(', ')} · Credits & Albums`);
  if (s.topRoles.length) tries.push(`${artist.name}: ${s.topRoles[0]} · Credits & Albums`);
  tries.push(`${artist.name}: Credits & Albums`);
  return tries.find((t) => t.length <= 70) || tries[tries.length - 1];
}

function titlesOf(list, n) {
  return [...new Set(list.slice().reverse().map((a) => a.title))].slice(0, n);
}

export function personDescription(artist, s = personSummary(artist), max = 158) {
  const name = artist.name;
  let d;
  if (isGroup(artist)) {
    const t = titlesOf(artist.albums || [], 3);
    d = `${name} discography: ${s.nAlbums} album${s.nAlbums === 1 ? '' : 's'}${t.length ? ` including ${list(t)}` : ''}, with full credits for who wrote, produced and played on each.`;
  } else if (s.nCredits) {
    const n = s.nCredits;
    const t = s.notable.slice(0, 3);
    const which = n <= t.length ? `on ${list(t)}` : `on ${n} albums including ${list(t)}`;
    d = `${name}${s.roleLine ? ` (${s.roleLine})` : ''}: credited ${which}. Every album ${name} wrote, produced or played on, with roles.`;
  } else if ((artist.songs || []).length) {
    const n = artist.songs.length;
    const t = artist.songs.slice(-3).reverse().map((x) => `“${x.song}”${x.by ? ` (${x.by})` : ''}`);
    d = `${name}: credited on ${n} song${n === 1 ? '' : 's'} including ${list(t)}. Every song, album and role.`;
  } else if (s.nAlbums) {
    const t = titlesOf(artist.albums || [], 3);
    d = `${name}: ${s.nAlbums} album${s.nAlbums === 1 ? '' : 's'}${t.length ? ` including ${list(t)}` : ''}, with full credits.`;
  } else {
    d = artist.bio ? String(artist.bio) : `${name}: credits and albums on Albumverse.`;
  }
  if (d.length > max) d = d.slice(0, max - 1).replace(/[\s,;.(]+\S*$/, '') + '…';
  return d;
}

export function personHtml(artist, s = personSummary(artist), extras = {}) {
  const yr = (a) => (a.date ? ` (${esc(String(a.date).slice(0, 4))})` : '');
  const known = (extras.knownFor || [])
    .map((a) => `<li><a href="/album/${esc(a.id)}">${esc(a.title)}</a>${a.by ? ` by ${esc(a.by)}` : ''}${yr(a)}</li>`).join('');
  const link = (x) => (x.id ? `<a href="/artist/${esc(x.id)}">${esc(x.name)}</a>` : `<a href="/name/${encodeURIComponent(x.name)}">${esc(x.name)}</a>`);
  const worked = (extras.workedWith || []).map((x) => `<li>${link(x)} (${x.albums} album${x.albums === 1 ? '' : 's'})</li>`).join('');
  const collab = (extras.collaborators || []).map((x) => `<li>${link(x)} (${x.shared} albums together)</li>`).join('');
  const groups = (s.groups || []).map((g) => {
    const items = g.items.slice(0, 150).map((it) => {
      const extra = [it.roles.join(', '), it.songs.length ? `“${it.songs.slice(0, 3).join('”, “')}”${it.songCount > 3 ? ` +${it.songCount - 3}` : ''}` : '']
        .filter(Boolean).join('; ');
      return `<li><a href="/album/${esc(it.id)}">${esc(it.title)}</a>${it.by ? ` by ${esc(it.by)}` : ''}${yr(it)}${extra ? `: ${esc(extra)}` : ''}</li>`;
    }).join('');
    return `<h2>${esc(g.label)} (${g.count})</h2><ul>${items}</ul>`;
  }).join('');
  const albums = (artist.albums || [])
    .map((a) => `<li><a href="/album/${esc(a.id)}">${esc(a.title)}</a>${yr(a)}</li>`).join('');
  const songs = (extras.songs || []).slice(0, 200)
    .map((x) => `<li>“${esc(x.song)}”${x.by ? ` by ${esc(x.by)}` : ''}, from <a href="/album/${esc(x.albumId)}">${esc(x.album)}</a>${yr(x)}: ${esc(x.roles.join(', '))}</li>`).join('');
  const bio = artist.bio ? `<p>${esc(String(artist.bio).slice(0, 700))}</p>` : '';
  return `<article class="ssr-artist">
  <h1>${esc(artist.name)}</h1>
  ${s.roleLine ? `<p>${esc(s.roleLine)}</p>` : ''}
  ${bio}
  ${known ? `<h2>Known for</h2><ul>${known}</ul>` : ''}
  ${groups}
  ${songs ? `<h2>Songs (${(extras.songs || []).length})</h2><ul>${songs}</ul>` : ''}
  ${worked ? `<h2>Worked with</h2><ul>${worked}</ul>` : ''}
  ${collab ? `<h2>Frequent collaborators</h2><ul>${collab}</ul>` : ''}
  ${albums ? `<h2>${isGroup(artist) ? 'Discography' : 'Albums'}</h2><ul>${albums}</ul>` : ''}
</article>`;
}
