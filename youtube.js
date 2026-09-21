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
  // A bad/expired refresh_token (see the 7-day Testing-mode cap noted at the
  // top of this file) fails right here with Google's own error body, e.g.
  // {"error":"invalid_grant","error_description":"Token has been expired or
  // revoked."} - exactly the detail worth keeping in `error` below rather
  // than collapsing into a generic failure.
  if (!res.ok) throw new Error(`token refresh ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

/**
 * Uploads `videoBuffer` (an mp4) to the configured YouTube channel. Returns
 * { videoId, error }: `videoId` is the new video's id on success, null
 * otherwise; `error` is null on success, or a message distinguishing
 * missing credentials from a failed request (token refresh or the upload
 * itself, including YouTube/Google's own error body) - same shape as
 * elevenlabs.js's synthesizeSpeech(), for the same reason: so callers can
 * report specifically why instead of every failure mode looking identical.
 */
export async function uploadShort(videoBuffer, { title, description, privacyStatus = 'public' }) {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    return { videoId: null, error: 'YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET/YOUTUBE_REFRESH_TOKEN not set.' };
  }

  try {
    const accessToken = await getAccessToken();

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
    return { videoId: video.id, error: null };
  } catch (err) {
    console.error('YouTube upload failed:', err.message);
    return { videoId: null, error: err.message };
  }
}
