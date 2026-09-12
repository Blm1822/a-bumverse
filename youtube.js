// YouTube upload client for the daily Short (see youtubeShort.js for how the
// video itself gets built). Best-effort, same shape as every other optional
// integration here: missing credentials, or any failure, just means the
// video doesn't get uploaded that day - never an error that could take
// down the scheduler.
//
// Auth is OAuth2 (an API key alone can't authorize a write like a video
// upload) via a refresh token generated once through a manual one-time
// login - see the project notes for that flow. While the Google Cloud
// OAuth app is in "Testing" mode (the default, and fine for a single-user
// tool like this), Google caps refresh tokens at 7 days, so this token
// needs periodically regenerating the same way until/unless the app goes
// through Google's verification to move to "In production".

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

async function getAccessToken() {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) return null;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: YOUTUBE_CLIENT_ID,
      client_secret: YOUTUBE_CLIENT_SECRET,
      refresh_token: YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

/**
 * Uploads `videoBuffer` (an mp4) to the configured YouTube channel.
 * Returns the new video's id, or null if credentials are missing or
 * anything failed.
 */
export async function uploadShort(videoBuffer, { title, description, privacyStatus = 'public' }) {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return null;

    // Resumable upload: first request registers the video's metadata and
    // gets back a session URL, second request PUTs the actual video bytes -
    // two calls even though we send it all at once, per YouTube's protocol.
    const initRes = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(videoBuffer.length),
      },
      body: JSON.stringify({
        snippet: { title, description, categoryId: '10' }, // 10 = Music
        status: { privacyStatus, selfDeclaredMadeForKids: false },
      }),
    });
    if (!initRes.ok) throw new Error(`upload init ${initRes.status}: ${await initRes.text()}`);
    const sessionUrl = initRes.headers.get('location');
    if (!sessionUrl) throw new Error('no resumable session URL returned');

    const uploadRes = await fetch(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(videoBuffer.length) },
      body: videoBuffer,
    });
    if (!uploadRes.ok) throw new Error(`upload ${uploadRes.status}: ${await uploadRes.text()}`);

    const video = await uploadRes.json();
    return video.id;
  } catch (err) {
    console.error('YouTube upload failed:', err.message);
    return null;
  }
}
