import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { tokens, rankAlbums } from './searchRank.js';

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

-- Durable one-off flags (e.g. "the seed artist-list imports have fully
-- completed at least once") that need to survive restarts/deploys, same
-- reasoning as mb_cache above - a plain key/value table rather than a
-- dedicated column or table per flag, since these are rare and unrelated to
-- each other.
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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

-- "My Albums": a signed-in visitor's private saved list. item_id is an
-- album or artist mbid depending on item_type - no foreign key to either
-- table (the type varies), but the app never deletes catalog rows, so an
-- orphaned entry isn't a real-world concern.
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('album', 'artist')),
  item_id TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, item_type, item_id)
);

-- Log of automated social posts (see socialPoster.js) - purely for dedup:
-- at most one post per platform per day (posted_date), and content_type +
-- item_id lets a specific artist/album be recognized as "already posted
-- about" even across restarts, so a server reboot mid-day never double-posts.
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  posted_date TEXT NOT NULL,
  content_type TEXT NOT NULL,
  item_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_albums_title ON albums(title);
CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_mbid);
CREATE INDEX IF NOT EXISTS idx_credits_track ON track_credits(track_id);
CREATE INDEX IF NOT EXISTS idx_credits_artist ON track_credits(artist_mbid);
CREATE INDEX IF NOT EXISTS idx_album_artists_artist ON album_artists(artist_mbid);
CREATE INDEX IF NOT EXISTS idx_credits_name ON track_credits(name COLLATE NOCASE);
-- A person's full career from MusicBrainz relationships (personCredits.js), one row per
-- credit mapped to the original album (release group). Albums may not be in \`albums\` yet;
-- their pages fetch them on first visit.
CREATE TABLE IF NOT EXISTS person_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_mbid TEXT NOT NULL,
  category TEXT NOT NULL,
  role TEXT,
  rg_mbid TEXT NOT NULL,
  rg_title TEXT,
  rg_type TEXT,
  release_date TEXT,
  by_artist TEXT,
  song TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_person_credits_artist ON person_credits(artist_mbid);

-- Things a visitor did on a page (the "meaningful actions" in the 60-day test):
-- search, credit_click, outbound (listen/merch/tickets links), share.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  path TEXT,
  detail TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_created ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_path ON page_views(path);
CREATE INDEX IF NOT EXISTS idx_album_genres_genre ON album_genres(genre);
CREATE INDEX IF NOT EXISTS idx_mb_cache_expires ON mb_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_album_credits_album ON album_credits(album_mbid);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_album ON reviews(album_mbid);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_item ON social_posts(content_type, item_id);
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

// Migration for DBs created before artist type/life-span existed - powers
// "In Memoriam" (see inMemoriam below). life_span_checked_at NULL means
// "never looked up yet", same pattern as enriched_at for albums - the
// backfill script (scripts/backfill-lifespan.js) works through those.
for (const col of ['type', 'born_date', 'died_date', 'life_span_checked_at']) {
  if (!artistColumns.includes(col)) db.exec(`ALTER TABLE artists ADD COLUMN ${col} TEXT;`);
}

// Per-song musician credits (trackCredits.js): NULL means the album hasn't had
// its song credits refreshed yet.
if (!albumColumns.includes('song_credits_at')) db.exec('ALTER TABLE albums ADD COLUMN song_credits_at TEXT;');
// How many releases (pressings, reissues) MusicBrainz lists for the album: a rough
// fame signal for search ranking (searchRank.js). Filled by the song credits refresh.
if (!albumColumns.includes('release_count')) db.exec('ALTER TABLE albums ADD COLUMN release_count INTEGER;');

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

// Vulnerability/plugin scanners routinely spoof an ordinary browser user-agent
// to slip past UA-based filtering, but they give themselves away through the
// paths they probe for - this app has no WordPress, PHP, or admin panel of any
// kind, so a referrer naming one of those could never come from a real click
// within the site; it's the scanner's own request trail leaking through.
const BOT_REFERRER_RE = /wp-(admin|content|login|json|includes|sitemap)|xmlrpc\.php|phpmyadmin|\.env$|wordpress/i;

// Desktop browsers update themselves; a desktop Chrome, Edge or Firefox about
// a year out of date, or a desktop Safari older than 17.6, is almost always a
// scraper wearing an old, copied browser ID. The cutoff moves with time
// (Chrome and Firefox ship a new major version every 4 weeks), so it never
// needs bumping by hand. Nov 2026 scrapers used Chrome 125-135, Firefox 128 and
// Safari 17.0-17.2 at ~90 distinct pages each. Phones are left alone: older
// phones can get stuck on old versions for real.
const FOUR_WEEKS = 28 * 864e5;
const versionNow = (base, since, now) => base + Math.floor((now - Date.parse(since)) / FOUR_WEEKS);
export function oldBrowserCutoffs(now = Date.now()) {
  const chrome = versionNow(120, '2023-12-05', now) - 15; // ~1 year back (Chrome skips a release now and then)
  const firefox = versionNow(121, '2023-12-19', now) - 15;
  return { Chrome: chrome, Edg: chrome, Firefox: firefox };
}
// Firefox long-term-support releases some Linux/work machines legitimately run.
const FIREFOX_ESR = new Set([140, 153]);
export function isOldDesktopBrowser(ua, now = Date.now()) {
  if (!ua || /Mobile|Android|iPhone|iPad/i.test(ua)) return false;
  if (!/Windows NT|Macintosh|X11|Linux x86_64/.test(ua)) return false;
  for (const [name, min] of Object.entries(oldBrowserCutoffs(now))) {
    const m = ua.match(new RegExp(`${name}\\/(\\d+)\\.`));
    if (m && Number(m[1]) < min && !(name === 'Firefox' && FIREFOX_ESR.has(Number(m[1])))) return true;
  }
  // Desktop Safari: "Version/17.0 Safari/..." (Chrome and Firefox don't send "Version/").
  const saf = !/Chrome|Chromium|Firefox|Edg/.test(ua) && ua.match(/Version\/(\d+)\.(\d+)[^ ]* Safari\//);
  if (saf) {
    const [maj, min] = [Number(saf[1]), Number(saf[2])];
    if (maj < 17 || (maj === 17 && min < 6)) return true;
  }
  return false;
}

// Forged referrers: the site only serves https, and browsers always end an
// address-only referrer with "/". So "http://albumverse.com…" or
// "https://albumverse.com" with nothing after it never comes from a real click.
const FAKE_SELF_REFERRER_RE = /^http:\/\/(www\.)?albumverse\.com(\/|$)|^https:\/\/(www\.)?albumverse\.com$/i;

// "{search_term_string}" is the placeholder in the site's search markup for
// Google; only bots try it literally.
const TEMPLATE_QUERY_RE = /\{search_term_string\}/i;

function isBotRequest(ua, referrer, query = null) {
  return !ua || BOT_UA_RE.test(ua) || (!!referrer && (BOT_REFERRER_RE.test(referrer) || FAKE_SELF_REFERRER_RE.test(referrer)))
    || isOldDesktopBrowser(ua) || (!!query && TEMPLATE_QUERY_RE.test(String(query)));
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
    const rows = db.prepare('SELECT id, user_agent, referrer FROM page_views').all();
    const markBot = db.prepare('UPDATE page_views SET is_bot = 1 WHERE id = ?');
    for (const r of rows) {
      if (isBotRequest(r.user_agent, r.referrer)) markBot.run(r.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
} else {
  // BOT_REFERRER_RE was added after is_bot already existed on most databases,
  // so rows logged in between never got checked against it - reclassify them
  // now rather than leaving scanner traffic stuck counted as human forever.
  const suspects = db.prepare('SELECT id, referrer FROM page_views WHERE is_bot = 0 AND referrer IS NOT NULL').all();
  const markBot = db.prepare('UPDATE page_views SET is_bot = 1 WHERE id = ?');
  for (const r of suspects) {
    if (BOT_REFERRER_RE.test(r.referrer)) markBot.run(r.id);
  }
}

// Scrapers that rotate through a list of ordinary-looking browser UA strings
// (a real Chrome build number, nothing "bot"-shaped) defeat both filters
// above by design - a static UA/referrer pattern can't catch a request that
// looks exactly like a real visitor. Volume is the tell instead: no human
// looks at 100+ distinct album/artist pages in a single day (the site's own
// most-viewed pages top out well under that over a whole week), so any
// (user-agent, day) pair that does gets retroactively reclassified as bot -
// re-run on every boot since new scraping days show up over time.
// Visitor id: a hash of IP + browser ID + day with a secret that only lives in
// memory, so the same visitor can be counted within a day but no IP is stored
// and nothing links across days. Lets the volume rule tell one scraper apart
// from many real people who happen to use the same phone and browser.
if (!db.prepare('PRAGMA table_info(page_views)').all().map((c) => c.name).includes('visitor')) {
  db.exec('ALTER TABLE page_views ADD COLUMN visitor TEXT;');
}
const VISITOR_SECRET = randomBytes(16).toString('hex');
export function visitorId(ip, ua) {
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256').update(`${VISITOR_SECRET}|${day}|${ip}|${ua || ''}`).digest('hex').slice(0, 16);
}

// One visitor (address + browser ID) opening this many different pages in a
// day is a scraper; credit-hopping fans stay well under it. Rows from before
// visitor ids existed are judged per browser ID, which many real people share,
// so that older check keeps the higher bar.
const BOT_DISTINCT_PATHS_PER_DAY = 40;
const BOT_DISTINCT_PATHS_PER_UA_DAY = 100;
export function reclassifyBotTraffic() {
  const volumetric = db
    .prepare(
      `SELECT user_agent as userAgent, date(created_at) as day
       FROM page_views
       WHERE is_bot = 0 AND user_agent IS NOT NULL AND visitor IS NULL
       GROUP BY user_agent, day
       HAVING COUNT(DISTINCT path) > ?`
    )
    .all(BOT_DISTINCT_PATHS_PER_UA_DAY);
  const markDayBot = db.prepare(
    "UPDATE page_views SET is_bot = 1 WHERE is_bot = 0 AND visitor IS NULL AND user_agent = ? AND date(created_at) = ?"
  );
  let n = 0;
  // Rows with a visitor id: judge each visitor on their own.
  const byVisitor = db.prepare(
    `SELECT visitor FROM page_views WHERE is_bot = 0 AND visitor IS NOT NULL
     GROUP BY visitor HAVING COUNT(DISTINCT path) > ?`
  ).all(BOT_DISTINCT_PATHS_PER_DAY);
  const markVisitor = db.prepare('UPDATE page_views SET is_bot = 1 WHERE is_bot = 0 AND visitor = ?');
  for (const r of byVisitor) n += Number(markVisitor.run(r.visitor).changes);
  // Older rows (no visitor id): by browser ID and day, as before.
  for (const r of volumetric) n += Number(markDayBot.run(r.userAgent, r.day).changes);
  // Old desktop browser IDs, forged referrers and template searches (rules
  // added Nov 2026), judged by the date of each view.
  const rows = db.prepare('SELECT id, user_agent, referrer, query, created_at FROM page_views WHERE is_bot = 0').all();
  const markBot = db.prepare('UPDATE page_views SET is_bot = 1 WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const at = Date.parse(`${r.created_at}Z`) || Date.now();
      if (isOldDesktopBrowser(r.user_agent, at) || (r.referrer && FAKE_SELF_REFERRER_RE.test(r.referrer)) || (r.query && TEMPLATE_QUERY_RE.test(r.query))) {
        markBot.run(r.id);
        n++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.prepare("UPDATE events SET is_bot = 1 WHERE is_bot = 0 AND path = '/search' AND detail LIKE '%{search_term_string}%'").run();
  return n;
}

// Live version of the same volume rule: count each browser ID's distinct pages
// today in memory, so a scraper is caught after its 100th page instead of at
// the next restart (and stops counting as a visitor right away).
const liveCounts = { day: '', seen: new Map(), flagged: new Set() };
function trackVolume(key, p) {
  if (!key) return false;
  const day = new Date().toISOString().slice(0, 10);
  if (liveCounts.day !== day) Object.assign(liveCounts, { day, seen: new Map(), flagged: new Set() });
  if (liveCounts.flagged.has(key)) return true;
  let set = liveCounts.seen.get(key);
  if (!set) liveCounts.seen.set(key, (set = new Set()));
  set.add(p);
  if (set.size > BOT_DISTINCT_PATHS_PER_DAY) {
    liveCounts.flagged.add(key);
    liveCounts.seen.delete(key);
    db.prepare('UPDATE page_views SET is_bot = 1 WHERE is_bot = 0 AND visitor = ?').run(key);
    return true;
  }
  return false;
}

// For callers deciding whether a request should count (e.g. moving a page to the
// front of a background queue): true for known bots and today's volume offenders.
export function isBotTraffic(ua, referrer = null, query = null, ip = null) {
  if (isBotRequest(ua, referrer, query)) return true;
  const key = visitorId(ip, ua);
  return !!key && liveCounts.day === new Date().toISOString().slice(0, 10) && liveCounts.flagged.has(key);
}

// Migration: social_posts used to have UNIQUE(platform, posted_date), which
// meant at most one post per platform per day, full stop - including an
// urgent In Memoriam death announcement that happened to lose the race to
// an On This Day/Trending pick that already posted that day. Rebuilding
// without the constraint (SQLite has no ALTER TABLE DROP CONSTRAINT) lets
// checkAndPostDaily/checkAndPostShort post an In Memoriam item any time a
// new one is detected, regardless of what else already went out today -
// see hasPostedToday below for how the "one regular post a day" cap still
// applies to everything else.
{
  const socialPostsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='social_posts'").get();
  if (socialPostsSchema && socialPostsSchema.sql.includes('UNIQUE')) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE social_posts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          platform TEXT NOT NULL,
          posted_date TEXT NOT NULL,
          content_type TEXT NOT NULL,
          item_id TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO social_posts_new (id, platform, posted_date, content_type, item_id, created_at)
          SELECT id, platform, posted_date, content_type, item_id, created_at FROM social_posts;
        DROP TABLE social_posts;
        ALTER TABLE social_posts_new RENAME TO social_posts;
        CREATE INDEX IF NOT EXISTS idx_social_posts_item ON social_posts(content_type, item_id);
      `);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
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
  if (detail.releaseCount) db.prepare('UPDATE albums SET release_count = ? WHERE mbid = ?').run(detail.releaseCount, detail.id);

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

