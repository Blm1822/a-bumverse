// Daily YouTube Short: same "one most-newsworthy thing" cascade as
// socialPoster.js (In Memoriam > On This Day > Trending), rendered as a
// vertical video instead of a text post. Content types use a "_yt" suffix
// so this doesn't share dedup state with the Bluesky poster - hasPostedAboutItem()
// isn't platform-scoped, so without the suffix the two posters would "steal"
// content from each other (whichever platform posts about an item first
// would block the other from ever covering it).
//
// This module only gets as far as producing a finished .mp4 file - actual
// upload to YouTube needs its own OAuth setup and isn't wired up yet. See
// scripts/render-daily-short.js for a manually-runnable entry point.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { inMemoriam, onThisDayAlbums, trendingAlbums, hasPostedToday, hasPostedAboutItem, recordSocialPost } from './db.js';
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
  return {
    title: `Remembering ${artist.name}`,
    subtitle: year ? `d. ${year}` : '',
    narration: `Remembering ${artist.name}${year ? `, who passed away in ${year}` : ''}. Explore their full discography on Albumverse.`,
    imageUrl: artist.imageUrl,
    contentType: 'in_memoriam_yt',
    itemId: artist.id,
    url: `${SITE_URL}/artist/${artist.id}`,
  };
}

function onThisDayScript() {
  const albums = onThisDayAlbums(10);
  if (!albums.length) return null;
  const album = albums[albums.length - 1];
  if (hasPostedAboutItem('on_this_day_yt', album.id)) return null;
  const year = (album.date || '').slice(0, 4);
  return {
    title: `On This Day: ${album.title}`,
    subtitle: `${album.artist} · ${year}`,
    narration: `On this day in ${year}, ${album.artist} released "${album.title}." See the full tracklist and credits on Albumverse.`,
    imageUrl: album.coverArtUrl,
    contentType: 'on_this_day_yt',
    itemId: album.id,
    url: `${SITE_URL}/album/${album.id}`,
  };
}

function trendingScript() {
  const [album] = trendingAlbums(1);
  if (!album || !album.views || hasPostedAboutItem('trending_yt', album.id)) return null;
  return {
    title: `Trending: ${album.title}`,
    subtitle: album.artist,
    narration: `Trending on Albumverse this week: "${album.title}" by ${album.artist}. See what listeners are saying.`,
    imageUrl: album.coverArtUrl,
    contentType: 'trending_yt',
    itemId: album.id,
    url: `${SITE_URL}/album/${album.id}`,
  };
}

async function downloadToTemp(url, tmpDir) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  const dest = path.join(tmpDir, `cover${ext}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function pickMusicTrack() {
  const files = (await fs.readdir(MUSIC_DIR).catch(() => []))
    .filter((f) => /\.(mp3|m4a|wav)$/i.test(f));
  if (!files.length) return null;
  return path.join(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

/**
 * Picks today's content (if any, and if not already covered), synthesizes
 * narration, and renders the finished vertical video. Returns
 * { outPath, contentType, itemId, url } or null if there's nothing to post
 * today, credentials/assets aren't configured, or something failed -
 * mirrors socialPoster.js's "never force filler, never throw" shape.
 */
export async function buildDailyShort() {
  const date = todayUTC();
  if (hasPostedToday(PLATFORM, date)) return null;

  const script = inMemoriamScript() || onThisDayScript() || trendingScript();
  if (!script || !script.imageUrl) return null;

  const musicPath = await pickMusicTrack();
  if (!musicPath) return null; // no royalty-free tracks added yet - see assets/music/README.md

  const tmpDir = path.join(os.tmpdir(), `albumverse-short-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const narrationAudio = await synthesizeSpeech(script.narration);
    if (!narrationAudio) return null; // ElevenLabs not configured, or the request failed

    const narrationPath = path.join(tmpDir, 'narration.mp3');
    await fs.writeFile(narrationPath, narrationAudio);

    const imagePath = await downloadToTemp(script.imageUrl, tmpDir);
    const narrationSeconds = await getAudioDurationSeconds(narrationPath);
    const outPath = path.join(tmpDir, 'short.mp4');

    await renderVideo({
      imagePath,
      title: script.title,
      subtitle: script.subtitle,
      narrationPath,
      musicPath,
      durationSeconds: narrationSeconds + END_PADDING_SECONDS,
      outPath,
    });

    return {
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
    return null;
  }
}

// Call once the render is confirmed uploaded, so tomorrow's cascade moves on
// to the next thing rather than re-picking the same item.
export function recordShortPosted(contentType, itemId) {
  recordSocialPost(PLATFORM, todayUTC(), contentType, itemId);
}

async function checkAndPostShort() {
  let result;
  try {
    result = await buildDailyShort();
    if (!result) return; // nothing to cover today, or a required piece isn't configured

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
    if (result) await fs.rm(path.dirname(result.outPath), { recursive: true, force: true }).catch(() => {});
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
