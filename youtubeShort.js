// Daily YouTube Short: same "one most-newsworthy thing" cascade as
// socialPoster.js (In Memoriam > On This Day > Trending), rendered as a
// vertical video instead of a text post. Content types use a "_yt" suffix
// so this doesn't share dedup state with the Bluesky poster - hasPostedAboutItem()
// isn't platform-scoped, so without the suffix the two posters would "steal"
// content from each other (whichever platform posts about an item first
// would block the other from ever covering it).
//
// Upload is wired up (see youtube.js) and checkAndPostShort() below does
// both the render and the real public upload on its hourly schedule. For a
// manual, safe-to-repeat check of the pipeline against production, see the
// /admin/render-test-short (render only) and /admin/upload-test-short
// (render + upload as a private video) routes in server.js instead.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { inMemoriam, onThisDayAlbumsForSocial, trendingAlbumsForSocial, hasPostedToday, hasPostedAboutItem, recordSocialPost, artistAlbumCoversForRetrospective } from './db.js';
import { synthesizeSpeech } from './elevenlabs.js';
import { renderVideo, getAudioDurationSeconds } from './video.js';
import { uploadShort } from './youtube.js';

const SITE_URL = process.env.SITE_URL || 'https://albumverse.com';
const PLATFORM = 'youtube';
const MUSIC_DIR = path.join(new URL('.', import.meta.url).pathname, 'assets', 'music');
const END_PADDING_SECONDS = 1.5; // breathing room after narration ends before the video cuts

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function inMemoriamScript() {
  const [artist] = inMemoriam(1);
  if (!artist || hasPostedAboutItem('in_memoriam_yt', artist.id)) return null;
  const year = artist.diedDate ? artist.diedDate.slice(0, 4) : '';
  // Their own photo first (if we have one), then a career-spanning run of
  // album covers - a retrospective feel rather than one static image.
  const albumCovers = artistAlbumCoversForRetrospective(artist.id, 4);
  const imageUrls = [artist.imageUrl, ...albumCovers].filter(Boolean);
  return {
    title: `Remembering ${artist.name}`,
    subtitle: year ? `d. ${year}` : '',
    narration: `Remembering ${artist.name}${year ? `, who passed away in ${year}` : ''}. Explore their full discography on Albumverse.`,
    imageUrls,
    contentType: 'in_memoriam_yt',
    itemId: artist.id,
    url: `${SITE_URL}/artist/${artist.id}`,
  };
}

function onThisDayScript() {
  // Classical excluded (see the matching note in socialPoster.js's
  // onThisDayPost()) - not filtered on the site's own On This Day page,
  // only here.
  const albums = onThisDayAlbumsForSocial(10);
  if (!albums.length) return null;
  const album = albums[albums.length - 1];
  if (hasPostedAboutItem('on_this_day_yt', album.id)) return null;
  const year = (album.date || '').slice(0, 4);
  return {
    title: `On This Day: ${album.title}`,
    subtitle: `${album.artist} · ${year}`,
    narration: `On this day in ${year}, ${album.artist} released "${album.title}." See the full tracklist and credits on Albumverse.`,
    imageUrls: [album.coverArtUrl].filter(Boolean),
    contentType: 'on_this_day_yt',
    itemId: album.id,
    url: `${SITE_URL}/album/${album.id}`,
  };
}

function trendingScript() {
  const [album] = trendingAlbumsForSocial(1);
  if (!album || !album.views || hasPostedAboutItem('trending_yt', album.id)) return null;
  return {
    title: `Trending: ${album.title}`,
    subtitle: album.artist,
    narration: `Trending on Albumverse this week: "${album.title}" by ${album.artist}. See what listeners are saying.`,
    imageUrls: [album.coverArtUrl].filter(Boolean),
    contentType: 'trending_yt',
    itemId: album.id,
    url: `${SITE_URL}/album/${album.id}`,
  };
}