// Albums whose per-song credits haven't been refreshed, most-viewed first.
export function albumsNeedingSongCredits(limit = 50) {
  return db
    .prepare(
      `WITH v AS (
         SELECT substr(path, 8) AS mbid, COUNT(*) AS n FROM page_views
         WHERE path LIKE '/album/%' AND is_bot = 0 GROUP BY path
       )
       SELECT al.mbid AS id, al.title, COALESCE(v.n, 0) AS views
       FROM albums al LEFT JOIN v ON v.mbid = al.mbid
       WHERE al.song_credits_at IS NULL
       ORDER BY views DESC, al.added_at DESC
       LIMIT ?`
    )
    .all(limit);
}

export function countAlbumsNeedingSongCredits() {
  return db.prepare('SELECT COUNT(*) AS n FROM albums WHERE song_credits_at IS NULL').get().n;
}

// Recording ids of an album's saved songs (to tell whether a fresh fetch read
// the same release we saved).
export function savedRecordings(albumMbid) {
  return db.prepare('SELECT recording_mbid AS rec FROM tracks WHERE album_mbid = ?').all(albumMbid).map((r) => r.rec).filter(Boolean);
}

// One time (Nov 2026): albums saved with no musician on any song get another
// look now that the main release is chosen better (Thriller, Nevermind).
export function requeueAlbumsWithoutMusicians() {
  const key = 'song_credits_requeue_v2';
  if (db.prepare('SELECT value FROM app_state WHERE key = ?').get(key)) return 0;
  const n = db.prepare(
    `UPDATE albums SET song_credits_at = NULL
     WHERE song_credits_at IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM tracks t JOIN track_credits tc ON tc.track_id = t.id
       WHERE t.album_mbid = albums.mbid AND tc.kind = 'performer')`
  ).run().changes;
  db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, new Date().toISOString());
  return Number(n);
}

