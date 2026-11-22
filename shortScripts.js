// Credits-themed YouTube Shorts: the wording and picks, kept pure so they can be tested
// without rendering video. youtubeShort.js supplies the data and does the rendering.
//
//   person  "Albums you didn't know Mutt Lange produced"  (from person_credits)
//   album   "Who played on Rumours?"                       (from an album's credits)

export const CAA = 'https://coverartarchive.org';
const cover = (rgId) => `${CAA}/release-group/${rgId}/front-500`;

function list(xs) {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const strip = (t) => String(t || '').replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim();

// A person's best story: the category with the most albums across different artists,
// told through up to 4 albums by 4 different artists.
export function personShort(person, groups, siteUrl) {
  const verbs = { producer: 'produced', songwriter: 'wrote songs on', performer: 'played on', arrangement: 'arranged', engineering: 'engineered' };
  const usable = (groups || [])
    .filter((g) => verbs[g.key])
    .map((g) => {
      const seen = new Set();
      const picks = [];
      // albums before singles, then oldest first: the classics people recognise
      const items = [...g.items].sort((a, b) => (a.type === 'Album' ? 0 : 1) - (b.type === 'Album' ? 0 : 1)
        || String(a.date || '9999').localeCompare(String(b.date || '9999')));
      for (const it of items) {
        const by = String(it.by || '').trim();
        if (!by || by.toLowerCase() === String(person.name).toLowerCase() || seen.has(by.toLowerCase())) continue;
        seen.add(by.toLowerCase());
        picks.push(it);
        if (picks.length === 4) break;
      }
      return { g, picks };
    })
    .filter((x) => x.picks.length >= 3)
    .sort((a, b) => b.g.count - a.g.count);
  if (!usable.length) return null;
  const { g, picks } = usable[0];
  const verb = verbs[g.key];
  const total = new Set(groups.flatMap((x) => x.items.map((i) => i.id))).size;
  const name = person.name;
  const parts = picks.map((p) => `${strip(p.title)} for ${p.by}`);
  return {
    hook: `${name}\n${verb} these?`,
    title: `Albums you didn't know ${name} ${verb}`.slice(0, 95),
    subtitle: picks.map((p) => strip(p.title)).slice(0, 3).join(' · '),
    narration: `${name} ${verb} ${list(parts)}. That's ${total} albums of credits. See them all on Albumverse.`,
    imageUrls: picks.map((p) => cover(p.id)),
    contentType: 'person_credits_yt',
    itemId: person.id,
    url: `${siteUrl}/artist/${person.id}?ref=yt`,
  };
}

// "Who played on X?": producers, two or three musicians with instruments, writers.
export function albumShort(album, groups, siteUrl, personImages = []) {
  const g = (k) => (groups || []).find((x) => x.key === k)?.people || [];
  const main = (people) => people.filter((p) => !(p.roles || []).every((r) => /assist|executive|associate|additional|coordinat/i.test(r)));
  const producers = main(g('producers')).slice(0, 2).map((p) => p.name);
  const writers = g('writers').slice(0, 3).map((p) => p.name);
  const musicians = g('musicians')
    .filter((p) => (p.roles || []).length)
    .slice(0, 3)
    .map((p) => `${p.name} on ${String(p.roles[0]).replace(/^(lead |background |backing )/, '')}`);
  if ((producers.length ? 1 : 0) + (writers.length ? 1 : 0) + (musicians.length ? 1 : 0) < 2) return null;
  const year = String(album.date || '').slice(0, 4);
  const lines = [`Who played on ${album.title} by ${album.artist}?`];
  if (producers.length) lines.push(`Produced by ${list(producers)}.`);
  if (musicians.length) lines.push(`${list(musicians)}.`);
  if (writers.length) lines.push(`Written by ${list(writers)}.`);
  lines.push('Every credit is on Albumverse.');
  return {
    hook: 'Who played\non this?',
    title: `Who played on ${album.title}?`.slice(0, 95),
    subtitle: `${album.artist}${year ? ` · ${year}` : ''}`,
    narration: lines.join(' '),
    imageUrls: [album.coverArtUrl, ...personImages].filter(Boolean).slice(0, 4),
    contentType: 'album_credits_yt',
    itemId: album.id,
    url: `${siteUrl}/album/${album.id}?ref=yt`,
  };
}

// Which format today: rotate so the channel isn't one note.
export function rotation(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((date.getTime() - start) / 86400000);
  const order = ['person', 'album', 'on_this_day'];
  const i = day % order.length;
  return [...order.slice(i), ...order.slice(0, i)];
}
