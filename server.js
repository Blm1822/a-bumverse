import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchLocal, countSearchLocal, getAlbumLocal, albumExists, upsertArtist, upsertAlbum, setAlbumCredits, markEnriched, stats, recentlyAdded, listArtists, getArtistLocal, setArtistBio, sitemapAlbums, sitemapArtists, logPageView, analyticsSummary, featuredArtist, trendingSearches, decadeCounts, albumsByDecade, countAlbumsByDecade, listArtistsPage, countArtistsWithAlbums, recentlyAddedPage, genreCounts, albumsByGenre, similarAlbums, similarArtists, randomAlbumId, trendingAlbums, topRatedAlbums, createUser, getUserByUsername, createSession, getSessionUser, deleteSession, upsertReview, deleteReview, getUserReviewForAlbum, albumRatingSummary, getReviewsForAlbum, countReviewsForAlbum, getPublicUser, getReviewsByUser, countReviewsByUser, recentReviews, onThisDayAlbums, countOnThisDayAlbums, inMemoriam, countInMemoriam, updatePasswordHash, setRecoveryCodeHash, deleteSessionsForUser, deleteOtherSessionsForUser } from './db.js';
import { searchReleaseGroups, getAlbumDetail } from './mb.js';
import { findDiscogsCredits } from './discogs.js';
import { getUpcomingShows } from './seatgeek.js';
import { getArtistBio, looksMusical } from './wiki.js';
import { hashPassword, verifyPassword, generateSessionToken, generateRecoveryCode, hashRecoveryCode, verifyRecoveryCode } from './auth.js';

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
//
// Once every seed file is caught up (fast on a warm library, since the
// import script skips albums already saved), the chain moves on to
// scripts/backfill.js (genre/Discogs data for albums saved before that
// enrichment existed) and then scripts/backfill-lifespan.js (artist
// type/birth/death, for "In Memoriam"). On a large library these can each
// run for a very long time (same order of magnitude as the initial import),
// which is fine: it's one background stream, still never in parallel with
// the seed imports above, and it just resumes wherever it left off on the
// next deploy restart.
function launchSeedImports() {
  if (!process.env.DATA_DIR) return;
  const files = ['artists.txt', 'artists_expansion.txt', 'artists_expansion_2.txt'];

  function runScript(args, onExit) {
    const child = spawn('node', args, { cwd: __dirname, stdio: 'inherit' });
    child.on('error', (err) => console.error(`background job (${args.join(' ')}) failed to start:`, err.message));
    child.on('exit', onExit);
  }

  function runNext(i) {
    if (i >= files.length) {
      runScript(['scripts/backfill.js'], () => {
        runScript(['scripts/backfill-lifespan.js'], () => {});
      });
      return;
    }
    runScript(['scripts/import.js', '--file', files[i]], () => runNext(i + 1));
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

// --- Accounts: a hand-rolled cookie session, not a library (express-session
// et al.), since the project already leans on nothing-but-express+node:crypto
// for the analytics Basic Auth above - this is the same pattern applied to
// visitor accounts. res.cookie()/res.clearCookie() are native Express, so the
// only thing missing is reading an incoming Cookie header back out, hence the
// small parser below instead of adding cookie-parser as a dependency. ---

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookieOptions(req) {
  return { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_TTL_MS, path: '/' };
}

// Every request gets a cheap, indexed session lookup so req.user is available
// wherever it's needed (review posting, the /api/auth/me check) without every
// route re-parsing cookies itself.
app.use((req, res, next) => {
  const token = parseCookies(req).av_session;
  req.user = token ? getSessionUser(token) : null;
  next();
});

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}

function validateSignup(username, password) {
  if (!USERNAME_RE.test(username || '')) {
    return 'Username must be 3-20 characters: letters, numbers, underscore only.';
  }
  return validatePassword(password);
}

// Tighter than the general apiLimiter (which is really about not starving
// MusicBrainz) - this specifically bounds password-guessing attempts per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts - try again in a few minutes.' },
});