// undefined: no such album; null: not refreshed yet; otherwise the time.
export function albumSongCreditsAt(mbid) {
  const row = db.prepare('SELECT song_credits_at AS at FROM albums WHERE mbid = ?').get(mbid);
  return row ? row.at : undefined;
}

export function markSongCredits(mbid) {
  db.prepare("UPDATE albums SET song_credits_at = datetime('now') WHERE mbid = ?").run(mbid);
}

// Replace each saved song's musicians with a fresh list (fetched tracks are
// matched to saved ones by recording id, then by position). Saved writers stay;
// new writers only fill songs that had none. Album-wide credits are replaced
// when the fresh list has any. Returns how many songs now list a musician.
export function saveSongCredits(albumMbid, tracks, albumCredits = [], releaseCount = null) {
  const saved = db.prepare('SELECT id, position, recording_mbid AS rec FROM tracks WHERE album_mbid = ?').all(albumMbid);
  const byRec = new Map(saved.filter((t) => t.rec).map((t) => [t.rec, t.id]));
  const byPos = new Map(saved.map((t) => [Number(t.position), t.id]));
  const delPerf = db.prepare("DELETE FROM track_credits WHERE track_id = ? AND kind = 'performer'");
  const hasWriter = db.prepare("SELECT 1 FROM track_credits WHERE track_id = ? AND kind = 'writer' LIMIT 1");
  const insert = db.prepare('INSERT INTO track_credits (track_id, kind, name, artist_mbid, role) VALUES (?, ?, ?, ?, ?)');
  const stub = db.prepare('INSERT OR IGNORE INTO artists (mbid, name) VALUES (?, ?)');
  let withMusicians = 0;
  db.exec('BEGIN');
  try {
    for (const t of tracks || []) {
      const id = (t.recordingMbid && byRec.get(t.recordingMbid)) || byPos.get(Number(t.position));
      if (!id) continue;
      delPerf.run(id);
      for (const p of t.performers || []) {
        insert.run(id, 'performer', p.name, p.mbid || null, p.role || null);
        if (p.mbid) stub.run(p.mbid, p.name);
      }
      if ((t.performers || []).length) withMusicians++;
      if (!hasWriter.get(id)) {
        for (const w of t.writers || []) {
          insert.run(id, 'writer', w.name, w.mbid || null, w.role || null);
          if (w.mbid) stub.run(w.mbid, w.name);
        }
      }
    }
    if (albumCredits.length) {
      db.prepare('DELETE FROM album_credits WHERE album_mbid = ?').run(albumMbid);
      const ins = db.prepare('INSERT INTO album_credits (album_mbid, name, role, source) VALUES (?, ?, ?, ?)');
      for (const c of albumCredits) ins.run(albumMbid, c.name, c.role, c.source || 'discogs');
    }
    db.prepare("UPDATE albums SET song_credits_at = datetime('now'), release_count = COALESCE(?, release_count) WHERE mbid = ?").run(releaseCount, albumMbid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return withMusicians;
}

// Every song a person is credited on, from album tracklists: by MusicBrainz id,
// plus credits saved by name only (Discogs) when withName is set. One row per
// song (the same song on a reissue or compilation counts once, at its earliest
// album), with every role they had on it, oldest first.
export function songsForPerson(mbid, name, { withName = false, limit = 2000 } = {}) {
  const rows = db.prepare(
    `SELECT t.title AS song, t.position, al.mbid AS albumId, al.title AS album, al.release_date AS date,
            al.artist_credit AS by, al.type, tc.kind, tc.role
     FROM track_credits tc
     JOIN tracks t ON t.id = tc.track_id
     JOIN albums al ON al.mbid = t.album_mbid
     WHERE tc.artist_mbid = ? OR (? = 1 AND tc.artist_mbid IS NULL AND tc.name = ? COLLATE NOCASE)
     LIMIT 20000`
  ).all(mbid, withName ? 1 : 0, name || '');
  const key = (r) => `${String(r.song).toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()}|${String(r.by || '').toLowerCase()}`;
  const songs = new Map();
  for (const r of rows) {
    const k = key(r);
    let s = songs.get(k);
    if (!s) songs.set(k, (s = { song: r.song, albumId: r.albumId, album: r.album, date: r.date || '', by: r.by, roles: new Set(), albums: new Set() }));
    s.albums.add(r.albumId);
    // Earliest album with a date wins, so the original beats the reissue.
    if (r.date && (!s.date || r.date < s.date)) Object.assign(s, { song: r.song, albumId: r.albumId, album: r.album, date: r.date });
    const role = r.kind === 'writer' ? 'songwriter' : String(r.role || 'performer').toLowerCase();
    s.roles.add(role);
  }
  return [...songs.values()]
    .map((s) => ({ ...s, roles: [...s.roles], alsoOn: s.albums.size - 1, albums: undefined }))
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.song.localeCompare(b.song))
    .slice(0, limit);
}

export function countAlbumsNeedingEnrichment() {
  return db.prepare('SELECT COUNT(*) as n FROM albums WHERE enriched_at IS NULL').get().n;
}

// Album search: every query word must appear in the title or artist; results
// ranked by searchRank.js (match quality + how well-known the album is).
function searchWhere(query) {
  const words = tokens(query).slice(0, 8);
  if (!words.length) return { sql: '0', args: [] };
  return {
    sql: words.map(() => "(al.title || ' ' || al.artist_credit) LIKE ? COLLATE NOCASE").join(' AND '),
    args: words.map((w) => `%${w}%`),
  };
}

export function searchLocal(query, limit = 24, offset = 0) {
  const w = searchWhere(query);
  const exact = String(query || '').trim();
  const cap = Math.max(300, offset + limit + 50);
  const rows = db
    .prepare(
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist,
              al.cover_art_url as coverArtUrl, al.release_count as releaseCount${ratingCols('al.')},
              (SELECT COUNT(*) FROM page_views pv WHERE pv.path = '/album/' || al.mbid AND pv.is_bot = 0) as views,
              (SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM album_artists x
                 WHERE x.artist_mbid IN (SELECT artist_mbid FROM album_artists WHERE album_mbid = al.mbid)
                 GROUP BY x.artist_mbid)) as artistAlbums
       FROM albums al
       WHERE ${w.sql}
       ORDER BY CASE WHEN al.title = ? COLLATE NOCASE THEN 0 WHEN al.title LIKE ? COLLATE NOCASE THEN 1 ELSE 2 END,
                COALESCE(al.release_count, 0) DESC
       LIMIT ?`
    )
    .all(...w.args, exact, `${exact}%`, cap);
  // `known`: some sign this is a real, well-known record (searchRank.hasStrongMatch).
  return rankAlbums(query, rows)
    .slice(offset, offset + limit)
    .map(({ views, artistAlbums, ...a }) => ({
      ...a,
      // An artist with many albums isn't enough (Eddie & the Hot Rods also made a
      // "Thriller"); the record itself must have many releases or real visits.
      known: (a.releaseCount || 0) >= 10 || (views || 0) >= 25,
    }));
}

export function countSearchLocal(query) {
  const w = searchWhere(query);
  return db.prepare(`SELECT COUNT(*) as n FROM albums al WHERE ${w.sql}`).get(...w.args).n;
}

export function recentlyAdded(limit = 12) {
  return db
    .prepare(
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, cover_art_url as coverArtUrl${ratingCols()}
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

// Same security posture as deleteSessionsForUser (a password change should
// sign out anyone else logged in as this account), but a voluntary in-app
// change - unlike a recovery reset - has one session that's clearly still
// legitimately you: the one you're making the change from. No reason to
// force that one back through sign-in too.
export function deleteOtherSessionsForUser(userId, exceptToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, exceptToken);
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
       WHERE r.album_mbid = ? ORDER BY r.updated_at DESC, r.id DESC LIMIT ? OFFSET ?`
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
       WHERE r.user_id = ? ORDER BY r.updated_at DESC, r.id DESC LIMIT ? OFFSET ?`
    )
    .all(userId, limit, offset);
}

export function countReviewsByUser(userId) {
  return db.prepare('SELECT COUNT(*) as n FROM reviews WHERE user_id = ?').get(userId).n;
}

// "On this day": albums whose release date's month+day matches today,
// across every year on file. MusicBrainz release dates come through at
// varying precision (year only, year-month, or full year-month-day) - only
// full-precision (length 10) dates can honestly claim a specific day, so
// anything coarser is excluded rather than guessed at.
export function onThisDayAlbums(limit = 60, offset = 0) {
  return db
    .prepare(
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, cover_art_url as coverArtUrl${ratingCols()}
       FROM albums
       WHERE length(release_date) = 10 AND strftime('%m-%d', release_date) = strftime('%m-%d', 'now')
       ORDER BY release_date ASC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

// Same "on this day" match as onThisDayAlbums(), minus classical picks - see
// excludeClassicalSql(). Used only by socialPoster.js/youtubeShort.js.
export function onThisDayAlbumsForSocial(limit = 60) {
  return db
    .prepare(
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, cover_art_url as coverArtUrl
       FROM albums
       WHERE length(release_date) = 10 AND strftime('%m-%d', release_date) = strftime('%m-%d', 'now')
         AND ${excludeClassicalSql()}
       ORDER BY release_date ASC
       LIMIT ?`
    )
    .all(limit);
}

