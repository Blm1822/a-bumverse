// Bluesky (AT Protocol) client for the automated daily social post - see
// socialPoster.js for what gets posted and when. Best-effort, same shape as
// discogs.js/seatgeek.js/setlistfm.js: no credentials, or any failure, means
// no post today - never an error that could take down the scheduler.
//
// Auth is a fresh session per post rather than a cached token: this only
// ever posts about once a day, so there's no meaningful request volume to
// save by caching, and it sidesteps needing to handle an expired access JWT
// mid-day (Bluesky's are short-lived).

const BSKY_ROOT = 'https://bsky.social/xrpc';
// Bluesky's own limit is 300 *graphemes*; .length counts UTF-16 code units,
// which is only an approximation for non-ASCII text - fine here since every
// post template this app generates is plain English.
const MAX_LENGTH = 300;
// The PDS itself enforces 2MB for an uploaded blob - Wikipedia thumbnails
// are well under this, but checking ourselves means an unexpectedly large
// image degrades to a text-only post instead of failing the whole thing.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

async function getSession() {
  if (!process.env.BLUESKY_IDENTIFIER || !process.env.BLUESKY_APP_PASSWORD) return null;
  const res = await fetch(`${BSKY_ROOT}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifier: process.env.BLUESKY_IDENTIFIER,
      password: process.env.BLUESKY_APP_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`Bluesky auth ${res.status}`);
  return res.json();
}

// Byte-offset link facet, per AT Protocol's richtext spec - without this the
// URL in the post text is just plain unlinked text, not a real link.
function linkFacet(text, url) {
  const idx = text.indexOf(url);
  if (idx === -1) return [];
  const encoder = new TextEncoder();
  const byteStart = encoder.encode(text.slice(0, idx)).length;
  const byteEnd = byteStart + encoder.encode(url).length;
  return [{
    index: { byteStart, byteEnd },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
  }];
}

export function truncateForBluesky(text) {
  return text.length <= MAX_LENGTH ? text : `${text.slice(0, MAX_LENGTH - 1)}…`;
}

// Fetches `imageUrl` and uploads it as a blob for use in a post embed.
// Returns the blob reference, or null on any failure/oversized image -
// the caller falls back to a text-only post rather than losing the post
// entirely over an image that didn't cooperate.
async function uploadImage(session, imageUrl) {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const bytes = Buffer.from(await imgRes.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return null;

    const uploadRes = await fetch(`${BSKY_ROOT}/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Authorization: `Bearer ${session.accessJwt}` },
      body: bytes,
    });
    if (!uploadRes.ok) return null;
    const data = await uploadRes.json();
    return data.blob;
  } catch (err) {
    console.error('Bluesky image upload failed:', err.message);
    return null;
  }
}

export async function postToBluesky(text, url, imageUrl, imageAlt) {
  try {
    const session = await getSession();
    if (!session) return false;

    const blob = imageUrl ? await uploadImage(session, imageUrl) : null;
    const record = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      facets: url ? linkFacet(text, url) : [],
      ...(blob && {
        embed: {
          $type: 'app.bsky.embed.images',
          images: [{ image: blob, alt: imageAlt || '' }],
        },
      }),
    };
    const res = await fetch(`${BSKY_ROOT}/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessJwt}` },
      body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
    });
    if (!res.ok) throw new Error(`Bluesky post ${res.status}`);
    return true;
  } catch (err) {
    console.error('Bluesky post failed:', err.message);
    return false;
  }
}
