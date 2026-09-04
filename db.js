import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets a deploy point this at a mounted persistent volume (e.g. Railway).
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'imudb.sqlite'));
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;'); // server + import script both touch this file concurrently
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS artists (
  mbid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  disambiguation TEXT,
  bio TEXT,
  wiki_image_url TEXT,
  wiki_url TEXT
);

CREATE TABLE IF NOT EXISTS albums (
  mbid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT,
  release_date TEXT,
  artist_credit TEXT,
  label TEXT,
  cover_art_url TEXT,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS album_artists (
  album_mbid TEXT NOT NULL REFERENCES albums(mbid) ON DELETE CASCADE,
  artist_mbid TEXT NOT NULL REFERENCES artists(mbid) ON DELETE CASCADE,
  PRIMARY KEY (album_mbid, artist_mbid)
);

CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_mbid TEXT NOT NULL REFERENCES albums(mbid) ON DELETE CASCADE,
  position INTEGER,
  title TEXT NOT NULL,
  length_ms INTEGER,
  recording_mbid TEXT,
  artist_credit TEXT
);

CREATE TABLE IF NOT EXISTS track_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('writer', 'performer')),
  name TEXT NOT NULL,
  artist_mbid TEXT,
  role TEXT
);

CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  query TEXT,
  referrer TEXT,
  user_agent TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS album_genres (
  album_mbid TEXT NOT NULL REFERENCES albums(mbid) ON DELETE CASCADE,
  genre TEXT NOT NULL,
  PRIMARY KEY (album_mbid, genre)
);

-- Supplementary album-level credits from Discogs (producer, engineer, session
-- musicians, ...) - MusicBrainz's own performer credits are much less
-- consistently filled in (see README), so this is an optional second source
-- shown separately on the album page rather than merged into track_credits,
-- since Discogs' extraartists are album-wide, not tied to a specific track.
CREATE TABLE IF NOT EXISTS album_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_mbid TEXT NOT NULL REFERENCES albums(mbid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'discogs'
);

-- Persisted MusicBrainz response cache. This used to be an in-memory Map in
-- mb.js, which meant every restart (every deploy, per the comment on
-- launchSeedImports below) threw the whole thing away and re-hammered
-- MusicBrainz's ~1req/sec budget for URLs it had *just* fetched. Living in
-- the same DB file survives restarts for free.
CREATE TABLE IF NOT EXISTS mb_cache (
  url TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  recovery_code_hash TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  album_mbid TEXT NOT NULL REFERENCES albums(mbid) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
  body TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, album_mbid)
);

CREATE INDEX IF NOT EXISTS idx_albums_title ON albums(title);
CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_mbid);
CREATE INDEX IF NOT EXISTS idx_credits_track ON track_credits(track_id);
CREATE INDEX IF NOT EXISTS idx_pageviews_created ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_path ON page_views(path);
CREATE INDEX IF NOT EXISTS idx_album_genres_genre ON album_genres(genre);
CREATE INDEX IF NOT EXISTS idx_mb_cache_expires ON mb_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_album_credits_album ON album_credits(album_mbid);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_album ON reviews(album_mbid);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
`);

// Migration for DBs created before added_at existed.
const albumColumns = db.prepare('PRAGMA table_info(albums)').all().map((c) => c.name);
if (!albumColumns.includes('added_at')) {
  db.exec('ALTER TABLE albums ADD COLUMN added_at TEXT;');
  db.exec("UPDATE albums SET added_at = datetime('now') WHERE added_at IS NULL;");
}

// Migration for DBs created before Wikipedia bio columns existed.
const artistColumns = db.prepare('PRAGMA table_info(artists)').all().map((c) => c.name);
for (const col of ['bio', 'wiki_image_url', 'wiki_url']) {
  if (!artistColumns.includes(col)) db.exec(`ALTER TABLE artists ADD COLUMN ${col} TEXT;`);
}

// Migration for DBs created before password-reset recovery codes existed -
// those users simply have none until they sign in and generate one (see
// setRecoveryCodeHash), same "NULL means never set up" pattern as bio above.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('recovery_code_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN recovery_code_hash TEXT;');
}

// Search engines, social-share unfurlers, SEO crawlers, and scripts - "bot"
// is a deliberately broad, case-insensitive net since this only powers
// analytics/popularity signals, not any access control. No user-agent at
// all is unusual for a real browser (default curl/wget/most scripts either
// send none or an obviously non-browser one), so treat that as bot too.
const BOT_UA_RE = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|discordbot|headless|python-requests|scrapy|ahrefs|semrush|mj12bot|dotbot|petalbot|bytespider|ia_archiver|curl\/|wget\/|go-http-client|node-fetch|axios\//i;
function isBotUserAgent(ua) {
  return !ua || BOT_UA_RE.test(ua);
}

// Migration for DBs created before bot-traffic detection existed. Existing
// rows already have their user_agent stored, so retroactively classify them
// with the same logic new rows get, rather than leaving months of history
// stuck assuming every past view was human just because this didn't exist
// yet when they were logged.
if (!db.prepare('PRAGMA table_info(page_views)').all().map((c) => c.name).includes('is_bot')) {
  db.exec('ALTER TABLE page_views ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;');
  db.exec('BEGIN');
  try {
    const rows = db.prepare('SELECT id, user_agent FROM page_views').all();
    const markBot = db.prepare('UPDATE page_views SET is_bot = 1 WHERE id = ?');
    for (const r of rows) {
      if (isBotUserAgent(r.user_agent)) markBot.run(r.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Migration for DBs created before genre/Discogs enrichment existed. NULL
// means "imported before enrichment existed, or enrichment not yet run on
// it" - the backfill script (scripts/backfill.js) works through these.
// Deliberately not re-added to `albumColumns` above/reused here since this
// runs after that block executes.
if (!db.prepare('PRAGMA table_info(albums)').all().map((c) => c.name).includes('enriched_at')) {
  db.exec('ALTER TABLE albums ADD COLUMN enriched_at TEXT;');
}

// One-time (per boot, cheap no-op once caught up) backfill: give every writer/
// performer credited with a MusicBrainz id their own stub artist row, even for
// albums imported before clickable credits existed, so old and new data both
// link through to a real page.
db.exec(`
  INSERT OR IGNORE INTO artists (mbid, name)
  SELECT DISTINCT tc.artist_mbid, tc.name FROM track_credits tc
  WHERE tc.artist_mbid IS NOT NULL