export function countOnThisDayAlbums() {
  return db
    .prepare(
      `SELECT COUNT(*) as n FROM albums
       WHERE length(release_date) = 10 AND strftime('%m-%d', release_date) = strftime('%m-%d', 'now')`
    )
    .get().n;
}

// Newest reviews site-wide, for the homepage activity feed - unlike
// getReviewsForAlbum/getReviewsByUser (scoped to one album or one user)
// this pulls across everyone, so both who wrote it and what album it's
// about need to travel with each row.
export function recentReviews(limit = 12) {
  return db
    .prepare(
      `SELECT r.rating as rating, r.body as body, r.updated_at as updatedAt, u.username as username,
       al.mbid as albumId, al.title as albumTitle, al.artist_credit as albumArtist, al.cover_art_url as albumCoverArtUrl
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       JOIN albums al ON al.mbid = r.album_mbid
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT ?`
    )
    .all(limit);
}

export function setArtistLifespan(mbid, { type, bornDate, diedDate } = {}) {
  db.prepare(
    "UPDATE artists SET type = ?, born_date = ?, died_date = ?, life_span_checked_at = datetime('now') WHERE mbid = ?"
  ).run(type || null, bornDate || null, diedDate || null, mbid);
}

// Called from wikidataDeaths.js, a faster death signal than the MusicBrainz-
// based recheck above (Wikidata is typically updated within hours of a
// notable death, versus MusicBrainz's crowd-edited data taking weeks).
// Only touches an mbid this app already knows about, and only when it's
// unambiguously a person (never overwrites a Group by mistake) - also marks
// it checked so the slower MusicBrainz recheck path doesn't redo the work.
// Returns whether anything actually changed, so the caller can log real hits.
export function setArtistDeathFromExternalSource(mbid, diedDate) {
  const result = db
    .prepare(
      `UPDATE artists SET died_date = ?, type = COALESCE(type, 'Person'), life_span_checked_at = datetime('now')
       WHERE mbid = ? AND (type IS NULL OR type = 'Person') AND (died_date IS NULL OR died_date != ?)`
    )
    .run(diedDate, mbid, diedDate);
  return result.changes > 0;
}

// Most-viewed first, same prioritization as albumsNeedingEnrichment - most
// artists here are never-fetched stub rows created from track credits
// (session musicians, songwriters), so there are far more of them than
// there's API budget to check quickly.
//
// A living Person also gets periodically re-checked (not just NULL-checked
// artists) - otherwise, once an artist is checked, they're never looked at
// again, so a death MusicBrainz records weeks or months after the fact
// (crowd-edited data lags real-world news) would never get picked up and
// In Memoriam would just silently miss it forever. Groups are excluded
// (a band doesn't "die") and already-recorded deaths don't need re-checking.
const LIFESPAN_RECHECK_DAYS = 14;
const LIFESPAN_CHECK_WHERE = `
  a.life_span_checked_at IS NULL
  OR (a.type = 'Person' AND a.died_date IS NULL AND a.life_span_checked_at < datetime('now', '-${LIFESPAN_RECHECK_DAYS} days'))
`;

export function artistsNeedingLifespanCheck(limit = 50) {
  return db
    .prepare(
      `SELECT a.mbid as id, a.name,
       (SELECT COUNT(*) FROM page_views pv WHERE pv.path = '/artist/' || a.mbid AND pv.is_bot = 0) as views
       FROM artists a
       WHERE ${LIFESPAN_CHECK_WHERE}
       ORDER BY (a.life_span_checked_at IS NULL) DESC, views DESC
       LIMIT ?`
    )
    .all(limit);
}

export function countArtistsNeedingLifespanCheck() {
  return db.prepare(`SELECT COUNT(*) as n FROM artists a WHERE ${LIFESPAN_CHECK_WHERE}`).get().n;
}

