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

import { inMemoriam, onThisDayAlbumsForSocial, trendingAlbumsForSocial, hasPostedToday, hasPostedAboutItem, recordSocialPost } from './db.js';
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
    imageUrl: artist.imageUrl,
    imageAlt: artist.name,
  };
}

function onThisDayPost() {
  // Classical excluded here (but not on the site's own On This Day page) -
  // its catalog is wildly overrepresented (see excludeClassicalSql() in
  // db.js), so an unfiltered pick skews toward it far more than real
  // listener interest would justify for something meant to read as broadly
  // recognizable.
  const albums = onThisDayAlbumsForSocial(10);
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
  const [album] = trendingAlbumsForSocial(1);
  if (!album || !album.views || hasPostedAboutItem('trending', album.id)) return null;
  const url = `${SITE_URL}/album/${album.id}`;
  return {
    text: truncateForBluesky(`Trending on Albumverse this week: "${album.title}" by ${album.artist}. ${url}`),
    url,
    contentType: 'trending',
    itemId: album.id,
  };
}

export async function checkAndPostDaily() {
  try {
    const date = todayUTC();

    // A death is a one-time, time-sensitive event worth posting the moment
    // it's detected - not something that should wait until tomorrow just
    // because an On This Day/Trending pick already went out today. Checked
    // (and posted) unconditionally, ahead of and regardless of the daily cap
    // below; hasPostedAboutItem still guarantees the same artist never posts
    // twice, so this can't loop or repeat.
    const memoriam = inMemoriamPost();
    if (memoriam) {
      const ok = await postToBluesky(memoriam.text, memoriam.url, memoriam.imageUrl, memoriam.imageAlt);
      if (ok) recordSocialPost(PLATFORM, date, memoriam.contentType, memoriam.itemId);
      return;
    }

    if (hasPostedToday(PLATFORM, date)) return;
    const post = onThisDayPost() || trendingPost();
    if (!post) return; // nothing worth posting today - never force filler content

    const ok = await postToBluesky(post.text, post.url, post.imageUrl, post.imageAlt);
    if (ok) recordSocialPost(PLATFORM, date, post.contentType, post.itemId);
  } catch (err) {
    console.error('daily social post check failed:', err.message);
  }
}

export function startSocialPoster() {
  checkAndPostDaily();
  setInterval(checkAndPostDaily, 60 * 60 * 1000).unref();
}
