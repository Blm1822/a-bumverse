// TTS narration for the daily YouTube Short - see video.js for how the
// resulting audio gets mixed with background music and burned-in captions.
// Best-effort, same shape as discogs.js/bluesky.js: no credentials, or any
// API failure, just means no video gets rendered that day, never an error
// that could take down the scheduler.

const TTS_ROOT = 'https://api.elevenlabs.io/v1/text-to-speech';

/**
 * Returns { audio, error }: `audio` is narration audio (MP3 bytes as a
 * Buffer) on success, null otherwise; `error` is null on success, or a
 * message distinguishing "not configured" from "the request itself failed"
 * (including ElevenLabs' own error body, e.g. quota_exceeded or an invalid
 * key) - callers that only cared about best-effort success/failure can keep
 * checking `audio`, but this lets buildDailyShort() (youtubeShort.js) report
 * specifically why, instead of every failure mode looking identical.
 */
export async function synthesizeSpeech(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) return { audio: null, error: 'ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID not set.' };

  try {
    const res = await fetch(`${TTS_ROOT}/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ElevenLabs TTS ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), error: null };
  } catch (err) {
    console.error('ElevenLabs TTS failed:', err.message);
    return { audio: null, error: err.message };
  }
}
