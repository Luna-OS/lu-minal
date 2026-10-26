// The Windows icon (installer, lu-minal.exe, shortcuts): drawn from linux/lu-minal.svg's shapes
// and gradients and packed as an .ico Windows reads (BMP entries, a PNG for 256 px).
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildIco, encodePng, ICON_SIZES, renderIcon } from "../../scripts/windows-icon.js";

/** The RGBA of one pixel, at SVG coordinates (256 units) in an icon of `size` pixels. */
function pixel(rgba: Uint8Array, size: number, x: number, y: number): number[] {
  const px = Math.floor((x / 256) * size);
  const py = Math.floor((y / 256) * size);
  const i = (py * size + px) * 4;
  return [...rgba.subarray(i, i + 4)];
}

const MINT = [0x7f, 0xe3, 0xc6, 255];

describe("the Windows icon", () => {
  it("draws the night-sky tile: transparent around it, violet at the top-left, night-950 at the bottom-right", () => {
    const icon = renderIcon(256);
    for (const [x, y] of [[2, 2], [12, 12], [250, 250], [252, 4]]) expect(pixel(icon, 256, x, y)[3], `${x},${y}`).toBe(0);
    const topLeft = pixel(icon, 256, 40, 40);
    const bottomRight = pixel(icon, 256, 230, 230);
    expect(topLeft[3]).toBe(255);
    expect(bottomRight[3]).toBe(255);
    // Violet: more blue than red, more red than green; much brighter than the far corner.
    expect(topLeft[2]).toBeGreaterThan(topLeft[0]);
    expect(topLeft[0]).toBeGreaterThan(topLeft[1]);
    for (let c = 0; c < 3; c++) expect(topLeft[c]).toBeGreaterThan(bottomRight[c] + 20);
    expect(bottomRight[2]).toBeLessThan(0x30);
    // The faint highlight along the top edge.
    expect(pixel(icon, 256, 128, 9)[0]).toBeGreaterThan(pixel(icon, 256, 128, 14)[0] + 20);
  });

  it("draws a bright crescent in a lavender halo", () => {
    const icon = renderIcon(256);
    // The lit part, near white; the shade's side stays sky.
    for (const c of pixel(icon, 256, 100, 120)) expect(c).toBeGreaterThanOrEqual(245);
    for (const c of pixel(icon, 256, 175, 80).slice(0, 3)) expect(c).toBeLessThan(100);
    // Just outside the crescent the halo lights the sky up.
    const halo = pixel(icon, 256, 74, 100);
    const sky = pixel(icon, 256, 30, 100);
    expect(halo[2]).toBeGreaterThan(sky[2] + 15);
    expect(halo[0]).toBeGreaterThan(sky[0] + 15);
  });

  it("draws the gold sparkle, the lavender stars and the glowing mint prompt", () => {
    const icon = renderIcon(256);
    // The sparkle: white-hot at the centre, gold along the arms.
    const centre = pixel(icon, 256, 196, 64);
    expect(centre[0]).toBeGreaterThanOrEqual(250);
    expect(centre[2]).toBeGreaterThanOrEqual(220);
    for (const [x, y] of [[196, 46], [214, 64]]) {
      const [r, g, b] = pixel(icon, 256, x, y);
      expect(r).toBeGreaterThan(220);
      expect(r - b).toBeGreaterThan(60);
      expect(g).toBeGreaterThan(b);
      expect(g).toBeLessThan(r);
    }
    // Between the arms it is sky again.
    expect(pixel(icon, 256, 212, 48)[0]).toBeLessThan(150);
    // A lavender-400 star.
    expect(pixel(icon, 256, 54, 62)).toEqual([0xb9, 0xae, 0xfb, 255]);
    // The prompt's chevron and cursor bar, and its faint mint glow (green over the violet sky).
    expect(pixel(icon, 256, 84, 188)).toEqual(MINT);
    expect(pixel(icon, 256, 124, 210)).toEqual(MINT);
    const glow = pixel(icon, 256, 130, 222);
    expect(glow[1]).toBeGreaterThan(glow[0]);
  });

  it("stays legible from 16 to 48 px", () => {
    for (const size of [16, 24, 32, 48]) {
      const icon = renderIcon(size);
      expect(pixel(icon, size, 0, 0)[3], `corner at ${size} px`).toBe(0);
      expect(pixel(icon, size, 128, 128)[3], `tile at ${size} px`).toBe(255);
      for (const c of pixel(icon, size, 100, 120)) expect(c, `moon at ${size} px`).toBeGreaterThanOrEqual(240);
      expect(pixel(icon, size, 84, 188), `prompt at ${size} px`).toEqual(MINT);
      const [r, , b] = pixel(icon, size, 196, 64);
      expect(r, `sparkle at ${size} px`).toBeGreaterThan(200);
      expect(r - b, `sparkle at ${size} px`).toBeGreaterThan(40);
    }
    // Below 32 px the little stars are left out: they would only be noise.
    expect(pixel(renderIcon(16), 16, 54, 62)[2]).toBeLessThan(0xb0);
  });

  it("packs every size as an .ico with BMP entries and a PNG for 256 px", () => {
    const ico = buildIco();
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(ICON_SIZES.length);
    ICON_SIZES.forEach((size, i) => {
      const e = 6 + i * 16;
      expect(ico[e] || 256, `width ${size}`).toBe(size);
      expect(ico[e + 1] || 256, `height ${size}`).toBe(size);
      expect(ico.readUInt16LE(e + 6)).toBe(32);
      const length = ico.readUInt32LE(e + 8);
      const offset = ico.readUInt32LE(e + 12);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      const data = ico.subarray(offset, offset + length);
      if (size === 256) {
        expect([...data.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      } else {
        // BITMAPINFOHEADER: 40 bytes, double height (image plus AND mask), 32 bits, then the pixels.
        expect(data.readUInt32LE(0)).toBe(40);
        expect(data.readInt32LE(8)).toBe(size * 2);
        expect(length).toBe(40 + size * size * 4 + Math.ceil(size / 32) * 4 * size);
      }
    });
  });

  it("writes a PNG that decodes back to the drawn pixels", () => {
    const size = 32;
    const rgba = renderIcon(size);
    const png = encodePng(rgba, size);
    // IHDR right after the signature: 32 x 32, 8-bit RGBA.
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect([png[24], png[25]]).toEqual([8, 6]);
    const idat = png.indexOf("IDAT");
    const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    for (let y = 0; y < size; y++) {
      expect(raw[y * (size * 4 + 1)]).toBe(0);
      expect(raw.subarray(y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1)).equals(Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)))).toBe(true);
    }
  });
});
