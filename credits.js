// Album credits, grouped the way people search for them ("who produced X",
// "who played drums on X"). Built from the same album object getAlbumLocal()
// returns: per-track writers/performers (MusicBrainz) + album-level credits
// (Discogs). Used three ways so they always agree: the visible "Credits"
// summary (via /api/album), the server-rendered HTML Google reads without
// running JavaScript, and the page's meta description.

const GROUPS = [
  { key: 'producers', label: 'Produced by', re: /produc/i },
  { key: 'writers', label: 'Written by', re: /writ|lyric|compos|music by|songwriter/i },
  { key: 'engineering', label: 'Recording, mixing & mastering', re: /engineer|mix|master|record|remaster/i },
  { key: 'arrangement', label: 'Arrangement & conducting', re: /arrang|conduct|orchestrat/i },
  { key: 'artwork', label: 'Artwork & design', re: /photo|design|art direction|artwork|layout|illustrat|cover|sleeve|liner/i },
  { key: 'other', label: 'Other credits', re: /management|a&r|coordinat|executive|legal|booking/i },
];
const MUSICIANS = { key: 'musicians', label: 'Musicians' };

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
        .sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name));
      return { key: k, label: g.label, people };
    });
}

function names(groups, key, n) {
  const g = groups.find((x) => x.key === key);
  return g ? g.people.slice(0, n).map((p) => p.name) : [];
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
];

export function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase().replace(/\s*\(.*\)$/, '');
  for (const [re, label] of ROLE_ALIASES) if (re.test(r)) return label;
  return r;
}

export function personSummary(artist) {
  const credited = [...(artist?.albums || []), ...(artist?.appearances || [])];
  const roleAlbums = new Map();
  for (const a of credited) {
    for (const r of new Set((a.roles || []).map(normalizeRole).filter(Boolean))) {
      roleAlbums.set(r, (roleAlbums.get(r) || 0) + 1);
    }
  }
  const topRoles = [...roleAlbums.entries()]
    .filter(([r]) => r !== 'performer' || roleAlbums.size === 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([r]) => r);
  const acts = new Map();
  for (const a of artist?.appearances || []) {
    const who = (a.artist || '').trim();
    if (who && who.toLowerCase() !== String(artist.name).toLowerCase()) acts.set(who, (acts.get(who) || 0) + 1);
  }
  const topActs = [...acts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  let roleLine = '';
  if (topRoles.length) roleLine = topRoles.slice(0, 2).join(', ') + (topActs[0] ? ` · ${topActs[0]}` : '');
  else if (artist?.disambiguation) roleLine = artist.disambiguation;
  return { roleLine, topRoles, topActs, nAlbums: (artist?.albums || []).length, nCredits: (artist?.appearances || []).length };
}

const isGroup = (artist) => String(artist?.type || '').toLowerCase() === 'group';

export function personTitle(artist, s = personSummary(artist)) {
  if (isGroup(artist)) return `${artist.name}: Discography & Album Credits`;
  const t = s.roleLine ? `${artist.name}: ${s.roleLine} · Credits & Albums` : `${artist.name}: Credits & Albums`;
  return t.length <= 70 ? t : `${artist.name}: Credits & Albums`;
}

function titlesOf(list, n) {
  return list.slice().reverse().slice(0, n).map((a) => a.title);
}

export function personDescription(artist, s = personSummary(artist), max = 158) {
  const name = artist.name;
  let d;
  if (isGroup(artist)) {
    const t = titlesOf(artist.albums || [], 3);
    d = `${name} discography: ${s.nAlbums} album${s.nAlbums === 1 ? '' : 's'}${t.length ? ` including ${list(t)}` : ''}, with full credits for who wrote, produced and played on each.`;
  } else if (s.nCredits || s.nAlbums) {
    const all = [...(artist.appearances || []), ...(artist.albums || [])];
    const t = titlesOf(all, 3);
    const n = s.nCredits + s.nAlbums;
    const which = t.length === n ? `on ${list(t)}` : `on ${n} albums including ${list(t)}`;
    d = `${name}${s.roleLine ? ` (${s.roleLine})` : ''}: credited ${which}. Every album ${name} wrote, produced or played on, with roles.`;
  } else {
    d = artist.bio ? String(artist.bio) : `${name}: credits and albums on Albumverse.`;
  }
  if (d.length > max) d = d.slice(0, max - 1).replace(/[\s,;.(]+\S*$/, '') + '…';
  return d;
}

export function personHtml(artist, s = personSummary(artist)) {
  const yr = (a) => (a.date ? ` (${esc(String(a.date).slice(0, 4))})` : '');
  const albums = (artist.albums || [])
    .map((a) => `<li><a href="/album/${esc(a.id)}">${esc(a.title)}</a>${yr(a)}</li>`).join('');
  const credits = (artist.appearances || [])
    .map((a) => `<li><a href="/album/${esc(a.id)}">${esc(a.title)}</a> by ${esc(a.artist || '')}${yr(a)}${(a.roles || []).length ? `: ${esc(a.roles.join(', '))}` : ''}</li>`)
    .join('');
  const bio = artist.bio ? `<p>${esc(String(artist.bio).slice(0, 700))}</p>` : '';
  return `<article class="ssr-artist">
  <h1>${esc(artist.name)}</h1>
  ${s.roleLine ? `<p>${esc(s.roleLine)}</p>` : ''}
  ${bio}
  ${credits ? `<h2>Credits</h2><ul>${credits}</ul>` : ''}
  ${albums ? `<h2>${isGroup(artist) ? 'Discography' : 'Albums'}</h2><ul>${albums}</ul>` : ''}
</article>`;
}
