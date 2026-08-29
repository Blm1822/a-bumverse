// Lightweight Wikipedia lookup for artist bios + photos. MusicBrainz has no
// biography text, so this fills that gap. No rate limit like MusicBrainz, but
// still identify ourselves and cache results (in the artists table) so we
// only ever hit this once per artist.

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const USER_AGENT = 'Albumverse/0.3.0 (music database project; contact: none)';

// Common-word artist names (Heart, Kiss, Yes, Cream, Rush...) collide with
// unrelated Wikipedia articles. A direct title match isn't trustworthy on its
// own - the extract has to actually read like a musician/band bio.
const MUSIC_KEYWORDS =
  /\bband\b|musician|singer|composer|rapper|songwriter|orchestra|rock group|\bgroup\b|\bduo\b|\btrio\b|vocalist|guitarist|drummer|record label|discography|grammy|debut album|formed in|\brock\b|\bpop\b|\bmetal\b|hip hop|\bjazz\b/i;

export function looksMusical(text) {
  return !!text && MUSIC_KEYWORDS.test(text);
}

async function fetchSummary(title) {
  const url = `${WIKI_SUMMARY}/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.type === 'disambiguation') return null;
  return data;
}

async function searchBestTitle(query) {
  const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const results = (data.query && data.query.search) || [];
  const best = results.find((r) => looksMusical(r.snippet));
  return best ? best.title : null;
}

// `hint` is MusicBrainz's disambiguation string for this artist (e.g. "rock
// band, Ann and Nancy Wilson" for Heart) - folded into the search query when
// the direct title lookup doesn't clearly land on a music-related page.
export async function getArtistBio(name, hint) {
  let summary = await fetchSummary(name);
  if (summary && !looksMusical(summary.extract)) summary = null;

  // Wikipedia's own disambiguation convention for common-word band names
  // (Heart (band), Yes (band), Kiss (band)...) - worth trying directly
  // before falling back to a general search.
  if (!summary) {
    summary = await fetchSummary(`${name} (band)`);
    if (summary && !looksMusical(summary.extract)) summary = null;
  }

  if (!summary) {
    const query = hint ? `${name} ${hint}` : name;
    const title = await searchBestTitle(query);
    if (title) summary = await fetchSummary(title);
    if (summary && !looksMusical(summary.extract)) summary = null;
  }

  if (!summary || !summary.extract) return null;
  return {
    bio: summary.extract,
    imageUrl: summary.thumbnail ? summary.thumbnail.source : null,
    wikiUrl: (summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page) || null,
  };
}
