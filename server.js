import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchLocal, getAlbumLocal, albumExists, upsertArtist, upsertAlbum, stats, recentlyAdded, listArtists, getArtistLocal, setArtistBio, sitemapAlbums, sitemapArtists, logPageView, analyticsSummary, featuredAlbum, trendingSearches, decadeCounts, albumsByDecade, listArtistsPage, countArtistsWithAlbums, recentlyAddedPage } from './db.js';
import { searchReleaseGroups, getAlbumDetail } from './mb.js';
import { getArtistBio, looksMusical } from './wiki.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const indexHtmlPath = path.join(__dirname, 'public', 'index.html');

// Deploys replace the whole running container, which kills any detached bulk-import
// process from a previous deploy. Rather than depending on someone manually
// re-launching it over SSH, resume the seed imports automatically on every boot -
// the import script is idempotent (skips albums already saved), so this is cheap
// once a given artist's catalog is mostly in. Only runs when DATA_DIR is set
// (i.e. against a real persistent volume) so local dev doesn't auto-hammer MusicBrainz.
//
// Runs the seed files one at a time, not in parallel - two simultaneous import
// processes each pacing their own MusicBrainz calls at ~1.3s meant real live
// visitor searches were getting starved (observed 90s+ hangs on first-time
// album lookups while both were running). One background stream leaves the
// rest of MusicBrainz's budget for actual traffic.
function launchSeedImports() {
  if (!process.env.DATA_DIR) return;
  const files = ['artists.txt', 'artists_expansion.txt'];

  function runNext(i) {
    if (i >= files.length) return;
    const child = spawn('node', ['scripts/import.js', '--file', files[i]], {
      cwd: __dirname,
      stdio: 'inherit',
    });
    child.on('error', (err) => console.error(`seed import (${files[i]}) failed to start:`, err.message));
    child.on('exit', () => runNext(i + 1));
  }

  runNext(0);
}

const LOCAL_RESULT_FLOOR = 6; // below this, also ask MusicBrainz live and merge in what we're missing
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.set('trust proxy', 1); // needed for correct client IPs behind Railway's proxy

// Every request that can fall through to a live MusicBrainz lookup (search misses,
// unknown album ids) burns our shared ~1 req/sec MusicBrainz budget - throttle
// per-IP so one visitor (bot or not) can't starve everyone else's funnel lookups.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests - slow down a bit and try again.' },
});

function logView(req, extraQuery) {
  try {
    logPageView({
      path: req.path,
      query: extraQuery !== undefined ? extraQuery : (Object.keys(req.query).length ? JSON.stringify(req.query) : null),
      referrer: req.get('referer') || null,
      userAgent: req.get('user-agent') || null,
    });
  } catch (err) {
    console.error('page view logging failed', err.message);
  }
}

// Explicit home route, placed before express.static, so we can log the view -
// static's automatic "/" -> index.html serving would otherwise short-circuit
// before any of our own code runs.
app.get('/', (req, res) => {
  logView(req, null);
  res.sendFile(indexHtmlPath);
});

// no-cache (not no-store) - browsers still revalidate via ETag so unchanged
// files serve a cheap 304, but a deploy's new JS/CSS is never served stale.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
app.use(express.json());
app.use('/api/', apiLimiter);

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  const local = searchLocal(q);
  if (local.length >= LOCAL_RESULT_FLOOR) {
    return res.json({ results: local });
  }

  try {
    const live = await searchReleaseGroups(q);
    const seen = new Set(local.map((r) => r.id));
    const merged = [...local];
    for (const r of live) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push({ ...r, inDb: false });
      }
    }
    res.json({ results: merged });
  } catch (err) {
    console.error('live search failed', err.message);
    // MusicBrainz hiccup shouldn't break search entirely - fall back to what we have locally.
    res.json({ results: local });
  }
});

app.get('/api/album/:mbid', async (req, res) => {
  const { mbid } = req.params;
  if (!MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Not a valid album id.' });
  }

  const cached = getAlbumLocal(mbid);
  if (cached) return res.json(cached);

  // Not in our db yet - this is the "funnel": fetch it live from MusicBrainz,
  // save it permanently, and serve it. Next person to look this up gets it instantly.
  try {
    const detail = await getAlbumDetail(mbid);
    const artistMbids = [];
    for (const credit of detail.artistCredits || []) {
      upsertArtist({ mbid: credit.mbid, name: credit.name, disambiguation: null });
      artistMbids.push(credit.mbid);
    }
    upsertAlbum(detail, artistMbids);
    res.json(getAlbumLocal(mbid));
  } catch (err) {
    console.error('live album lookup failed', mbid, err.message);
    res.status(502).json({ error: 'Could not fetch this album from MusicBrainz right now. Try again shortly.' });
  }
});