app.post('/api/auth/signup', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const error = validateSignup(username, password);
  if (error) return res.status(400).json({ error });
  if (getUserByUsername(username)) return res.status(409).json({ error: 'That username is already taken.' });

  const recoveryCode = generateRecoveryCode();
  const userId = createUser(username, hashPassword(password), hashRecoveryCode(recoveryCode));
  const token = generateSessionToken();
  createSession(userId, token, SESSION_TTL_MS);
  res.cookie('av_session', token, sessionCookieOptions(req));
  // recoveryCode is only ever sent here (and on reset/regenerate below) -
  // it's not stored anywhere retrievable, only its hash, so this is the
  // visitor's one chance to see and save it.
  res.json({ id: userId, username, recoveryCode });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const user = getUserByUsername(username || '');
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = generateSessionToken();
  createSession(user.id, token, SESSION_TTL_MS);
  res.cookie('av_session', token, sessionCookieOptions(req));
  res.json({ id: user.id, username: user.username });
});

// No email to send a reset link through, so the recovery code from signup
// (or the last regenerate) is the proof of ownership instead. Success
// rotates the code (single-use, like backup 2FA codes) and signs out every
// other session for this account, same as a "someone reset your password"
// security posture would - deliberately doesn't set a new session cookie
// itself, so a recovered account still has to sign in explicitly afterward.
app.post('/api/auth/reset-password', authLimiter, (req, res) => {
  const { username, recoveryCode, newPassword } = req.body || {};
  const error = validatePassword(newPassword);
  if (error) return res.status(400).json({ error });

  const user = getUserByUsername(username || '');
  if (!user || !verifyRecoveryCode(recoveryCode || '', user.recovery_code_hash)) {
    return res.status(401).json({ error: 'Invalid username or recovery code.' });
  }

  updatePasswordHash(user.id, hashPassword(newPassword));
  deleteSessionsForUser(user.id);
  const newRecoveryCode = generateRecoveryCode();
  setRecoveryCodeHash(user.id, hashRecoveryCode(newRecoveryCode));
  res.json({ ok: true, recoveryCode: newRecoveryCode });
});

// Lets an already-signed-in visitor get a fresh code - either because they
// lost the original, or (for accounts created before recovery codes
// existed) because they never had one to begin with.
app.post('/api/auth/recovery-code/regenerate', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const recoveryCode = generateRecoveryCode();
  setRecoveryCodeHash(req.user.id, hashRecoveryCode(recoveryCode));
  res.json({ recoveryCode });
});

// The normal, "I just want to rotate my password" path - separate from
// /api/auth/reset-password, which exists for when you're locked out
// entirely. This one proves identity with the current password (not a
// recovery code) and, unlike a reset, leaves the session making the change
// signed in rather than clearing every session.
app.post('/api/auth/change-password', authLimiter, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const { currentPassword, newPassword } = req.body || {};
  const error = validatePassword(newPassword);
  if (error) return res.status(400).json({ error });

  const user = getUserByUsername(req.user.username);
  if (!verifyPassword(currentPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  updatePasswordHash(user.id, hashPassword(newPassword));
  const currentToken = parseCookies(req).av_session;
  deleteOtherSessionsForUser(user.id, currentToken);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).av_session;
  if (token) deleteSession(token);
  res.clearCookie('av_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json(req.user || null);
});

// Public profile - anyone's rating history, no auth required to view it
// (only to post one). Username, not id, in the URL since that's what's
// human-shareable and what review rows link to.
app.get('/api/user/:username', (req, res) => {
  const user = getPublicUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(user);
});

app.get('/api/user/:username/reviews', (req, res) => {
  const user = getPublicUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  res.json({ results: getReviewsByUser(user.id, 20, offset), total: countReviewsByUser(user.id) });
});

// Fast, local-only, no MusicBrainz fallback - unlike /api/search this is
// meant to be called on every keystroke, so it can never afford the live
// lookup's multi-second retry path.
app.get('/api/suggest', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  res.json({ results: searchLocal(q, 8) });
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  if (!q) return res.json({ results: [], total: 0 });

  const local = searchLocal(q, 24, offset);

  // Only the true first page ever merges in a live MusicBrainz search, and
  // only when local results are thin - MusicBrainz's own result set doesn't
  // compose with our local offset, so every later page (and any page once
  // local coverage is decent) is local-only with an exact DB-backed total,
  // which is what "load more" needs to know when to stop.
  if (offset === 0 && local.length < LOCAL_RESULT_FLOOR) {
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
      return res.json({ results: merged, total: merged.length });
    } catch (err) {
      console.error('live search failed', err.message);
      // MusicBrainz hiccup shouldn't break search entirely - fall back to what we have locally.
    }
  }

  res.json({ results: local, total: countSearchLocal(q) });
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
    const discogsCredits = await findDiscogsCredits(detail.artist, detail.title);
    if (discogsCredits.length) setAlbumCredits(mbid, discogsCredits);
    markEnriched(mbid);
    res.json(getAlbumLocal(mbid));
  } catch (err) {
    console.error('live album lookup failed', mbid, err.message);
    res.status(502).json({ error: 'Could not fetch this album from MusicBrainz right now. Try again shortly.' });
  }
});

