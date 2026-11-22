// Generates public/icon-192.png and public/icon-512.png (a simple mushroom on green).
// No image libraries needed: draws pixels and writes a PNG with Node's zlib.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const GREEN = [22, 101, 52];
const CREAM = [247, 247, 242];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function pixel(x, y) {
  // Coordinates normalised to 0..1. Shapes are kept inside the maskable safe zone.
  const capCx = 0.5, capCy = 0.52, capR = 0.3;
  const inCap = y <= capCy && (x - capCx) ** 2 + ((y - capCy) / 0.8) ** 2 <= capR ** 2;
  const inStem = x >= 0.42 && x <= 0.58 && y > capCy - 0.01 && y <= 0.76;
  const spot1 = (x - 0.4) ** 2 + (y - 0.38) ** 2 <= 0.035 ** 2;
  const spot2 = (x - 0.6) ** 2 + (y - 0.34) ** 2 <= 0.03 ** 2;
  if ((inCap && !spot1 && !spot2) || inStem) return CREAM;
  return GREEN;
}

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x / size, y / size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [192, 512]) {
  writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), png(s));
  console.log(`wrote public/icon-${s}.png`);
}
