// Daily YouTube Short renderer. Builds a ~1080x1920 vertical video from a
// still image (cover art / artist photo), title/subtitle text, a TTS
// narration track, and a royalty-free background music bed - never the
// actual copyrighted recording, sidestepping the licensing problem entirely.
//
// Text is burned in via libass (an .ass subtitle file) rather than ffmpeg's
// own drawtext filter - the static ffmpeg binary this app ships (ffmpeg-static,
// a prebuilt johnvansickle.com build, chosen so Railway needs no OS-level
// ffmpeg install) doesn't compile drawtext in, but does include libass.

import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

// ASS text is its own tiny markup language - {\...} override tags and a
// handful of literal characters need escaping so a title with, say, a
// comma or curly brace in it can't corrupt the subtitle event line.
function escapeAss(text) {
  return String(text).replace(/[{}]/g, '').replace(/\n/g, '\\N');
}

function formatAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds - Math.floor(seconds)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// One style for the title (larger, higher) and one for the subtitle
// (smaller, just below it) - both anchored bottom-third via \an2 + MarginV
// so they read like a caption card over the zooming cover art.
function buildAssFile({ title, subtitle, durationSeconds }) {
  const end = formatAssTime(durationSeconds);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${WIDTH}
PlayResY: ${HEIGHT}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Title,DejaVu Sans,72,&H00FFFFFF,&H00000000,&HB0000000,1,3,3,0,2,60,60,520
Style: Subtitle,DejaVu Sans,46,&H00E8DCF9,&H00000000,&HB0000000,0,3,2,0,2,60,60,420

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,${end},Title,,0,0,0,,${escapeAss(title)}
Dialogue: 0,0:00:00.00,${end},Subtitle,,0,0,0,,${escapeAss(subtitle)}
`;
}

// No ffprobe ships with ffmpeg-static (just the ffmpeg binary itself), but
// ffmpeg prints a "Duration: 00:00:05.23" line to stderr for any input it
// opens - transcoding to /dev/null and scraping that line avoids adding a
// second binary just to measure one file.
export function getAudioDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-i', filePath, '-f', 'null', '-']);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', () => {
      const match = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (!match) return reject(new Error(`could not parse duration for ${filePath}`));
      const [, h, m, s] = match;
      resolve(Number(h) * 3600 + Number(m) * 60 + Number(s));
    });
  });
}

/**
 * Renders a vertical video: slow zoom on `imagePath`, a burned-in title/
 * subtitle caption, narration mixed over background music, trimmed to
 * `durationSeconds`.
 */
export async function renderVideo({ imagePath, title, subtitle, narrationPath, musicPath, durationSeconds, outPath }) {
  const assPath = path.join(os.tmpdir(), `albumverse-caption-${Date.now()}-${Math.random().toString(36).slice(2)}.ass`);
  await fs.writeFile(assPath, buildAssFile({ title, subtitle, durationSeconds }));

  try {
    await new Promise((resolve, reject) => {
      const frames = Math.round(durationSeconds * FPS);
      // libass's own filter needs its input path escaped for filtergraph
      // syntax - colons (drive letters on Windows, but also just risky in
      // general) and backslashes are the two characters that matter here.
      const assFilterPath = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

      const videoFilter = [
        `scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase,crop=${WIDTH * 2}:${HEIGHT * 2}`,
        `zoompan=z='min(zoom+0.0006,1.2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
        `ass=${assFilterPath}`,
      ].join(',');

      const args = [
        '-y',
        '-loop', '1', '-i', imagePath,
        '-i', narrationPath,
        '-stream_loop', '-1', '-i', musicPath,
        '-filter_complex',
        `[0:v]${videoFilter}[v];[2:a]volume=0.18[music];[1:a][music]amix=inputs=2:duration=first:dropout_transition=2[a]`,
        '-map', '[v]', '-map', '[a]',
        '-t', String(durationSeconds),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        outPath,
      ];

      const child = spawn(ffmpegPath, args);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve(outPath);
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
      });
    });
  } finally {
    await fs.unlink(assPath).catch(() => {});
  }

  return outPath;
}
