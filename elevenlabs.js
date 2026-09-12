// TTS narration for the daily YouTube Short - see video.js for how the
// resulting audio gets mixed with background music and burned-in captions.
// Best-effort, same shape as discogs.js/bluesky.js: no credentials, or any
// API failure, just means no video gets rendered that day, never an error
// that could take down the scheduler.

const TTS_ROOT = 'https://api.elevenlabs.io/v1/text-to-speech';

/**
 * Returns narration audio (MP3 bytes as a Buffer) for `text`, or null if
 * ElevenLabs isn't configured or the request fails.
 */
export async function synthesizeSpeech(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) return null;

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
    if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error('ElevenLabs TTS failed:', err.message);
    return null;
  }
}