app.get('/api/album/:mbid/similar', (req, res) => {
  const { mbid } = req.params;
  if (!MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Not a valid album id.' });
  }
  const album = getAlbumLocal(mbid);
  if (!album) return res.status(404).json({ error: 'Album not in the database.' });
  res.json({ results: similarAlbums(mbid, album.genres, 12) });
});

app.get('/api/album/:mbid/reviews', (req, res) => {
  const { mbid } = req.params;
  if (!MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Not a valid album id.' });
  }
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const yourReview = req.user ? getUserReviewForAlbum(req.user.id, mbid) : null;
  res.json({ results: getReviewsForAlbum(mbid, 20, offset), total: countReviewsForAlbum(mbid), yourReview });
});

// Rate limited well below authLimiter's brute-force bound - this just keeps
// one visitor from spamming reviews, not guarding a secret.
const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reviews submitted - try again later.' },
});

app.post('/api/album/:mbid/review', reviewLimiter, (req, res) => {
  const { mbid } = req.params;
  if (!MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Not a valid album id.' });
  }
  if (!req.user) return res.status(401).json({ error: 'Sign in to rate this album.' });
  if (!albumExists(mbid)) return res.status(404).json({ error: 'Album not in the database.' });

  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 10.' });
  }
  const body = String(req.body?.body || '').trim().slice(0, 4000);
  upsertReview(req.user.id, mbid, rating, body);
  res.json({ ok: true, rating: albumRatingSummary(mbid) });
});

app.delete('/api/album/:mbid/review', (req, res) => {
  const { mbid } = req.params;
  if (!MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Not a valid album id.' });
  }
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  deleteReview(req.user.id, mbid);
  res.json({ ok: true, rating: albumRatingSummary(mbid) });
});

app.get('/api/stats', (req, res) => {
  res.json(stats());
});

// Public, non-secret site config the frontend needs at runtime - keeps
// affiliate tags an env var away instead of hardcoded/rebuilt into the JS
// (there's no build step to inject them at deploy time otherwise).
app.get('/api/config', (req, res) => {
  res.json({ amazonAssociateTag: process.env.AMAZON_ASSOCIATE_TAG || null });
});

app.get('/api/recent', (req, res) => {
  res.json({ results: recentlyAdded(14) });
});

app.get('/api/artists', (req, res) => {
  res.json({ results: listArtists(18, { random: true }) });
});