// Only type = 'Person' - a Group's life-span ending means the band broke up,
// not that anyone died, and conflating the two here would be a real,
// embarrassing correctness bug for a feature about people's deaths.
export function inMemoriam(limit = 12, offset = 0) {
  return db
    .prepare(
      `SELECT a.mbid as id, a.name, a.disambiguation, a.died_date as diedDate, a.born_date as bornDate,
       ${ARTIST_IMAGE_SQL} as imageUrl
       FROM artists a
       WHERE a.type = 'Person' AND a.died_date IS NOT NULL
       ORDER BY a.died_date DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

export function countInMemoriam() {
  return db.prepare("SELECT COUNT(*) as n FROM artists WHERE type = 'Person' AND died_date IS NOT NULL").get().n;
}

// --- Watchlist ("My Albums") ---

export function addToWatchlist(userId, itemType, itemId) {
  db.prepare(
    `INSERT INTO watchlist (user_id, item_type, item_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, item_type, item_id) DO NOTHING`
  ).run(userId, itemType, itemId);
}

export function removeFromWatchlist(userId, itemType, itemId) {
  db.prepare('DELETE FROM watchlist WHERE user_id = ? AND item_type = ? AND item_id = ?').run(userId, itemType, itemId);
}

export function isInWatchlist(userId, itemType, itemId) {
  return !!db.prepare('SELECT 1 FROM watchlist WHERE user_id = ? AND item_type = ? AND item_id = ?').get(userId, itemType, itemId);
}

export function getWatchlistAlbums(userId, limit = 60, offset = 0) {
  return db
    .prepare(
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl${ratingCols('al.')}
       FROM watchlist w JOIN albums al ON al.mbid = w.item_id
       WHERE w.user_id = ? AND w.item_type = 'album'
       ORDER BY w.created_at DESC, w.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(userId, limit, offset);
}

export function countWatchlistAlbums(userId) {
  return db.prepare("SELECT COUNT(*) as n FROM watchlist WHERE user_id = ? AND item_type = 'album'").get(userId).n;
}

export function getWatchlistArtists(userId, limit = 60, offset = 0) {
  return db
    .prepare(
      `SELECT a.mbid as id, a.name, a.disambiguation, ${ARTIST_IMAGE_SQL} as imageUrl,
       (SELECT COUNT(*) FROM album_artists aa WHERE aa.artist_mbid = a.mbid) as albumCount
       FROM watchlist w JOIN artists a ON a.mbid = w.item_id
       WHERE w.user_id = ? AND w.item_type = 'artist'
       ORDER BY w.created_at DESC, w.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(userId, limit, offset);
}

export function countWatchlistArtists(userId) {
  return db.prepare("SELECT COUNT(*) as n FROM watchlist WHERE user_id = ? AND item_type = 'artist'").get(userId).n;
}

// --- Automated social posting dedup (see socialPoster.js) ---

// Excludes in_memoriam content types deliberately - those bypass the daily
// cap entirely (see checkAndPostDaily/checkAndPostShort), so "has posted
// today" here means "has posted a regular (On This Day/Trending) pick
// today", not "has posted anything at all".
export function hasPostedToday(platform, dateStr) {
  return !!db
    .prepare("SELECT 1 FROM social_posts WHERE platform = ? AND posted_date = ? AND content_type NOT LIKE 'in_memoriam%'")
    .get(platform, dateStr);
}

export function hasPostedAboutItem(contentType, itemId) {
  return !!db.prepare('SELECT 1 FROM social_posts WHERE content_type = ? AND item_id = ?').get(contentType, itemId);
}

export function recordSocialPost(platform, dateStr, contentType, itemId) {
  db.prepare(
    'INSERT INTO social_posts (platform, posted_date, content_type, item_id) VALUES (?, ?, ?, ?)'
  ).run(platform, dateStr, contentType, itemId || null);
}

export function sitemapAlbums() {
  return db.prepare("SELECT mbid as id, substr(added_at, 1, 10) as lastmod FROM albums").all();
}

export function sitemapArtists() {
  // lastmod = when the person's full career was filled in, so Google re-reads those pages
  return db.prepare("SELECT mbid as id, substr(credits_fetched_at, 1, 10) as lastmod FROM artists").all();
}

// ---- people search ----
// Exact name first, then names starting with the query, then anywhere in the name; within
// each, people with the most credits first (a credits site's searches are mostly people).
export function searchPeople(query, limit = 6) {
  // quotes ignored on both sides: MusicBrainz writes 'Robert John “Mutt” Lange'
  const q = String(query || '').replace(/["“”'‘’]/g, '').replace(/\s+/g, ' ').trim();
  if (q.length < 2) return [];
  const bare = `replace(replace(replace(replace(replace(replace(a.name, '“', ''), '”', ''), '"', ''), char(39), ''), '‘', ''), '’', '')`;
  return db.prepare(
    `WITH hits AS (
       SELECT a.mbid, a.name, a.disambiguation, a.type, a.wiki_image_url AS imageUrl,
              CASE WHEN ${bare} = ? COLLATE NOCASE THEN 0 WHEN ${bare} LIKE ? COLLATE NOCASE THEN 1 ELSE 2 END AS rank
       FROM artists a WHERE ${bare} LIKE ? COLLATE NOCASE
       LIMIT 200
     )
     SELECT h.mbid AS id, h.name, h.disambiguation, h.type, h.imageUrl,
            (SELECT COUNT(DISTINCT rg_mbid) FROM person_credits pc WHERE pc.artist_mbid = h.mbid) AS credits,
            (SELECT category FROM person_credits pc WHERE pc.artist_mbid = h.mbid
               GROUP BY category ORDER BY COUNT(DISTINCT rg_mbid) DESC LIMIT 1) AS topCategory,
            (SELECT COUNT(*) FROM album_artists aa WHERE aa.artist_mbid = h.mbid) AS albums
     FROM hits h
     ORDER BY (h.rank = 0) DESC, (credits + albums > 0) DESC, credits DESC, h.rank, albums DESC, length(h.name)
     LIMIT ?`
  ).all(q, `${q}%`, `%${q}%`, limit);
}

// People credited on the same albums: from track credits (albums on the site) and from
// other people's filled-in careers. Returns [{ id, name, shared }].
export function collaboratorsFor(mbid, albumIds, limit = 10) {
  const ids = [...new Set(albumIds)].slice(0, 400);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const fromTracks = db.prepare(
    `SELECT tc.artist_mbid AS id, MAX(tc.name) AS name, COUNT(DISTINCT t.album_mbid) AS shared
     FROM track_credits tc JOIN tracks t ON t.id = tc.track_id
     WHERE t.album_mbid IN (${ph}) AND tc.artist_mbid IS NOT NULL AND tc.artist_mbid != ?
     GROUP BY tc.artist_mbid`
  ).all(...ids, mbid);
  const fromCareers = db.prepare(
    `SELECT pc.artist_mbid AS id, a.name, COUNT(DISTINCT pc.rg_mbid) AS shared
     FROM person_credits pc JOIN artists a ON a.mbid = pc.artist_mbid
     WHERE pc.rg_mbid IN (${ph}) AND pc.artist_mbid != ?
     GROUP BY pc.artist_mbid`
  ).all(...ids, mbid);
  const merged = new Map();
  for (const r of [...fromTracks, ...fromCareers]) {
    const cur = merged.get(r.id);
    if (!cur || r.shared > cur.shared) merged.set(r.id, r);
  }
  return [...merged.values()].filter((r) => r.shared >= 2).sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name)).slice(0, limit);
}

export function artistIdsByExactNames(names) {
  const out = {};
  const stmt = db.prepare('SELECT mbid FROM artists WHERE name = ? COLLATE NOCASE LIMIT 2');
  for (const n of names) {
    const rows = stmt.all(n);
    if (rows.length === 1) out[n] = rows[0].mbid;
  }
  return out;
}

export function logPageView({ path: p, query, referrer, userAgent, ip = null }) {
  const visitor = visitorId(ip, userAgent);
  const bot = isBotRequest(userAgent, referrer, query) || trackVolume(visitor, p);
  db.prepare('INSERT INTO page_views (path, query, referrer, user_agent, is_bot, visitor) VALUES (?, ?, ?, ?, ?, ?)').run(
    p, query || null, referrer || null, userAgent || null, bot ? 1 : 0, visitor
  );
}

// ---- person credits (IMDb-style person pages) ----
if (!db.prepare('PRAGMA table_info(artists)').all().map((c) => c.name).includes('credits_fetched_at')) {
  db.exec('ALTER TABLE artists ADD COLUMN credits_fetched_at TEXT;');
}

export function savePersonCredits(mbid, rows) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM person_credits WHERE artist_mbid = ?').run(mbid);
    const ins = db.prepare(
      `INSERT INTO person_credits (artist_mbid, category, role, rg_mbid, rg_title, rg_type, release_date, by_artist, song, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of rows) {
      ins.run(mbid, r.category, r.role || null, r.rgId, r.rgTitle || null, r.rgType || null, r.date || null, r.by || null, r.song || null, r.source || null);
    }
    db.prepare("UPDATE artists SET credits_fetched_at = datetime('now') WHERE mbid = ?").run(mbid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function markCreditsFetched(mbid) {
  db.prepare("UPDATE artists SET credits_fetched_at = datetime('now') WHERE mbid = ?").run(mbid);
}

export function getPersonCredits(mbid) {
  return db.prepare(
    `SELECT category, role, rg_mbid as rgId, rg_title as rgTitle, rg_type as rgType, release_date as date,
            by_artist as byArtist, song, source
     FROM person_credits WHERE artist_mbid = ? ORDER BY release_date DESC`
  ).all(mbid);
}

export function creditsFetchedAt(mbid) {
  return db.prepare('SELECT credits_fetched_at as at FROM artists WHERE mbid = ?').get(mbid)?.at || null;
}

// Who to fill in next: people whose pages get crawled or visited most (search engines'
// interest is the point), never fetched or older than 60 days; then anyone credited on a track.
export function nextPeopleToEnrich(limit = 20) {
  return db.prepare(
    `WITH views AS (
       SELECT substr(path, 9) AS mbid, COUNT(*) AS n FROM page_views
       WHERE path LIKE '/artist/%' AND created_at >= datetime('now', '-30 days')
       GROUP BY path
     )
     SELECT a.mbid, a.name, COALESCE(v.n, 0) AS views FROM artists a
     LEFT JOIN views v ON v.mbid = a.mbid
     WHERE (a.credits_fetched_at IS NULL OR a.credits_fetched_at < datetime('now', '-60 days'))
       AND (COALESCE(a.type, 'Person') != 'Group')
       AND (v.n > 0 OR EXISTS (SELECT 1 FROM track_credits tc WHERE tc.artist_mbid = a.mbid))
     ORDER BY views DESC
     LIMIT ?`
  ).all(limit);
}

// ---- credits-themed Shorts ----
// People with a real story: 6+ albums as producer/songwriter/etc. across 3+ different artists,
// not featured yet; the ones search engines and visitors look at most come first.
export function peopleForShort(limit = 10, { unposted = true } = {}) {
  return db.prepare(
    `WITH views AS (
       SELECT substr(path, 9) AS mbid, COUNT(*) AS n FROM page_views
       WHERE path LIKE '/artist/%' AND created_at >= datetime('now', '-60 days') GROUP BY path
     ), stats AS (
       SELECT artist_mbid, COUNT(DISTINCT rg_mbid) AS albums, COUNT(DISTINCT by_artist) AS acts
       FROM person_credits GROUP BY artist_mbid
     )
     SELECT a.mbid AS id, a.name, s.albums, s.acts, COALESCE(v.n, 0) AS views
     FROM stats s JOIN artists a ON a.mbid = s.artist_mbid
     LEFT JOIN views v ON v.mbid = s.artist_mbid
     WHERE s.albums >= 6 AND s.acts >= 3
       AND (? = 0 OR NOT EXISTS (SELECT 1 FROM social_posts sp WHERE sp.content_type = 'person_credits_yt' AND sp.item_id = a.mbid))
     ORDER BY views DESC, s.albums DESC
     LIMIT ?`
  ).all(unposted ? 1 : 0, limit);
}

// Albums with cover art and enough credits to name names, not featured yet.
export function albumsForCreditsShort(limit = 10, { unposted = true } = {}) {
  return db.prepare(
    `WITH views AS (
       SELECT substr(path, 8) AS mbid, COUNT(*) AS n FROM page_views
       WHERE path LIKE '/album/%' AND created_at >= datetime('now', '-60 days') GROUP BY path
     ), people AS (
       SELECT t.album_mbid AS mbid, COUNT(DISTINCT tc.name) AS n FROM track_credits tc
       JOIN tracks t ON t.id = tc.track_id GROUP BY t.album_mbid
     )
     SELECT al.mbid AS id, COALESCE(v.n, 0) AS views, p.n AS people FROM albums al
     JOIN people p ON p.mbid = al.mbid
     LEFT JOIN views v ON v.mbid = al.mbid
     WHERE al.cover_art_url IS NOT NULL AND p.n >= 4
       AND EXISTS (SELECT 1 FROM album_credits ac WHERE ac.album_mbid = al.mbid AND ac.role LIKE '%produc%')
       AND (? = 0 OR NOT EXISTS (SELECT 1 FROM social_posts sp WHERE sp.content_type = 'album_credits_yt' AND sp.item_id = al.mbid))
     ORDER BY views DESC, p.n DESC
     LIMIT ?`
  ).all(unposted ? 1 : 0, limit);
}

// ---- homepage + people pages ----
// People pages viewed most in the last N days: real visitors first, then (to fill the list)
// pages search engines crawl most. Bands excluded.
export function topPeople(days = 7, limit = 6) {
  const q = (botClause) => db.prepare(
    `SELECT a.mbid AS id, a.name, a.disambiguation, a.wiki_image_url AS imageUrl, COUNT(*) AS views
     FROM page_views pv JOIN artists a ON a.mbid = substr(pv.path, 9)
     WHERE pv.path LIKE '/artist/%' AND pv.created_at >= datetime('now', ?) AND ${botClause}
       AND COALESCE(a.type, 'Person') != 'Group'
     GROUP BY a.mbid ORDER BY views DESC LIMIT ?`
  ).all(`-${Math.max(1, days | 0)} days`, limit);
  const human = q('pv.is_bot = 0');
  if (human.length >= limit) return human;
  const seen = new Set(human.map((p) => p.id));
  return [...human, ...q('pv.is_bot = 1').filter((p) => !seen.has(p.id))].slice(0, limit);
}

export const PEOPLE_ROLES = ['producer', 'songwriter', 'performer', 'arrangement', 'engineering'];

// People ranked by albums credited (optionally in one role), for /people pages.
export function browsePeople(role = null, limit = 48, offset = 0) {
  const where = role ? 'WHERE pc.category = ?' : '';
  const args = role ? [role, limit, offset] : [limit, offset];
  return db.prepare(
    `SELECT a.mbid AS id, a.name, a.wiki_image_url AS imageUrl, COUNT(DISTINCT pc.rg_mbid) AS credits,
            (SELECT category FROM person_credits x WHERE x.artist_mbid = a.mbid
               GROUP BY category ORDER BY COUNT(DISTINCT rg_mbid) DESC LIMIT 1) AS topCategory
     FROM person_credits pc JOIN artists a ON a.mbid = pc.artist_mbid
     ${where}
     GROUP BY pc.artist_mbid ORDER BY credits DESC, a.name LIMIT ? OFFSET ?`
  ).all(...args);
}

export function countPeople(role = null) {
  return role
    ? db.prepare('SELECT COUNT(DISTINCT artist_mbid) AS n FROM person_credits WHERE category = ?').get(role).n
    : db.prepare('SELECT COUNT(DISTINCT artist_mbid) AS n FROM person_credits').get().n;
}

export function artistImages(mbids, limit = 3) {
  if (!mbids.length) return [];
  return db.prepare(
    `SELECT wiki_image_url AS url FROM artists WHERE mbid IN (${mbids.map(() => '?').join(',')}) AND wiki_image_url IS NOT NULL LIMIT ?`
  ).all(...mbids, limit).map((r) => r.url);
}

export function findArtistByExactName(name) {
  return db.prepare('SELECT mbid as id, name FROM artists WHERE name = ? COLLATE NOCASE LIMIT 2').all(name);
}

export const EVENT_TYPES = new Set(['search', 'credit_click', 'outbound', 'share']);

export function logEvent({ type, path: p, detail, userAgent }) {
  if (!EVENT_TYPES.has(type)) return false;
  db.prepare('INSERT INTO events (type, path, detail, is_bot) VALUES (?, ?, ?, ?)').run(
    type, p ? String(p).slice(0, 300) : null, detail ? String(detail).slice(0, 300) : null,
    isBotRequest(userAgent, null) ? 1 : 0
  );
  return true;
}

// Search engines that send a referrer. Google sends just "https://www.google.com/".
const ORGANIC_SQL = `(referrer LIKE '%://www.google.%' OR referrer LIKE '%://google.%' OR referrer LIKE '%://www.bing.com%'
  OR referrer LIKE '%duckduckgo.com%' OR referrer LIKE '%search.yahoo.com%' OR referrer LIKE '%ecosia.org%'
  OR referrer LIKE '%search.brave.com%' OR referrer LIKE '%startpage.com%' OR referrer LIKE '%yandex.%')`;
const SOCIAL_SQL = `(referrer LIKE '%bsky.app%' OR referrer LIKE '%facebook.com%' OR referrer LIKE '%t.co/%' OR referrer LIKE '%x.com%'
  OR referrer LIKE '%twitter.com%' OR referrer LIKE '%reddit.com%' OR referrer LIKE '%youtube.com%' OR referrer LIKE '%instagram.com%'
  OR referrer LIKE '%threads.net%' OR referrer LIKE '%linkedin.com%')`;

// The council's 60-day test (superai projects/albumverse/audit/claude-verdict.md), judged on 30 days:
// keep = 1,500+ organic visits AND 100+ actions; change = visits but < 100 actions; freeze = < 750 visits.
export function goalSummary(days = 30, host = 'albumverse.com') {
  const since = `datetime('now', '-${Math.max(1, Math.min(365, days | 0))} days')`;
  const human = `is_bot = 0 AND created_at >= ${since}`;
  const landings = db.prepare(
    `SELECT
       SUM(CASE WHEN ${ORGANIC_SQL} THEN 1 ELSE 0 END) AS organic,
       SUM(CASE WHEN ${SOCIAL_SQL} THEN 1 ELSE 0 END) AS social,
       SUM(CASE WHEN referrer IS NULL OR referrer = '' THEN 1 ELSE 0 END) AS direct,
       SUM(CASE WHEN referrer LIKE ? THEN 1 ELSE 0 END) AS internal,
       SUM(CASE WHEN query LIKE '%"ref":"yt"%' OR referrer LIKE '%youtube.com%' OR referrer LIKE '%youtu.be%' THEN 1 ELSE 0 END) AS youtube,
       COUNT(*) AS total
     FROM page_views WHERE ${human}`
  ).get(`%${host}%`);
  const n = (x) => Number(x || 0);
  const organic = n(landings.organic), social = n(landings.social), direct = n(landings.direct), internal = n(landings.internal);
  const actions = db.prepare(`SELECT type, COUNT(*) AS n FROM events WHERE ${human} GROUP BY type`).all();
  const byType = Object.fromEntries(actions.map((a) => [a.type, a.n]));
  const totalActions = actions.reduce((t, a) => t + a.n, 0);
  const organicPages = db.prepare(
    `SELECT path, COUNT(*) AS n FROM page_views WHERE ${human} AND ${ORGANIC_SQL} GROUP BY path ORDER BY n DESC LIMIT 15`
  ).all();
  const topOutbound = db.prepare(
    `SELECT detail, COUNT(*) AS n FROM events WHERE ${human} AND type = 'outbound' GROUP BY detail ORDER BY n DESC LIMIT 10`
  ).all();
  let verdict = 'collecting';
  if (organic >= 1500 && totalActions >= 100) verdict = 'keep';
  else if (organic >= 1500) verdict = 'change';
  else if (organic < 750) verdict = 'freeze (if this holds at the end of the test)';
  return {
    days, organic, social, direct, internal, youtube: n(landings.youtube), other: Math.max(0, n(landings.total) - organic - social - direct - internal),
    totalLandings: n(landings.total), actions: byType, totalActions, organicPages, topOutbound, verdict,
    targets: { organic: 1500, actions: 100, freezeBelow: 750 },
  };
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

  // Scoped to the last 2 days rather than all-time, since this exists to
  // diagnose a *current* traffic spike (a crawler that slips past the UA
  // regex, spread thin across thousands of distinct pages so it never shows
  // up in topPages/topReferrers) - all-time would dilute it into noise.
  const topUserAgents = db
    .prepare(
      `SELECT user_agent as userAgent, COUNT(*) as n, COUNT(DISTINCT path) as distinctPaths
       FROM page_views
       WHERE is_bot = 0 AND user_agent IS NOT NULL AND created_at >= datetime('now', '-2 days')
       GROUP BY user_agent ORDER BY n DESC LIMIT 15`
    )
    .all();

  const totalUsers = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  const usersToday = db.prepare("SELECT COUNT(*) as n FROM users WHERE created_at >= datetime('now', 'start of day')").get().n;
  const usersLast7d = db.prepare("SELECT COUNT(*) as n FROM users WHERE created_at >= datetime('now', '-7 days')").get().n;

  const recentSignups = db
    .prepare('SELECT username, created_at as createdAt FROM users ORDER BY created_at DESC, id DESC LIMIT 15')
    .all();

  return {
    totalViews, today, last7d, botViewsLast7d, botViewsTotal, dailyCounts, topPages, topSearches, topReferrers, topUserAgents,
    totalUsers, usersToday, usersLast7d, recentSignups,
  };
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
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, cover_art_url as coverArtUrl${ratingCols()}
       FROM albums
       ORDER BY added_at DESC, rowid DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

// Lighter than getArtistLocal() (skips the discography/appearances queries)
// for callers that only need to decide whether a Wikipedia bio/image lookup
// is worth doing - currently just wikidataDeaths.js, proactively filling
// in a freshly-detected death's photo before the social posters see it,
// same "bio === null means never looked up" logic server.js's /api/artist
// route uses reactively on a page view.
export function getArtistBioStatus(mbid) {
  return db.prepare('SELECT name, disambiguation, bio FROM artists WHERE mbid = ?').get(mbid);
}

// Name lookup for the one-off /admin/refresh-bio route (server.js) - every
// other artist lookup in this file goes by mbid, which an admin poking at a
// stuck bio from the browser won't have handy.
export function findArtistsByName(name, limit = 5) {
  return db
    .prepare(
      `SELECT mbid as id, name, disambiguation, bio, wiki_image_url as imageUrl, died_date as diedDate
       FROM artists WHERE name LIKE ? COLLATE NOCASE LIMIT ?`
    )
    .all(`%${name}%`, limit);
}

export function getArtistLocal(mbid) {
  const artist = db
    .prepare(
      `SELECT a.mbid as id, a.name, a.disambiguation, a.bio, a.wiki_url as wikiUrl,
       a.type, a.born_date as bornDate, a.died_date as diedDate,
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
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl${ratingCols('al.')}
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
      `SELECT DISTINCT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl${ratingCols('al.')}
       FROM albums al
       JOIN tracks t ON t.album_mbid = al.mbid
       JOIN track_credits tc ON tc.track_id = t.id
       WHERE tc.artist_mbid = ?
         AND NOT EXISTS (SELECT 1 FROM album_artists aa WHERE aa.album_mbid = al.mbid AND aa.artist_mbid = ?)
       ORDER BY al.release_date ASC`
    )
    .all(mbid, mbid);

  // What they did on each album: roles from track credits (MusicBrainz, linked by id) and from
  // album credits (Discogs, linked by name only - that's how most producers/engineers appear).
  const trackRoles = db
    .prepare(
      `SELECT t.album_mbid as id, tc.kind, tc.role, COUNT(DISTINCT t.id) as tracks
       FROM track_credits tc JOIN tracks t ON t.id = tc.track_id
       WHERE tc.artist_mbid = ? GROUP BY t.album_mbid, tc.kind, tc.role`
    )
    .all(mbid);
  const discogsRoles = db
    .prepare(
      `SELECT ac.album_mbid as id, ac.role FROM album_credits ac
       WHERE ac.name = ? COLLATE NOCASE`
    )
    .all(artist.name);
  const roles = new Map();
  const addRole = (id, role, tracks) => {
    if (!roles.has(id)) roles.set(id, { roles: new Set(), tracks: 0 });
    const r = roles.get(id);
    for (const part of String(role || '').split(/,\s*/)) if (part.trim()) r.roles.add(part.trim().toLowerCase());
    r.tracks = Math.max(r.tracks, tracks || 0);
  };
  for (const r of trackRoles) addRole(r.id, r.role || r.kind, r.tracks);
  for (const r of discogsRoles) addRole(r.id, r.role, 0);
  const known = new Set([...albums, ...appearances].map((a) => a.id));
  const discogsOnly = [...new Set(discogsRoles.map((r) => r.id))].filter((id) => !known.has(id));
  if (discogsOnly.length) {
    const more = db
      .prepare(
        `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl${ratingCols('al.')}
         FROM albums al WHERE al.mbid IN (${discogsOnly.map(() => '?').join(',')})`
      )
      .all(...discogsOnly);
    appearances.push(...more);
    appearances.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  }
  const withRoles = (a) => {
    const r = roles.get(a.id);
    return r ? { ...a, roles: [...r.roles].slice(0, 5), tracks: r.tracks } : a;
  };
  return { ...artist, albums: albums.map(withRoles), appearances: appearances.map(withRoles) };
}