app.get('/api/stats', (req, res) => {
  res.json(stats());
});

app.get('/api/recent', (req, res) => {
  res.json({ results: recentlyAdded(14) });
});

app.get('/api/artists', (req, res) => {
  res.json({ results: listArtists(18, { random: true }) });
});

app.get('/api/featured', (req, res) => {
  res.json(featuredAlbum() || {});
});

app.get('/api/trending', (req, res) => {
  res.json({ results: trendingSearches(10) });
});

const PAGE_SIZE = 60;
function pageParams(req) {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return { limit: PAGE_SIZE, offset };
}

app.get('/api/artists/all', (req, res) => {
  const { limit, offset } = pageParams(req);
  res.json({ results: listArtistsPage(limit, offset), total: countArtistsWithAlbums() });
});

app.get('/api/recent/all', (req, res) => {
  const { limit, offset } = pageParams(req);
  res.json({ results: recentlyAddedPage(limit, offset), total: stats().albums });
});

app.get('/api/decades', (req, res) => {
  res.json({ results: decadeCounts() });
});

const DECADE_RE = /^\d{4}$/;
app.get('/api/decade/:decade', (req, res) => {
  const decade = Number(req.params.decade);
  if (!DECADE_RE.test(req.params.decade) || decade % 10 !== 0) {
    return res.status(400).json({ error: 'Not a valid decade.' });
  }
  res.json({ results: albumsByDecade(decade) });
});

app.get('/api/artist/:mbid', async (req, res) => {
  const { mbid } = req.params;
  if (!MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Not a valid artist id.' });
  }
  let artist = getArtistLocal(mbid);
  if (!artist) return res.status(404).json({ error: 'Artist not in the database.' });

  // bio === null means we've never looked it up on Wikipedia yet. '' means we
  // tried and found nothing, so don't keep re-hitting Wikipedia on every view.
  // A cached bio that doesn't look musical (e.g. an early lookup for "Heart"
  // landing on the anatomy article) gets treated as never-looked-up so it
  // self-heals on next view instead of staying wrong forever.
  const needsLookup = artist.bio === null || (artist.bio && !looksMusical(artist.bio));
  if (needsLookup) {
    try {
      const found = await getArtistBio(artist.name, artist.disambiguation);
      setArtistBio(mbid, found || { bio: '', imageUrl: null, wikiUrl: null });
      artist = getArtistLocal(mbid);
    } catch (err) {
      console.error('wikipedia bio lookup failed', artist.name, err.message);
    }
  }
  res.json(artist);
});

// --- Real, shareable URLs for albums/artists (SPA routes, server-rendered
// meta tags). Without this every page on the site was the same URL, which
// meant nothing could be bookmarked/shared and Google could never index an
// individual album or artist page - only ever the homepage. ---