`);

// Both server.js and scripts/import.js import this module, and a purged-on-
// read cache still leaks rows nobody ever reads again once they've expired -
// so purge on boot and on a slow interval too. unref() so the standalone
// import script (which otherwise runs to completion and exits) doesn't get
// held open forever by a timer nothing else needs.
db.prepare('DELETE FROM mb_cache WHERE expires_at < ?').run(Date.now());
setInterval(() => {
  db.prepare('DELETE FROM mb_cache WHERE expires_at < ?').run(Date.now());
}, 10 * 60 * 1000).unref();

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}, 60 * 60 * 1000).unref();

export function getCachedResponse(url) {
  const row = db.prepare('SELECT data, expires_at FROM mb_cache WHERE url = ?').get(url);
  if (!row) return undefined;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM mb_cache WHERE url = ?').run(url);
    return undefined;
  }
  return JSON.parse(row.data);
}

export function setCachedResponse(url, data, ttlMs) {
  db.prepare(
    `INSERT INTO mb_cache (url, data, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
  ).run(url, JSON.stringify(data), Date.now() + ttlMs);
}

export function upsertArtist({ mbid, name, disambiguation }) {
  db.prepare(
    `INSERT INTO artists (mbid, name, disambiguation) VALUES (?, ?, ?)
     ON CONFLICT(mbid) DO UPDATE SET name = excluded.name, disambiguation = excluded.disambiguation`
  ).run(mbid, name, disambiguation || null);
}

export function albumExists(mbid) {
  return !!db.prepare('SELECT 1 FROM albums WHERE mbid = ?').get(mbid);
}

// bio: pass `{ bio: '', imageUrl: null, wikiUrl: null }` when Wikipedia had nothing,
// so we remember not to look it up again on every page view - bio NULL means
// "never attempted", bio '' means "tried, nothing found".
export function setArtistBio(mbid, { bio, imageUrl, wikiUrl }) {
  db.prepare('UPDATE artists SET bio = ?, wiki_image_url = ?, wiki_url = ? WHERE mbid = ?').run(
    bio || '', imageUrl || null, wikiUrl || null, mbid
  );
}