// Used for the In Memoriam video (see youtubeShort.js) - a handful of album
// covers spread across an artist's career for a retrospective feel, rather
// than just whichever N albums happen to be earliest.
export function artistAlbumCoversForRetrospective(mbid, limit = 4) {
  const covers = db
    .prepare(
      `SELECT al.cover_art_url as coverArtUrl
       FROM albums al
       JOIN album_artists aa ON aa.album_mbid = al.mbid
       WHERE aa.artist_mbid = ? AND al.cover_art_url IS NOT NULL
       ORDER BY al.release_date ASC`
    )
    .all(mbid)
    .map((r) => r.coverArtUrl);
  if (covers.length <= limit) return covers;
  const step = (covers.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, i) => covers[Math.round(i * step)]);
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

// Lightweight rating badge for album cards everywhere (grid/rail), as
// correlated subqueries rather than a JOIN + GROUP BY - simpler to drop into
// each list query below without disturbing its own WHERE/GROUP BY/ORDER BY,
// and albums have few enough reviews that the per-row subquery cost is
// negligible. `prefix` is whatever the enclosing query's own albums-table
// alias is (e.g. 'al.'), or '' when the query selects from albums unaliased.
function ratingCols(prefix = '') {
  return `, ROUND((SELECT AVG(rating) FROM reviews WHERE album_mbid = ${prefix}mbid), 1) as avgRating,
       (SELECT COUNT(*) FROM reviews WHERE album_mbid = ${prefix}mbid) as ratingCount`;
}

