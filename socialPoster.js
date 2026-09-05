// Automated daily social post: picks the single most newsworthy thing to
// share - a new In Memoriam entry first, then today's "On this day" pick,
// then this week's #1 trending album - and posts it, recording what went
// out so a restart mid-day never double-posts and the same artist/album is
// never posted about twice.
//
// Checked hourly rather than on a precise midnight cron - simpler than
// adding a scheduling dependency, and "posted sometime in the hour after UTC
// midnight" is good enough for a once-a-day post. No credentials configured
// (see bluesky.js) just means this quietly does nothing, same "best-effort"
// shape as every other optional integration in this app.

import { inMemoriam, onThisDayAlbums, trendingAlbums, hasPostedToday, hasPostedAboutItem, recordSocialPost } from './db.js';
import { postToBluesky, truncateForBluesky } from './bluesky.js';

const SITE_URL = process.env.SITE_URL || 'https://albumverse.com';
const PLATFORM = 'bluesky';

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function inMemoriamPost() {
  const [artist] = inMemoriam(1);
  if (!artist || hasPostedAboutItem('in_memoriam', artist.id)) return null;
  const year = artist.diedDate ? artist.diedDate.slice(0, 4) : '';
  const url = `${SITE_URL}/artist/${artist.id}`;
  return {
    text: truncateForBluesky(`Remembering ${artist.name}${year ? ` (d. ${year})` : ''}. ${url}`),
    url,
    contentType: 'in_memoriam',
    itemId: artist.id,
  };
}

function onThisDayPost() {
  const albums = onThisDayAlbums(10);
  if (!albums.length) return null;
  // Most recent release (last in the release_date-ASC list) reads as the
  // more recognizable pick more often than the oldest, absent any other
  // "importance" signal to sort by.
  const album = albums[albums.length - 1];
  if (hasPostedAboutItem('on_this_day', album.id)) return null;
  const year = (album.date || '').slice(0, 4);
  const url = `${SITE_URL}/album/${album.id}`;
  return {
    text: truncateForBluesky(`On this day in ${year}, ${album.artist} released "${album.title}". ${url}`),
    url,
    contentType: 'on_this_day',
    itemId: album.id,
  };
}

function trendingPost() {
  const [album] = trendingAlbums(1);
  if (!album || !album.views || hasPostedAboutItem('trending', album.id)) return null;
  const url = `${SITE_URL}/album/${album.id}`;
  return {
    text: truncateForBluesky(`Trending on Albumverse this week: "${album.title}" by ${album.artist}. ${url}`),
    url,
    contentType: 'trending',
    itemId: album.id,
  };
}

async function checkAndPostDaily() {
  try {
    const date = todayUTC();
    if (hasPostedToday(PLATFORM, date)) return;

    const post = inMemoriamPost() || onThisDayPost() || trendingPost();
    if (!post) return; // nothing worth posting today - never force filler content

    const ok = await postToBluesky(post.text, post.url);
    if (ok) recordSocialPost(PLATFORM, date, post.contentType, post.itemId);
  } catch (err) {
    console.error('daily social post check failed:', err.message);
  }
}

export function startSocialPoster() {
  checkAndPostDaily();
  setInterval(checkAndPostDaily, 60 * 60 * 1000).unref();
}