export function upsertAlbum(detail, artistMbids) {
  const insertAlbum = db.prepare(
    `INSERT INTO albums (mbid, title, type, release_date, artist_credit, label, cover_art_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mbid) DO UPDATE SET
       title = excluded.title, type = excluded.type, release_date = excluded.release_date,
       artist_credit = excluded.artist_credit, label = excluded.label, cover_art_url = excluded.cover_art_url`
  );
  insertAlbum.run(detail.id, detail.title, detail.type, detail.date, detail.artist, detail.label, detail.coverArtUrl);

  const linkArtist = db.prepare(
    'INSERT OR IGNORE INTO album_artists (album_mbid, artist_mbid) VALUES (?, ?)'
  );
  for (const artistMbid of artistMbids) linkArtist.run(detail.id, artistMbid);

  // Idempotent re-import: wipe and re-insert this album's tracks/credits.
  const oldTrackIds = db.prepare('SELECT id FROM tracks WHERE album_mbid = ?').all(detail.id).map((r) => r.id);
  if (oldTrackIds.length) {
    const placeholders = oldTrackIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM track_credits WHERE track_id IN (${placeholders})`).run(...oldTrackIds);
    db.prepare('DELETE FROM tracks WHERE album_mbid = ?').run(detail.id);
  }

  db.prepare('DELETE FROM album_genres WHERE album_mbid = ?').run(detail.id);
  const insertGenre = db.prepare('INSERT OR IGNORE INTO album_genres (album_mbid, genre) VALUES (?, ?)');
  for (const genre of detail.genres || []) insertGenre.run(detail.id, genre);

  const insertTrack = db.prepare(
    `INSERT INTO tracks (album_mbid, position, title, length_ms, recording_mbid, artist_credit)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertCredit = db.prepare(
    'INSERT INTO track_credits (track_id, kind, name, artist_mbid, role) VALUES (?, ?, ?, ?, ?)'
  );
  // Session musicians, songwriters, etc. often aren't a main "album artist" but
  // still deserve their own page (e.g. a guest guitarist) - stash a minimal
  // stub row for anyone credited with a known MusicBrainz id. INSERT OR IGNORE
  // so it never clobbers a fuller record (bio, disambiguation) already saved.
  const insertStubArtist = db.prepare('INSERT OR IGNORE INTO artists (mbid, name) VALUES (?, ?)');

  for (const track of detail.tracks) {
    const result = insertTrack.run(
      detail.id, track.position, track.title, track.length || null, track.recordingMbid || null, track.artist || ''
    );
    const trackId = Number(result.lastInsertRowid);
    for (const w of track.writers || []) {
      insertCredit.run(trackId, 'writer', w.name, w.mbid || null, w.role || null);
      if (w.mbid) insertStubArtist.run(w.mbid, w.name);
    }
    for (const p of track.performers || []) {
      insertCredit.run(trackId, 'performer', p.name, p.mbid || null, p.role || null);
      if (p.mbid) insertStubArtist.run(p.mbid, p.name);
    }
  }
}

// Idempotent like the track/genre wipe-and-reinsert above: safe to call again
// on a re-import or a repeat live lookup without accumulating duplicates.
export function setAlbumCredits(albumMbid, credits) {
  db.prepare('DELETE FROM album_credits WHERE album_mbid = ?').run(albumMbid);
  const insert = db.prepare('INSERT INTO album_credits (album_mbid, name, role, source) VALUES (?, ?, ?, ?)');
  for (const c of credits) insert.run(albumMbid, c.name, c.role, c.source || 'discogs');
}

export function getAlbumCredits(albumMbid) {
  return db.prepare('SELECT name, role, source FROM album_credits WHERE album_mbid = ? ORDER BY id ASC').all(albumMbid);
}

export function markEnriched(mbid) {
  db.prepare("UPDATE albums SET enriched_at = datetime('now') WHERE mbid = ?").run(mbid);
}

export function getAlbumArtistMbids(mbid) {
  return db.prepare('SELECT artist_mbid FROM album_artists WHERE album_mbid = ?').all(mbid).map((r) => r.artist_mbid);
}

// Albums imported before genre/Discogs enrichment existed (or not yet
// reached by the backfill), most-viewed first so the backfill's limited
// throughput goes toward what visitors are actually looking at rather than
// working through 14k+ albums in arbitrary order.
export function albumsNeedingEnrichment(limit = 50) {
  return db
    .prepare(
      `SELECT al.mbid as id, al.title, al.artist_credit as artist,
       (SELECT COUNT(*) FROM page_views pv WHERE pv.path = '/album/' || al.mbid AND pv.is_bot = 0) as views
       FROM albums al
       WHERE al.enriched_at IS NULL
       ORDER BY views DESC, al.added_at DESC
       LIMIT ?`
    )
    .all(limit);
}

export function countAlbumsNeedingEnrichment() {
  return db.prepare('SELECT COUNT(*) as n FROM albums WHERE enriched_at IS NULL').get().n;
}

export function searchLocal(query, limit = 24, offset = 0) {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, cover_art_url as coverArtUrl
       FROM albums
       WHERE title LIKE ? COLLATE NOCASE OR artist_credit LIKE ? COLLATE NOCASE
       ORDER BY release_date ASC
       LIMIT ? OFFSET ?`
    )
    .all(like, like, limit, offset);
}

export function countSearchLocal(query) {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT COUNT(*) as n FROM albums
       WHERE title LIKE ? COLLATE NOCASE OR artist_credit LIKE ? COLLATE NOCASE`
    )
    .get(like, like).n;
}