app.get('/api/featured', (req, res) => {
  res.json(featuredArtist() || {});
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

app.get('/api/trending-albums', (req, res) => {
  res.json({ results: trendingAlbums(20) });
});

app.get('/api/top-rated', (req, res) => {
  res.json({ results: topRatedAlbums(20) });
});

app.get('/api/recent-reviews', (req, res) => {
  res.json({ results: recentReviews(12) });
});

app.get('/api/on-this-day', (req, res) => {
  res.json({ results: onThisDayAlbums(8), label: todayLabel() });
});

app.get('/api/on-this-day/all', (req, res) => {
  const { limit, offset } = pageParams(req);
  res.json({ results: onThisDayAlbums(limit, offset), total: countOnThisDayAlbums(), label: todayLabel() });
});

app.get('/api/in-memoriam', (req, res) => {
  res.json({ results: inMemoriam(8) });
});

app.get('/api/in-memoriam/all', (req, res) => {
  const { limit, offset } = pageParams(req);
  res.json({ results: inMemoriam(limit, offset), total: countInMemoriam() });
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
  const { limit, offset } = pageParams(req);
  res.json({ results: albumsByDecade(decade, limit, offset), total: countAlbumsByDecade(decade) });
});

app.get('/api/genres', (req, res) => {
  res.json({ results: genreCounts() });
});

// Query-string genre ("?name=") rather than a path segment - genre names can
// contain spaces, "&", "/" (e.g. "Drum & Bass", "Folk/Americana") which would
// otherwise collide with route/path parsing.
app.get('/api/genre', (req, res) => {
  const genre = (req.query.name || '').trim();
  if (!genre) return res.status(400).json({ error: 'Not a valid genre.' });
  res.json({ results: albumsByGenre(genre) });
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

app.get('/api/artist/:mbid/similar', (req, res) => {
  const { mbid } = req.params;
  if (!MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Not a valid artist id.' });
  }
  if (!getArtistLocal(mbid)) return res.status(404).json({ error: 'Artist not in the database.' });
  res.json({ results: similarArtists(mbid, 12) });
});

// Separate from the main artist fetch (like /similar above) so a slow or
// missing SeatGeek lookup never holds up the rest of the page. Deceased
// artists (see the In Memoriam feature) never get a real lookup - showing
// "upcoming shows" for someone who's died would be worse than showing
// nothing, not just pointless.
app.get('/api/artist/:mbid/shows', async (req, res) => {
  const { mbid } = req.params;
  if (!MBID_RE.test(mbid)) {
    return res.status(400).json({ error: 'Not a valid artist id.' });
  }
  const artist = getArtistLocal(mbid);
  if (!artist) return res.status(404).json({ error: 'Artist not in the database.' });
  if (artist.diedDate) return res.json({ results: [] });
  res.json({ results: await getUpcomingShows(artist.name) });
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}
// UTC explicitly, not server-local time - SQLite's own `datetime('now')`
// (what the on-this-day queries match against) is always UTC, so the label
// has to use the same clock or it could name a different day than the data
// actually matches near a local-midnight boundary.
function todayLabel() {
  const now = new Date();
  return `${MONTH_NAMES[now.getUTCMonth()]} ${ordinal(now.getUTCDate())}`;
}

// ISO 8601 duration (e.g. "PT4M56S") - the format schema.org's MusicRecording
// duration property expects.
function isoDuration(ms) {
  if (!ms) return undefined;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `PT${m}M${s}S`;
}

// Structured data so search engines can show rich results (cover art, track
// listings, artist info) instead of a plain blue link - meaningfully better
// SEO than the og:/twitter: meta tags alone, which only control how a link
// looks when *shared*, not how it's indexed.
function albumJsonLd(req, album) {
  const url = `${req.protocol}://${req.get('host')}/album/${album.id}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'MusicAlbum',
    name: album.title,
    url,
    byArtist: (album.artists || []).map((a) => ({ '@type': 'MusicGroup', name: a.name })),
    datePublished: album.date || undefined,
    image: album.coverArtUrl || undefined,
    genre: (album.genres || []).length ? album.genres : undefined,
    numTracks: (album.tracks || []).length || undefined,
    aggregateRating: album.rating && album.rating.count ? {
      '@type': 'AggregateRating',
      ratingValue: album.rating.average,
      ratingCount: album.rating.count,
      bestRating: 10,
      worstRating: 1,
    } : undefined,
    track: (album.tracks || []).map((t) => ({
      '@type': 'MusicRecording',
      name: t.title,
      duration: isoDuration(t.length),
    })),
  };
}

function artistJsonLd(req, artist) {
  const url = `${req.protocol}://${req.get('host')}/artist/${artist.id}`;
  const isPerson = artist.type === 'Person';
  return {
    '@context': 'https://schema.org',
    '@type': isPerson ? 'Person' : 'MusicGroup',
    name: artist.name,
    url,
    description: artist.bio || undefined,
    image: artist.coverArtUrl || undefined,
    sameAs: artist.wikiUrl ? [artist.wikiUrl] : undefined,
    birthDate: isPerson ? artist.bornDate || undefined : undefined,
    deathDate: isPerson ? artist.diedDate || undefined : undefined,
  };
}

function renderIndexWithMeta(req, { title, description, image, jsonLd }) {
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
    // Escape "<" so a title/bio containing a literal "</script>" (album
    // titles are free text, bios are scraped from Wikipedia) can't break out
    // of the script tag early - JSON.stringify alone doesn't escape "/".
    jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : '',
  ].join('\n    ');
  html = html.replace('<title>Albumverse</title>', `<title>${safeTitle} — Albumverse</title>\n    ${tags}`);
  return html;
}

app.get('/album/:mbid', (req, res) => {
  logView(req, null);
  const album = MBID_RE.test(req.params.mbid) ? getAlbumLocal(req.params.mbid) : null;
  if (!album) return res.sendFile(indexHtmlPath);
  const description = `${album.artist} · ${album.type}${album.date ? ' · ' + album.date : ''} — tracklist, writers, and performers on Albumverse.`;
  res.send(renderIndexWithMeta(req, { title: album.title, description, image: album.coverArtUrl, jsonLd: albumJsonLd(req, album) }));
});

app.get('/artist/:mbid', (req, res) => {
  logView(req, null);
  const artist = MBID_RE.test(req.params.mbid) ? getArtistLocal(req.params.mbid) : null;
  if (!artist) return res.sendFile(indexHtmlPath);
  const description = artist.bio ? artist.bio.slice(0, 200) : `${artist.name} - discography on Albumverse.`;
  res.send(renderIndexWithMeta(req, { title: artist.name, description, image: artist.coverArtUrl, jsonLd: artistJsonLd(req, artist) }));
});

app.get('/user/:username', (req, res) => {
  logView(req, null);
  const user = USERNAME_RE.test(req.params.username) ? getPublicUser(req.params.username) : null;
  if (!user) return res.sendFile(indexHtmlPath);
  res.send(renderIndexWithMeta(req, {
    title: `${user.username}'s reviews`,
    description: `${user.username}'s ratings and reviews on Albumverse.`,
  }));
});

// Real server-side redirect, not a client-side SPA route - works with no
// JS, and a 302 to the actual canonical album URL means Google never has a
// non-deterministic "/random" page to try to index.
app.get('/random', (req, res) => {
  const id = randomAlbumId();
  res.redirect(id ? `/album/${id}` : '/');
});

app.get('/trending', (req, res) => {
  logView(req, null);
  res.send(renderIndexWithMeta(req, {
    title: 'Trending this week',
    description: 'The most-viewed albums on Albumverse this week.',
  }));
});

app.get('/top-rated', (req, res) => {
  logView(req, null);
  res.send(renderIndexWithMeta(req, {
    title: 'Top rated albums',
    description: 'The highest user-rated albums on Albumverse.',
  }));
});

app.get('/on-this-day', (req, res) => {
  logView(req, null);
  const label = todayLabel();
  res.send(renderIndexWithMeta(req, {
    title: `On this day: ${label}`,
    description: `Albums first released on ${label} across music history, on Albumverse.`,
  }));
});

app.get('/in-memoriam', (req, res) => {
  logView(req, null);
  res.send(renderIndexWithMeta(req, {
    title: 'In Memoriam',
    description: "Musicians in Albumverse's database whose MusicBrainz profile records that they've passed away, most recent first.",
  }));
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

app.get('/genre', (req, res) => {
  const genre = (req.query.name || '').trim();
  logView(req, genre || null);
  if (!genre) return res.sendFile(indexHtmlPath);
  res.send(renderIndexWithMeta(req, {
    title: genre,
    description: `${genre} albums on Albumverse.`,
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

// Fixed-length digest comparison so a wrong guess can't be timed byte-by-byte
// - crypto.timingSafeEqual itself requires equal-length buffers, which a raw
// header string comparison wouldn't guarantee.
function safeEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(a).digest();
  const bufB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

// Gated by ANALYTICS_PASSWORD so this is opt-in rather than breaking local
// dev (where it's typically unset) - but it MUST be set in production, since
// this page has no other protection and shows real traffic/search data.
function requireAnalyticsAuth(req, res, next) {
  const password = process.env.ANALYTICS_PASSWORD;
  if (!password) return next();

  const expected = 'Basic ' + Buffer.from(`admin:${password}`).toString('base64');
  const auth = req.headers.authorization;
  if (auth && safeEqual(auth, expected)) return next();

  res.set('WWW-Authenticate', 'Basic realm="Albumverse Analytics"');
  res.status(401).send('Authentication required.');
}

// Internal-only traffic dashboard. Not linked from the site nav, not part of
// the SPA - a plain server-rendered page since this is a tool for us, not visitors.
app.get('/analytics', requireAnalyticsAuth, (req, res) => {
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
    <p style="color: #6b6584; font-size: 12px; margin-top: 10px;">
      All numbers above are human traffic only (bots/crawlers filtered out by user-agent).
      Separately: ${s.botViewsLast7d} bot views in the last 7 days, ${s.botViewsTotal} all-time
      &mdash; that's mostly search engines indexing the site, which is a good sign, not a problem.
    </p>
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