async function downloadToTemp(url, tmpDir, index) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  const dest = path.join(tmpDir, `cover${index}${ext}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function pickMusicTrack() {
  const files = (await fs.readdir(MUSIC_DIR).catch(() => []))
    .filter((f) => /\.(mp3|m4a|wav)$/i.test(f));
  if (!files.length) return null;
  return path.join(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

// Distinguishable stand-in for "nothing happened, and here's specifically
// why" - plain `null` couldn't carry that, which made both admin diagnostic
// routes in server.js dead-end at a generic "see server logs" no matter which
// of several very different causes (nothing new to cover vs. ElevenLabs down
// vs. no music track vs. every image download failing) was actually behind
// it. skipped() stays close to a boolean falsy check (`if (!result)` still
// worked before; callers now check `result.skipped` instead) while giving
// both admin routes and checkAndPostShort's own error log a real reason.
function skipped(reason) {
  return { skipped: true, reason };
}

/**
 * Picks today's content (if any, and if not already covered), synthesizes
 * narration, and renders the finished vertical video. Returns
 * { skipped: false, outPath, contentType, itemId, url } on success, or
 * { skipped: true, reason } if there's nothing to post today,
 * credentials/assets aren't configured, or something failed - mirrors
 * socialPoster.js's "never force filler, never throw" shape.
 */
export async function buildDailyShort() {
  // A death is a one-time, time-sensitive event worth posting about the
  // moment it's detected - not something that should wait until tomorrow
  // just because an On This Day/Trending pick already went out today.
  // Checked ahead of and regardless of the daily cap below;
  // hasPostedAboutItem still guarantees the same artist never posts twice.
  const script = inMemoriamScript() || (hasPostedToday(PLATFORM, todayUTC()) ? null : (onThisDayScript() || trendingScript()));
  if (!script) return skipped('Nothing new to cover today (already posted about everything current In Memoriam/On This Day/Trending picks have to offer).');
  if (!script.imageUrls.length) return skipped(`Picked "${script.title}" but it has no usable image URLs to build a video from.`);

  const musicPath = await pickMusicTrack();
  if (!musicPath) return skipped('No royalty-free background tracks in assets/music/ - see assets/music/README.md.');

  const tmpDir = path.join(os.tmpdir(), `albumverse-short-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const narrationAudio = await synthesizeSpeech(script.narration);
    if (!narrationAudio) return skipped('ElevenLabs narration failed - ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID missing, or the request itself failed (see server logs for the specific TTS error).');

    const narrationPath = path.join(tmpDir, 'narration.mp3');
    await fs.writeFile(narrationPath, narrationAudio);

    // A stale/broken cover art URL shouldn't sink the whole render when
    // other images are fine - keep whichever ones actually downloaded.
    const downloads = await Promise.allSettled(
      script.imageUrls.map((url, i) => downloadToTemp(url, tmpDir, i))
    );
    const imagePaths = downloads.filter((d) => d.status === 'fulfilled').map((d) => d.value);
    if (!imagePaths.length) return skipped(`Picked "${script.title}" but every one of its ${script.imageUrls.length} image URL(s) failed to download.`);

    const narrationSeconds = await getAudioDurationSeconds(narrationPath);
    const outPath = path.join(tmpDir, 'short.mp4');

    await renderVideo({
      imagePaths,
      title: script.title,
      subtitle: script.subtitle,
      narrationPath,
      musicPath,
      durationSeconds: narrationSeconds + END_PADDING_SECONDS,
      outPath,
    });

    return {
      skipped: false,
      outPath,
      contentType: script.contentType,
      itemId: script.itemId,
      url: script.url,
      title: script.title,
      description: `${script.narration} ${script.url}`,
    };
  } catch (err) {
    console.error('daily short render failed:', err.message);
    await fs.rm(tmpDir, { recursive: true, force: true });
    return skipped(`Render threw: ${err.message}`);
  }
}

// Call once the render is confirmed uploaded, so tomorrow's cascade moves on
// to the next thing rather than re-picking the same item.
export function recordShortPosted(contentType, itemId) {
  recordSocialPost(PLATFORM, todayUTC(), contentType, itemId);
}

export async function checkAndPostShort() {
  let result;
  try {
    result = await buildDailyShort();
    if (result.skipped) {
      console.log('daily short skipped:', result.reason);
      return;
    }

    const videoBuffer = await fs.readFile(result.outPath);
    const videoId = await uploadShort(videoBuffer, {
      title: result.title,
      description: result.description,
      privacyStatus: 'public',
    });
    if (videoId) recordShortPosted(result.contentType, result.itemId);
  } catch (err) {
    console.error('daily short post check failed:', err.message);
  } finally {
    if (result && !result.skipped) await fs.rm(path.dirname(result.outPath), { recursive: true, force: true }).catch(() => {});
  }
}

// Checked hourly rather than on a precise schedule - same reasoning as
// socialPoster.js: simpler than a cron dependency, and "sometime in the
// hour after boot, then every hour after" is good enough for a once-a-day
// upload.
export function startYoutubePoster() {
  checkAndPostShort();
  setInterval(checkAndPostShort, 60 * 60 * 1000).unref();
}
