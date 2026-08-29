// One-off PWA icon generator - writes plain PNGs by hand (raw pixels -> zlib
// deflate -> PNG chunks) so we don't need any image library or native
// dependency just to ship two gradient tiles.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeCrcTable() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerp(a, b, t) { return a + (b - a) * t; }
function mixRgb(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
// Soft ~1px antialiased edge: 1 = fully inside, 0 = fully outside.
function coverage(distPastEdge) { return Math.min(1, Math.max(0, 0.5 - distPastEdge)); }

function makeIcon(size, outPath) {
  const bg = hexToRgb('#171429'); // matches favicon.svg background
  const c1 = hexToRgb('#a78bfa'); // violet
  const c2 = hexToRgb('#f472b6'); // pink

  const cx = size / 2;
  const cy = size / 2;
  const ringR = size * 0.21875; // matches favicon.svg: r=14 / (viewBox half 32)
  const strokeW = size * 0.0625; // matches favicon.svg: stroke-width=4 / 32
  const dotR = size * 0.0625; // matches favicon.svg: r=4 / 32
  const innerR = ringR - strokeW / 2;
  const outerR = ringR + strokeW / 2;

  const raw = Buffer.alloc(size * (1 + size * 4));
  let pos = 0;
  for (let y = 0; y < size; y++) {
    raw[pos++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const t = (x + y) / (2 * (size - 1)); // gradient direction for the logo mark

      let color = bg;
      const ringAlpha = Math.min(coverage(d - outerR), coverage(innerR - d));
      if (ringAlpha > 0) color = mixRgb(color, mixRgb(c1, c2, t), ringAlpha);
      const dotAlpha = coverage(d - dotR);
      if (dotAlpha > 0) color = mixRgb(color, mixRgb(c1, c2, t), dotAlpha);

      raw[pos++] = Math.round(color[0]);
      raw[pos++] = Math.round(color[1]);
      raw[pos++] = Math.round(color[2]);
      raw[pos++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(outPath, png);
  console.log('wrote', outPath, `(${png.length} bytes)`);
}

const publicDir = path.join(__dirname, '..', 'public');
makeIcon(192, path.join(publicDir, 'icon-192.png'));
makeIcon(512, path.join(publicDir, 'icon-512.png'));
