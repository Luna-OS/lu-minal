// Draws lu-minal's icon for Windows (the installer, lu-minal.exe and its shortcuts) as an .ico:
// the night-sky tile with the crescent moon, a few stars and the mint prompt - the same design as
// linux/lu-minal.svg and macos/scripts/make-icon.swift, in the SVG's 256-unit coordinates. No
// image library: each shape is tested per sample (4 x 4 per pixel), then the pixels are packed as
// BMP entries for the small sizes and a PNG entry for 256 px, which is what Windows expects.
//
//   bun scripts/windows-icon.ts <out.ico>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

/** The sizes in the .ico: Explorer, the taskbar, Start, the installer and high-DPI screens. */
export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256] as const;

type Rgb = readonly [number, number, number];

const hex = (h: number): Rgb => [(h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff];
const SKY_TOP = hex(0x1d1742);
const SKY_BOTTOM = hex(0x0b0920);
const MOON = hex(0xf4f1ff);
const PROMPT = hex(0x7fe3c6);
const STARS: Array<{ x: number; y: number; r: number; color: Rgb }> = [
  { x: 196, y: 150, r: 5, color: hex(0xe0c880) },
  { x: 60, y: 64, r: 4, color: hex(0xb9aefb) },
  { x: 206, y: 58, r: 3, color: hex(0xd6cffd) },
  { x: 40, y: 124, r: 3, color: hex(0xb9aefb) },
];

function inRoundedRect(x: number, y: number, left: number, top: number, w: number, h: number, r: number): boolean {
  if (x < left || y < top || x > left + w || y > top + h) return false;
  const cx = Math.min(Math.max(x, left + r), left + w - r);
  const cy = Math.min(Math.max(y, top + r), top + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const inCircle = (x: number, y: number, cx: number, cy: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Distance from (x, y) to the segment a-b. */
function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** The colour at a point of the 256-unit design, or null outside the tile (transparent). */
function colorAt(x: number, y: number): Rgb | null {
  if (!inRoundedRect(x, y, 8, 8, 240, 240, 56)) return null;
  // The prompt: a chevron stroked 13 wide with round ends and joins, then the cursor bar.
  if (inRoundedRect(x, y, 98, 200, 52, 13, 6.5)) return PROMPT;
  if (Math.min(segmentDistance(x, y, 58, 172, 84, 192), segmentDistance(x, y, 84, 192, 58, 212)) <= 6.5) return PROMPT;
  for (const s of STARS) if (inCircle(x, y, s.x, s.y, s.r)) return s.color;
  if (inCircle(x, y, 146, 104, 62) && !inCircle(x, y, 172, 82, 54)) return MOON;
  // The sky: a vertical gradient over the tile (8 ... 248).
  const t = (y - 8) / 240;
  return [0, 1, 2].map((i) => SKY_TOP[i] + (SKY_BOTTOM[i] - SKY_TOP[i]) * t) as unknown as Rgb;
}

/** The icon as straight (not premultiplied) RGBA, top row first. */
export function renderIcon(size: number, samples = 4): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const unit = 256 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const c = colorAt((px + (sx + 0.5) / samples) * unit, (py + (sy + 0.5) / samples) * unit);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          covered++;
        }
      }
      const i = (py * size + px) * 4;
      if (!covered) continue;
      out[i] = Math.round(r / covered);
      out[i + 1] = Math.round(g / covered);
      out[i + 2] = Math.round(b / covered);
      out[i + 3] = Math.round((covered / (samples * samples)) * 255);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG of straight RGBA pixels (8 bits per channel, no filtering). */
export function encodePng(rgba: Uint8Array, size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, no filter method extras, no interlace
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** An .ico image entry as a 32-bit BMP (bottom-up BGRA plus an empty AND mask, as Windows wants). */
function encodeBmpEntry(rgba: Uint8Array, size: number): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // the XOR image and the AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

/** The .ico with every size in ICON_SIZES: BMP entries up to 64 px, PNG for 256 px. */
export function buildIco(sizes: readonly number[] = ICON_SIZES): Buffer {
  const images = sizes.map((size) => {
    const rgba = renderIcon(size);
    return { size, data: size >= 256 ? encodePng(rgba, size) : encodeBmpEntry(rgba, size) };
  });
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // an icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    head[e] = img.size >= 256 ? 0 : img.size; // 0 means 256
    head[e + 1] = img.size >= 256 ? 0 : img.size;
    head.writeUInt16LE(1, e + 4); // colour planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(img.data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

/** Writes the .ico to `file` (its folder is created) and returns the path. */
export function writeIco(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildIco());
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write("usage: windows-icon.ts <out.ico>\n");
    process.exit(2);
  }
  process.stdout.write(`${writeIco(path.resolve(out))}\n`);
}