export function recentlyAdded(limit = 12) {
  return db
    .prepare(
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, cover_art_url as coverArtUrl
       FROM albums
       ORDER BY added_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(limit);
}

export function getAlbumLocal(mbid) {
  const album = db
    .prepare(
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, label, cover_art_url as coverArtUrl
       FROM albums WHERE mbid = ?`
    )
    .get(mbid);
  if (!album) return null;

  const artists = db
    .prepare(
      `SELECT a.mbid as id, a.name FROM artists a
       JOIN album_artists aa ON aa.artist_mbid = a.mbid
       WHERE aa.album_mbid = ?`
    )
    .all(mbid);

  const genres = db.prepare('SELECT genre FROM album_genres WHERE album_mbid = ?').all(mbid).map((r) => r.genre);
  const credits = getAlbumCredits(mbid);

  const tracks = db
    .prepare('SELECT id, position, title, length_ms as length, artist_credit as artist FROM tracks WHERE album_mbid = ? ORDER BY position ASC')
    .all(mbid);

  // Only expose a credit as a link if that mbid actually has an artist row
  // (older data imported before stub-artist creation may not).
  const creditStmt = db.prepare(
    `SELECT tc.kind, tc.name, tc.role, tc.artist_mbid as mbid
     FROM track_credits tc
     WHERE tc.track_id = ? AND (tc.artist_mbid IS NULL OR EXISTS (SELECT 1 FROM artists a WHERE a.mbid = tc.artist_mbid))`
  );
  for (const track of tracks) {
    const credits = creditStmt.all(track.id);
    track.writers = credits.filter((c) => c.kind === 'writer').map((c) => ({ name: c.name, role: c.role, mbid: c.mbid }));
    track.performers = credits.filter((c) => c.kind === 'performer').map((c) => ({ name: c.name, role: c.role, mbid: c.mbid }));
    delete track.id;
  }

  return { ...album, artists, genres, credits, tracks, rating: albumRatingSummary(mbid) };
}

// --- Accounts, sessions, ratings & reviews ---

export function createUser(username, passwordHash, recoveryCodeHash) {
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, recovery_code_hash) VALUES (?, ?, ?)'
  ).run(username, passwordHash, recoveryCodeHash);
  return Number(result.lastInsertRowid);
}

// COLLATE NOCASE so "Alice" and "alice" are treated as the same account both
// at lookup time and via the UNIQUE constraint's own default binary collation
// would otherwise miss - sign-up uniqueness checks and login both go through
// this function, so both stay consistent.
export function getUserByUsername(username) {
  return db.prepare('SELECT id, username, password_hash, recovery_code_hash FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

export function updatePasswordHash(userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

export function setRecoveryCodeHash(userId, recoveryCodeHash) {
  db.prepare('UPDATE users SET recovery_code_hash = ? WHERE id = ?').run(recoveryCodeHash, userId);
}

// Reset (and, more generally, any credential change) should kill every
// other session logged in as this user - otherwise a stolen session cookie
// would survive a password reset meant to lock it out.
export function deleteSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function createSession(userId, token, ttlMs) {
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + ttlMs);
}

export function getSessionUser(token) {
  const row = db
    .prepare(
      `SELECT u.id as id, u.username as username, s.expires_at as expiresAt
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, username: row.username };
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function upsertReview(userId, albumMbid, rating, body) {
  db.prepare(
    `INSERT INTO reviews (user_id, album_mbid, rating, body) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, album_mbid) DO UPDATE SET
       rating = excluded.rating, body = excluded.body, updated_at = CURRENT_TIMESTAMP`
  ).run(userId, albumMbid, rating, body || null);
}

export function deleteReview(userId, albumMbid) {
  db.prepare('DELETE FROM reviews WHERE user_id = ? AND album_mbid = ?').run(userId, albumMbid);
}

export function getUserReviewForAlbum(userId, albumMbid) {
  return db.prepare('SELECT rating, body FROM reviews WHERE user_id = ? AND album_mbid = ?').get(userId, albumMbid);
}

export function albumRatingSummary(albumMbid) {
  const row = db.prepare('SELECT COUNT(*) as n, AVG(rating) as avg FROM reviews WHERE album_mbid = ?').get(albumMbid);
  return { count: row.n, average: row.n ? Math.round(row.avg * 10) / 10 : null };
}

export function getReviewsForAlbum(albumMbid, limit = 20, offset = 0) {
  return db
    .prepare(
      `SELECT r.rating as rating, r.body as body, r.updated_at as updatedAt, u.username as username
       FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.album_mbid = ? ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(albumMbid, limit, offset);
}

export function countReviewsForAlbum(albumMbid) {
  return db.prepare('SELECT COUNT(*) as n FROM reviews WHERE album_mbid = ?').get(albumMbid).n;
}

// Separate from getUserByUsername (which returns password_hash for login
// verification) so a public profile lookup can never accidentally leak it.
export function getPublicUser(username) {
  return db.prepare('SELECT id, username, created_at as createdAt FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

export function getReviewsByUser(userId, limit = 20, offset = 0) {
  return db
    .prepare(
      `SELECT r.rating as rating, r.body as body, r.updated_at as updatedAt,
       al.mbid as albumId, al.title as albumTitle, al.artist_credit as albumArtist, al.cover_art_url as albumCoverArtUrl
       FROM reviews r JOIN albums al ON al.mbid = r.album_mbid
       WHERE r.user_id = ? ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(userId, limit, offset);
}

export function countReviewsByUser(userId) {
  return db.prepare('SELECT COUNT(*) as n FROM reviews WHERE user_id = ?').get(userId).n;
}

export function sitemapAlbums() {
  return db.prepare("SELECT mbid as id, substr(added_at, 1, 10) as lastmod FROM albums").all();
}

export function sitemapArtists() {
  return db.prepare('SELECT mbid as id FROM artists').all();
}

export function logPageView({ path: p, query, referrer, userAgent }) {
  db.prepare('INSERT INTO page_views (path, query, referrer, user_agent, is_bot) VALUES (?, ?, ?, ?, ?)').run(
    p, query || null, referrer || null, userAgent || null, isBotUserAgent(userAgent) ? 1 : 0
  );
}

export function analyticsSummary() {
  // Primary numbers are human-only (is_bot = 0) - bot crawl volume is real
  // traffic in the server-load sense but tells you nothing about visitor
  // interest, which is what this dashboard exists to answer. Bot counts are
  // still surfaced separately below so crawl activity (a genuinely useful
  // SEO signal - it means search engines are indexing the site) isn't lost.
  const totalViews = db.prepare('SELECT COUNT(*) as n FROM page_views WHERE is_bot = 0').get().n;
  const today = db.prepare("SELECT COUNT(*) as n FROM page_views WHERE is_bot = 0 AND created_at >= datetime('now', 'start of day')").get().n;
  const last7d = db.prepare("SELECT COUNT(*) as n FROM page_views WHERE is_bot = 0 AND created_at >= datetime('now', '-7 days')").get().n;

  const botViewsLast7d = db.prepare("SELECT COUNT(*) as n FROM page_views WHERE is_bot = 1 AND created_at >= datetime('now', '-7 days')").get().n;
  const botViewsTotal = db.prepare('SELECT COUNT(*) as n FROM page_views WHERE is_bot = 1').get().n;

  const dailyCounts = db
    .prepare(
      `SELECT substr(created_at, 1, 10) as day, COUNT(*) as n
       FROM page_views WHERE is_bot = 0 AND created_at >= datetime('now', '-14 days')
       GROUP BY day ORDER BY day ASC`
    )
    .all();

  const topPages = db
    .prepare(
      `SELECT pv.path as path, COUNT(*) as n, COALESCE(al.title, ar.name) as label
       FROM page_views pv
       LEFT JOIN albums al ON pv.path = '/album/' || al.mbid
       LEFT JOIN artists ar ON pv.path = '/artist/' || ar.mbid
       WHERE pv.is_bot = 0 AND (pv.path LIKE '/album/%' OR pv.path LIKE '/artist/%')
       GROUP BY pv.path ORDER BY n DESC LIMIT 15`
    )
    .all();

  const topSearches = db
    .prepare(
      `SELECT query, COUNT(*) as n FROM page_views
       WHERE is_bot = 0 AND path = '/search' AND query IS NOT NULL AND query != ''
       GROUP BY query ORDER BY n DESC LIMIT 15`
    )
    .all();

  const topReferrers = db
    .prepare(
      `SELECT referrer, COUNT(*) as n FROM page_views
       WHERE is_bot = 0 AND referrer IS NOT NULL AND referrer != ''
       GROUP BY referrer ORDER BY n DESC LIMIT 10`
    )
    .all();

  return { totalViews, today, last7d, botViewsLast7d, botViewsTotal, dailyCounts, topPages, topSearches, topReferrers };
}

// random: true gives a fresh random sample each call instead of a fixed
// top-by-album-count ranking. Without this, artists with huge MusicBrainz
// catalogs by nature (classical composers especially - every orchestra's
// every recording is its own release) permanently bury everyone else on a
// "top artists" rail. A rotating random sample spreads the spotlight around
// and doubles as a discovery feature on repeat visits.
export function listArtists(limit = 200, { random = false } = {}) {
  const order = random ? 'RANDOM()' : 'albumCount DESC, a.name ASC';
  return db
    .prepare(
      `SELECT a.mbid as id, a.name, a.disambiguation, COUNT(aa.album_mbid) as albumCount,
       COALESCE(a.wiki_image_url, (SELECT al.cover_art_url FROM albums al
        JOIN album_artists aa2 ON aa2.album_mbid = al.mbid
        WHERE aa2.artist_mbid = a.mbid AND al.cover_art_url IS NOT NULL
        ORDER BY al.release_date DESC LIMIT 1)) as coverArtUrl
       FROM artists a
       LEFT JOIN album_artists aa ON aa.artist_mbid = a.mbid
       GROUP BY a.mbid
       HAVING albumCount >= 2
       ORDER BY ${order}
       LIMIT ?`
    )
    .all(limit);
}

// Full alphabetical artist listing for the dedicated /artists browse page -
// listArtists() above is the homepage's curated/random sample and stays as is.
export function listArtistsPage(limit = 60, offset = 0) {
  return db
    .prepare(
      `SELECT a.mbid as id, a.name, a.disambiguation, COUNT(aa.album_mbid) as albumCount,
       COALESCE(a.wiki_image_url, (SELECT al.cover_art_url FROM albums al
        JOIN album_artists aa2 ON aa2.album_mbid = al.mbid
        WHERE aa2.artist_mbid = a.mbid AND al.cover_art_url IS NOT NULL
        ORDER BY al.release_date DESC LIMIT 1)) as coverArtUrl
       FROM artists a
       LEFT JOIN album_artists aa ON aa.artist_mbid = a.mbid
       GROUP BY a.mbid
       HAVING albumCount >= 1
       ORDER BY a.name ASC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

export function countArtistsWithAlbums() {
  return db
    .prepare(
      `SELECT COUNT(*) as n FROM (
         SELECT a.mbid FROM artists a
         JOIN album_artists aa ON aa.artist_mbid = a.mbid
         GROUP BY a.mbid
       )`
    )
    .get().n;
}

// Same shape as recentlyAdded() above but with an offset, for the dedicated
// /recent browse page - recentlyAdded() stays as the homepage's fixed sample.
export function recentlyAddedPage(limit = 60, offset = 0) {
  return db
    .prepare(
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, cover_art_url as coverArtUrl
       FROM albums
       ORDER BY added_at DESC, rowid DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

export function getArtistLocal(mbid) {
  const artist = db
    .prepare(
      `SELECT a.mbid as id, a.name, a.disambiguation, a.bio, a.wiki_url as wikiUrl,
       COALESCE(a.wiki_image_url, (SELECT al.cover_art_url FROM albums al
        JOIN album_artists aa2 ON aa2.album_mbid = al.mbid
        WHERE aa2.artist_mbid = a.mbid AND al.cover_art_url IS NOT NULL
        ORDER BY al.release_date DESC LIMIT 1)) as coverArtUrl
       FROM artists a WHERE a.mbid = ?`
    )
    .get(mbid);
  if (!artist) return null;

  const albums = db
    .prepare(
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl
       FROM albums al
       JOIN album_artists aa ON aa.album_mbid = al.mbid
       WHERE aa.artist_mbid = ?
       ORDER BY al.release_date ASC`
    )
    .all(mbid);

  // Albums this person contributed to (wrote or played on) without being a
  // main album artist - e.g. a session musician or a songwriter for hire.
  // Without this, credit links for anyone who isn't themselves a headline
  // artist would land on an empty page.
  const appearances = db
    .prepare(
      `SELECT DISTINCT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl
       FROM albums al
       JOIN tracks t ON t.album_mbid = al.mbid
       JOIN track_credits tc ON tc.track_id = t.id
       WHERE tc.artist_mbid = ?
         AND NOT EXISTS (SELECT 1 FROM album_artists aa WHERE aa.album_mbid = al.mbid AND aa.artist_mbid = ?)
       ORDER BY al.release_date ASC`
    )
    .all(mbid, mbid);

  return { ...artist, albums, appearances };
}

// Most-viewed album in the last 7 days, so the homepage spotlight reflects
// actual visitor interest rather than just whatever imported last. Falls back
// to the newest album once traffic is too thin to have a real "most viewed".
// An album cover is often missing (unofficial/bootleg releases especially
// rarely have Cover Art Archive entries), so a most-viewed-*album* hero can
// land on a flat, colorless spotlight. An artist nearly always has an image
// available - their own Wikipedia photo, or failing that their newest
// album's cover - so feature the artist instead; the underlying image
// fallback here matches listArtists()/getArtistLocal() exactly.
const ARTIST_IMAGE_SQL = `COALESCE(a.wiki_image_url, (
  SELECT al.cover_art_url FROM albums al
  JOIN album_artists aa2 ON aa2.album_mbid = al.mbid
  WHERE aa2.artist_mbid = a.mbid AND al.cover_art_url IS NOT NULL
  ORDER BY al.release_date DESC LIMIT 1
))`;

export function featuredArtist() {
  const topViewed = db
    .prepare(
      `SELECT a.mbid as id, a.name, a.disambiguation, ${ARTIST_IMAGE_SQL} as imageUrl
       FROM page_views pv
       JOIN artists a ON pv.path = '/artist/' || a.mbid
       WHERE pv.is_bot = 0 AND pv.created_at >= datetime('now', '-7 days')
       GROUP BY a.mbid
       HAVING imageUrl IS NOT NULL
       ORDER BY COUNT(pv.id) DESC
       LIMIT 1`
    )
    .get();
  if (topViewed) return topViewed;

  // No traffic yet (or nobody viewed has an image) - random pick among
  // artists that have one, so the hero never shows up blank/colorless.
  return (
    db
      .prepare(
        `SELECT a.mbid as id, a.name, a.disambiguation, ${ARTIST_IMAGE_SQL} as imageUrl
         FROM artists a
         WHERE a.wiki_image_url IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM albums al JOIN album_artists aa2 ON aa2.album_mbid = al.mbid
              WHERE aa2.artist_mbid = a.mbid AND al.cover_art_url IS NOT NULL
            )
         ORDER BY RANDOM()
         LIMIT 1`
      )
      .get() || null
  );
}

// Billboard-style top-N chart for the dedicated /trending page - same
// human-only, last-7-days signal as featuredArtist()/trendingSearches(),
// just returning the ranked list instead of a single winner.
export function trendingAlbums(limit = 20) {
  return db
    .prepare(
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl,
       COUNT(pv.id) as views
       FROM page_views pv
       JOIN albums al ON pv.path = '/album/' || al.mbid
       WHERE pv.is_bot = 0 AND pv.created_at >= datetime('now', '-7 days')
       GROUP BY al.mbid
       ORDER BY views DESC
       LIMIT ?`
    )
    .all(limit);
}

// Requires a minimum number of ratings before an album can appear, same idea
// as IMDb's Top 250 vote floor - without it, a single 10/10 would sit at #1
// forever ahead of albums with a real, larger consensus behind them. Low for
// now since ratings just launched; worth raising once volume grows.
const MIN_RATINGS_FOR_CHART = 3;

export function topRatedAlbums(limit = 20) {
  return db
    .prepare(
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl,
       ROUND(AVG(r.rating), 1) as average, COUNT(r.id) as count
       FROM reviews r
       JOIN albums al ON al.mbid = r.album_mbid
       GROUP BY al.mbid
       HAVING COUNT(r.id) >= ?
       ORDER BY average DESC, count DESC
       LIMIT ?`
    )
    .all(MIN_RATINGS_FOR_CHART, limit);
}

export function trendingSearches(limit = 8) {
  return db
    .prepare(
      `SELECT query, COUNT(*) as n FROM page_views
       WHERE is_bot = 0 AND path = '/search' AND query IS NOT NULL AND query != ''
         AND created_at >= datetime('now', '-7 days')
       GROUP BY query ORDER BY n DESC LIMIT ?`
    )
    .all(limit);
}

// Decades with at least one album, oldest first, so the homepage tiles don't
// show empty decades (e.g. nothing pre-1950 until the classical seed catches up).
export function decadeCounts() {
  return db
    .prepare(
      `SELECT CAST(substr(release_date, 1, 3) || '0' AS INTEGER) as decade, COUNT(*) as n
       FROM albums
       WHERE release_date IS NOT NULL AND length(release_date) >= 4
       GROUP BY decade
       ORDER BY decade ASC`
    )
    .all();
}

export function albumsByDecade(decade, limit = 60, offset = 0) {
  return db
    .prepare(
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, cover_art_url as coverArtUrl
       FROM albums
       WHERE release_date >= ? AND release_date < ?
       ORDER BY title COLLATE NOCASE ASC
       LIMIT ? OFFSET ?`
    )
    .all(String(decade), String(decade + 10), limit, offset);
}

export function countAlbumsByDecade(decade) {
  return db
    .prepare('SELECT COUNT(*) as n FROM albums WHERE release_date >= ? AND release_date < ?')
    .get(String(decade), String(decade + 10)).n;
}

export function genreCounts(limit = 20) {
  return db
    .prepare(
      `SELECT genre, COUNT(DISTINCT album_mbid) as n
       FROM album_genres
       GROUP BY genre
       ORDER BY n DESC, genre ASC
       LIMIT ?`
    )
    .all(limit);
}

// Other albums sharing at least one genre with this one, most-shared-genres
// first (a random tiebreak among equally-relevant matches, so the same few
// albums don't always win the top slots). Empty genres list (album not yet
// enriched) returns [] rather than erroring, matching how every other
// optional-data section on the album page degrades.
export function similarAlbums(albumMbid, genres, limit = 12) {
  if (!genres || !genres.length) return [];
  const placeholders = genres.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl,
       COUNT(DISTINCT ag.genre) as sharedGenres
       FROM albums al
       JOIN album_genres ag ON ag.album_mbid = al.mbid
       WHERE ag.genre IN (${placeholders}) AND al.mbid != ?
       GROUP BY al.mbid
       ORDER BY sharedGenres DESC, RANDOM()
       LIMIT ?`
    )
    .all(...genres, albumMbid, limit);
}

// Other artists whose albums share at least one genre with this artist's own
// (aggregated across their whole discography, not a single album), ranked
// the same way similarAlbums() is - most-shared-genres first, random
// tiebreak. Empty when this artist has no genre data yet.
export function similarArtists(artistMbid, limit = 12) {
  const genres = db
    .prepare(
      `SELECT DISTINCT ag.genre
       FROM album_artists aa
       JOIN album_genres ag ON ag.album_mbid = aa.album_mbid
       WHERE aa.artist_mbid = ?`
    )
    .all(artistMbid)
    .map((r) => r.genre);
  if (!genres.length) return [];

  const placeholders = genres.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT a.mbid as id, a.name, a.disambiguation, COUNT(DISTINCT ag.genre) as sharedGenres,
       ${ARTIST_IMAGE_SQL} as coverArtUrl,
       (SELECT COUNT(*) FROM album_artists aa3 WHERE aa3.artist_mbid = a.mbid) as albumCount
       FROM artists a
       JOIN album_artists aa ON aa.artist_mbid = a.mbid
       JOIN album_genres ag ON ag.album_mbid = aa.album_mbid
       WHERE ag.genre IN (${placeholders}) AND a.mbid != ?
       GROUP BY a.mbid
       ORDER BY sharedGenres DESC, RANDOM()
       LIMIT ?`
    )
    .all(...genres, artistMbid, limit);
}

export function albumsByGenre(genre, limit = 60) {
  return db
    .prepare(
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl
       FROM albums al
       JOIN album_genres ag ON ag.album_mbid = al.mbid
       WHERE ag.genre = ? COLLATE NOCASE
       ORDER BY al.release_date ASC
       LIMIT ?`
    )
    .all(genre, limit);
}

export function randomAlbumId() {
  const row = db.prepare('SELECT mbid FROM albums ORDER BY RANDOM() LIMIT 1').get();
  return row ? row.mbid : null;
}

export function stats() {
  const artists = db.prepare('SELECT COUNT(*) as n FROM artists').get().n;
  const albums = db.prepare('SELECT COUNT(*) as n FROM albums').get().n;
  const tracks = db.prepare('SELECT COUNT(*) as n FROM tracks').get().n;
  return { artists, albums, tracks };
}

export default db;