// Excludes MusicBrainz genre-tagged classical albums - used only by the
// social posters' On This Day/Trending picks (see socialPoster.js,
// youtubeShort.js), not the on-site pages of the same name. Classical
// composers' catalogs are wildly overrepresented in the albums table
// (MusicBrainz treats every orchestra's every recording of the same work as
// its own release-group - see scripts/import.js), which skews both "on this
// day" date matches and raw view counts toward them despite that being a
// catalog-size artifact, not real listener interest - not what a social post
// aiming for a broadly recognizable pick wants.
function excludeClassicalSql(prefix = '') {
  return `NOT EXISTS (SELECT 1 FROM album_genres ag WHERE ag.album_mbid = ${prefix}mbid AND ag.genre LIKE '%classical%')`;
}

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
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl${ratingCols('al.')},
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

// Same ranking as trendingAlbums(), minus classical picks - see
// excludeClassicalSql(). Used only by socialPoster.js/youtubeShort.js: raw
// view counts on a catalog this classical-heavy reward catalog size as much
// as real listener interest, which isn't what a social post wants.
export function trendingAlbumsForSocial(limit = 20) {
  return db
    .prepare(
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl,
       COUNT(pv.id) as views
       FROM page_views pv
       JOIN albums al ON pv.path = '/album/' || al.mbid
       WHERE pv.is_bot = 0 AND pv.created_at >= datetime('now', '-7 days')
         AND ${excludeClassicalSql('al.')}
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
      `SELECT mbid as id, title, type, release_date as date, artist_credit as artist, cover_art_url as coverArtUrl${ratingCols()}
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
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl${ratingCols('al.')},
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
      `SELECT al.mbid as id, al.title, al.type, al.release_date as date, al.artist_credit as artist, al.cover_art_url as coverArtUrl${ratingCols('al.')}
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

export function getAppState(key) {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setAppState(key, value) {
  db.prepare(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export default db;
