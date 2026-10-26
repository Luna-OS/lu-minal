// Draws lu-minal's icon for Windows (the installer, lu-minal.exe and its shortcuts) as an .ico:
// the night-sky tile with the glowing crescent moon, a gold sparkle, a few stars and the mint
// prompt - the same design as linux/lu-minal.svg and macos/scripts/make-icon.swift, in the SVG's
// 256-unit coordinates and with its gradient stops. No image library: the layers (gradients,
// glows, shapes) are composited per sample (4 x 4 per pixel), then the pixels are packed as BMP
// entries for the small sizes and a PNG entry for 256 px, which is what Windows expects.
//
//   bun scripts/windows-icon.ts <out.ico>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

/** The sizes in the .ico: Explorer, the taskbar, Start, the installer and high-DPI screens. */
export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256] as const;

type Rgb = readonly [number, number, number];
/** A gradient stop: its offset (0 ... 1), colour and opacity. */
type Stop = readonly [offset: number, color: Rgb, opacity: number];

const hex = (h: number): Rgb => [(h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff];
const NIGHT_950 = hex(0x0b0920);
const LAVENDER_400 = hex(0xb9aefb);
const LAVENDER_200 = hex(0xd6cffd);
const GOLD = hex(0xe0c880);
const MINT_400 = hex(0x7fe3c6);
const WHITE = hex(0xffffff);

/** The rounded tile; everything outside it is transparent. */
const TILE = { x: 8, y: 8, size: 240, radius: 56 };
/** The sky: diagonal, deep violet at the top-left corner to night-950 at the bottom-right. */
const SKY: readonly Stop[] = [
  [0, hex(0x3a2a80), 1],
  [0.45, hex(0x1d1742), 1],
  [1, NIGHT_950, 1],
];
/** A faint highlight along the tile's top edge, 2 units wide, fading out by y = 120. */
const RIM: readonly Stop[] = [
  [0, WHITE, 0.2],
  [1, WHITE, 0],
];
/** The moonlight: a soft lavender glow behind the crescent. */
const GLOW = {
  x: 132,
  y: 112,
  r: 124,
  stops: [
    [0, LAVENDER_400, 0.34],
    [0.25, LAVENDER_400, 0.2],
    [0.5, LAVENDER_400, 0.09],
    [0.75, LAVENDER_400, 0.025],
    [1, LAVENDER_400, 0],
  ] as readonly Stop[],
};
/** The crescent: the moon's disc minus the shade's disc, lit white at the bottom-left. */
const MOON = { x: 146, y: 100, r: 68 };
const SHADE = { x: 176, y: 76, r: 58 };
const MOONLIGHT = {
  from: [104, 142] as const,
  to: [188, 58] as const,
  stops: [
    [0, WHITE, 1],
    [0.55, hex(0xf4f1ff), 1],
    [1, LAVENDER_200, 1],
  ] as readonly Stop[],
};
/** The halo hugging the crescent, like the crescent blurred with this standard deviation. */
const HALO = { color: LAVENDER_200, opacity: 0.55, sigma: 6 };
/** The sparkle: a 4-point star of quadratic curves from tip to tip, their control points at
 *  (x +- waist, y +- waist), white-hot at the centre to gold, in a gold glow. */
const SPARKLE = {
  x: 196,
  y: 64,
  r: 24,
  waist: 4,
  stops: [
    [0, hex(0xfffbef), 1],
    [0.3, hex(0xf7e2a6), 1],
    [1, GOLD, 1],
  ] as readonly Stop[],
  glow: [
    [0, GOLD, 0.45],
    [0.4, GOLD, 0.14],
    [1, GOLD, 0],
  ] as readonly Stop[],
  glowR: 34,
};
/** Small stars of different sizes; left out below 32 px, where they would only be noise. */
const STARS: ReadonlyArray<{ x: number; y: number; r: number; color: Rgb }> = [
  { x: 54, y: 62, r: 5, color: LAVENDER_400 },
  { x: 100, y: 30, r: 3, color: LAVENDER_200 },
  { x: 222, y: 150, r: 4, color: LAVENDER_200 },
  { x: 208, y: 210, r: 3, color: LAVENDER_400 },
];
/** The prompt: a chevron (stroked, round caps and join) and the cursor bar. */
const CHEVRON = [
  [60, 166],
  [88, 188],
  [60, 210],
] as const;
const PROMPT_STROKE = 17;
const CURSOR = { x: 104, y: 201, w: 52, h: 17 };
/** The prompt's phosphor glow, like the prompt blurred with this standard deviation. */
const PROMPT_GLOW = { opacity: 0.4, sigma: 5 };

/** Signed distance from (x, y) to the edge of a rounded rectangle: negative inside. */
function roundedRectDistance(x: number, y: number, left: number, top: number, w: number, h: number, r: number): number {
  const qx = Math.abs(x - (left + w / 2)) - (w / 2 - r);
  const qy = Math.abs(y - (top + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 0.5 * erfc(d / (sigma * sqrt 2)): how much of a shape blurred with `sigma` reaches a point at
 *  distance d outside its edge (the logistic curve is close enough to erfc). */
const blurred = (d: number, sigma: number) => 1 / (1 + Math.exp((1.702 * d) / sigma));

const inCircle = (x: number, y: number, cx: number, cy: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Distance from (x, y) to the segment a-b. */
function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** The crescent's two horn tips, where the moon's and the shade's circles cross. */
const TIPS = (() => {
  const dx = SHADE.x - MOON.x;
  const dy = SHADE.y - MOON.y;
  const d = Math.hypot(dx, dy);
  const a = (d * d + MOON.r ** 2 - SHADE.r ** 2) / (2 * d);
  const h = Math.sqrt(MOON.r ** 2 - a * a);
  const mx = MOON.x + (a * dx) / d;
  const my = MOON.y + (a * dy) / d;
  return [
    [mx - (h * dy) / d, my + (h * dx) / d],
    [mx + (h * dy) / d, my - (h * dx) / d],
  ] as const;
})();

/** Distance from (x, y), outside the crescent, to its nearest point: on the moon's outer arc, on
 *  the shade's inner arc, or at a tip. */
function crescentDistance(x: number, y: number): number {
  const d1 = Math.hypot(x - MOON.x, y - MOON.y);
  const d2 = Math.hypot(x - SHADE.x, y - SHADE.y);
  let best = Math.min(...TIPS.map(([tx, ty]) => Math.hypot(x - tx, y - ty)));
  // The nearest point of each circle lies on the ray from its centre; it counts if it is on the arc.
  if (d1 > 0) {
    const px = MOON.x + ((x - MOON.x) * MOON.r) / d1;
    const py = MOON.y + ((y - MOON.y) * MOON.r) / d1;
    if (!inCircle(px, py, SHADE.x, SHADE.y, SHADE.r)) best = Math.min(best, Math.abs(d1 - MOON.r));
  }
  if (d2 > 0) {
    const px = SHADE.x + ((x - SHADE.x) * SHADE.r) / d2;
    const py = SHADE.y + ((y - SHADE.y) * SHADE.r) / d2;
    if (inCircle(px, py, MOON.x, MOON.y, MOON.r)) best = Math.min(best, Math.abs(d2 - SHADE.r));
  }
  return best;
}

/** Whether (x, y) is inside the sparkle: each quarter is bounded by the quadratic curve from one
 *  tip to the next with its control point at (waist, waist), the same path as the SVG's. */
function inSparkle(x: number, y: number): boolean {
  const { r, waist: k } = SPARKLE;
  const u = Math.abs(x - SPARKLE.x);
  const v = Math.abs(y - SPARKLE.y);
  if (u > r || v > r) return false;
  // The curve (0, r) -> (r, 0): x(t) = (r - 2k) t^2 + 2k t, solved for t, then y(t) is the bound.
  const a = r - 2 * k;
  const t = a === 0 ? u / (2 * k) : (-2 * k + Math.sqrt(4 * k * k + 4 * a * u)) / (2 * a);
  return v <= (1 - t) ** 2 * r + 2 * t * (1 - t) * k;
}

/** The colour and opacity of a gradient at `t` (clamped to 0 ... 1), interpolated between its
 *  stops the way SVG and Core Graphics do it. */
function gradientAt(stops: readonly Stop[], t: number): [Rgb, number] {
  const at = Math.max(0, Math.min(1, t));
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < at) i++;
  const [o0, c0, a0] = stops[i - 1];
  const [o1, c1, a1] = stops[i];
  const f = o1 > o0 ? Math.max(0, Math.min(1, (at - o0) / (o1 - o0))) : 1;
  return [[0, 1, 2].map((n) => c0[n] + (c1[n] - c0[n]) * f) as unknown as Rgb, a0 + (a1 - a0) * f];
}

/** Where (x, y) falls on the line from `from` (0) to `to` (1), as in a linear gradient. */
function along(x: number, y: number, from: readonly [number, number], to: readonly [number, number]): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return ((x - from[0]) * dx + (y - from[1]) * dy) / (dx * dx + dy * dy);
}

/** `paint` at its opacity over the opaque colour `under`. */
function over(under: Rgb, [paint, opacity]: [Rgb, number]): Rgb {
  if (opacity <= 0) return under;
  return [0, 1, 2].map((n) => under[n] + (paint[n] - under[n]) * opacity) as unknown as Rgb;
}

/** The colour at a point of the 256-unit design, or null outside the tile (transparent). The
 *  layers are composited bottom to top, in the SVG's order. `unit` is the size of a pixel in
 *  design units: below 32 px the stars, the rim and the prompt's glow are left out and the moon's
 *  glows are halved (they would only muddy the shapes), and the prompt never gets thinner than
 *  1.5 px. */
function colorAt(x: number, y: number, unit = 1): Rgb | null {
  const edge = roundedRectDistance(x, y, TILE.x, TILE.y, TILE.size, TILE.size, TILE.radius);
  if (edge > 0) return null;
  const small = unit > 8;
  let c = gradientAt(SKY, along(x, y, [TILE.x, TILE.y], [TILE.x + TILE.size, TILE.y + TILE.size]))[0];
  if (!small && edge >= -2) c = over(c, gradientAt(RIM, (y - TILE.y) / 112));
  const [glow, glowOpacity] = gradientAt(GLOW.stops, Math.hypot(x - GLOW.x, y - GLOW.y) / GLOW.r);
  c = over(c, [glow, small ? glowOpacity / 2 : glowOpacity]);
  if (!small) for (const s of STARS) if (inCircle(x, y, s.x, s.y, s.r)) c = s.color;
  if (inCircle(x, y, MOON.x, MOON.y, MOON.r) && !inCircle(x, y, SHADE.x, SHADE.y, SHADE.r)) {
    c = gradientAt(MOONLIGHT.stops, along(x, y, MOONLIGHT.from, MOONLIGHT.to))[0];
  } else {
    const halo = HALO.opacity * blurred(crescentDistance(x, y), HALO.sigma);
    c = over(c, [HALO.color, small ? halo / 2 : halo]);
  }
  c = over(c, gradientAt(SPARKLE.glow, Math.hypot(x - SPARKLE.x, y - SPARKLE.y) / SPARKLE.glowR));
  if (inSparkle(x, y)) c = gradientAt(SPARKLE.stops, Math.hypot(x - SPARKLE.x, y - SPARKLE.y) / SPARKLE.r)[0];
  const stroke = Math.max(PROMPT_STROKE, 1.5 * unit);
  const bar = Math.max(CURSOR.h, 1.5 * unit);
  const [a, b, d] = CHEVRON;
  const toPrompt = Math.min(
    Math.min(segmentDistance(x, y, ...a, ...b), segmentDistance(x, y, ...b, ...d)) - stroke / 2,
    roundedRectDistance(x, y, CURSOR.x, CURSOR.y + CURSOR.h - bar, CURSOR.w, bar, bar / 2),
  );
  if (toPrompt <= 0) c = MINT_400;
  else if (!small) c = over(c, [MINT_400, PROMPT_GLOW.opacity * blurred(toPrompt, PROMPT_GLOW.sigma)]);
  return c;
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
          const c = colorAt((px + (sx + 0.5) / samples) * unit, (py + (sy + 0.5) / samples) * unit, unit);
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