function escapeAttr(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderIndexWithMeta(req, { title, description, image }) {
  let html = fs.readFileSync(indexHtmlPath, 'utf8');
  const safeTitle = escapeAttr(title || 'Albumverse');
  const safeDesc = escapeAttr(description || 'A music database - search albums, see who wrote and performed every track.');
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const tags = [
    `<meta property="og:title" content="${safeTitle}" />`,
    `<meta property="og:description" content="${safeDesc}" />`,
    `<meta property="og:type" content="music.album" />`,
    `<meta property="og:url" content="${escapeAttr(url)}" />`,
    image ? `<meta property="og:image" content="${escapeAttr(image)}" />` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="description" content="${safeDesc}" />`,
  ].join('\n    ');
  html = html.replace('<title>Albumverse</title>', `<title>${safeTitle} — Albumverse</title>\n    ${tags}`);
  return html;
}

app.get('/album/:mbid', (req, res) => {
  logView(req, null);
  const album = MBID_RE.test(req.params.mbid) ? getAlbumLocal(req.params.mbid) : null;
  if (!album) return res.sendFile(indexHtmlPath);
  const description = `${album.artist} · ${album.type}${album.date ? ' · ' + album.date : ''} — tracklist, writers, and performers on Albumverse.`;
  res.send(renderIndexWithMeta(req, { title: album.title, description, image: album.coverArtUrl }));
});

app.get('/artist/:mbid', (req, res) => {
  logView(req, null);
  const artist = MBID_RE.test(req.params.mbid) ? getArtistLocal(req.params.mbid) : null;
  if (!artist) return res.sendFile(indexHtmlPath);
  const description = artist.bio ? artist.bio.slice(0, 200) : `${artist.name} - discography on Albumverse.`;
  res.send(renderIndexWithMeta(req, { title: artist.name, description, image: artist.coverArtUrl }));
});

app.get('/artists', (req, res) => {
  logView(req, null);
  res.send(renderIndexWithMeta(req, {
    title: 'Artists',
    description: 'Browse every artist in the Albumverse database.',
  }));
});

app.get('/recent', (req, res) => {
  logView(req, null);
  res.send(renderIndexWithMeta(req, {
    title: 'Recently added',
    description: 'The latest albums added to Albumverse.',
  }));
});

app.get('/decade/:decade', (req, res) => {
  logView(req, null);
  const decade = req.params.decade;
  if (!DECADE_RE.test(decade) || Number(decade) % 10 !== 0) return res.sendFile(indexHtmlPath);
  res.send(renderIndexWithMeta(req, {
    title: `${decade}s`,
    description: `Albums released in the ${decade}s on Albumverse.`,
  }));
});

app.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  logView(req, q || null);
  if (!q) return res.sendFile(indexHtmlPath);
  res.send(renderIndexWithMeta(req, {
    title: `Search: ${q}`,
    description: `Search results for "${q}" on Albumverse.`,
  }));
});

app.get('/sitemap.xml', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const urls = [`<url><loc>${base}/</loc></url>`];
  for (const a of sitemapArtists()) {
    urls.push(`<url><loc>${base}/artist/${a.id}</loc></url>`);
  }
  for (const al of sitemapAlbums()) {
    urls.push(`<url><loc>${base}/album/${al.id}</loc><lastmod>${al.lastmod}</lastmod></url>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${urls.join('\n  ')}\n</urlset>`;
  res.type('application/xml').send(xml);
});

// Internal-only traffic dashboard. Not linked from the site nav, not part of
// the SPA - a plain server-rendered page since this is a tool for us, not visitors.
app.get('/analytics', (req, res) => {
  const s = analyticsSummary();
  const dbStats = stats();
  const row = (label, n) => `<tr><td>${escapeAttr(label)}</td><td>${n}</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <title>Albumverse Analytics</title>
    <style>
      body { font-family: -apple-system, sans-serif; background: #0c0a18; color: #ece9f7; padding: 32px; max-width: 900px; margin: 0 auto; }
      h1 { margin-bottom: 4px; } h2 { margin-top: 32px; color: #a78bfa; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      td { padding: 6px 8px; border-bottom: 1px solid #2c2748; font-size: 14px; }
      .stat-row { display: flex; gap: 32px; margin-top: 12px; }
      .stat { background: #171429; border: 1px solid #2c2748; border-radius: 8px; padding: 16px 20px; }
      .stat .n { font-size: 28px; font-weight: 800; } .stat .l { color: #9d97b8; font-size: 12px; }
    </style></head><body>
    <h1>Albumverse Analytics</h1>
    <div class="stat-row">
      <div class="stat"><div class="n">${s.today}</div><div class="l">views today</div></div>
      <div class="stat"><div class="n">${s.last7d}</div><div class="l">views (7 days)</div></div>
      <div class="stat"><div class="n">${s.totalViews}</div><div class="l">views all-time</div></div>
      <div class="stat"><div class="n">${dbStats.albums.toLocaleString()}</div><div class="l">albums in db</div></div>
    </div>
    <h2>Daily views (last 14 days)</h2>
    <table>${s.dailyCounts.map((d) => row(d.day, d.n)).join('')}</table>
    <h2>Top albums / artists</h2>
    <table>${s.topPages.map((p) => row(p.label || p.path, p.n)).join('') || '<tr><td>No data yet</td></tr>'}</table>
    <h2>Top searches</h2>
    <table>${s.topSearches.map((q) => row(q.query, q.n)).join('') || '<tr><td>No data yet</td></tr>'}</table>
    <h2>Top referrers</h2>
    <table>${s.topReferrers.map((r) => row(r.referrer, r.n)).join('') || '<tr><td>No data yet</td></tr>'}</table>
  </body></html>`;
  res.send(html);
});

app.listen(PORT, () => {
  console.log(`Albumverse running at http://localhost:${PORT}`);
  console.log('Database:', stats());
  launchSeedImports();
});
