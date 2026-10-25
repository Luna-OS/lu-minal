// The Windows icon (installer, lu-minal.exe, shortcuts): drawn from linux/lu-minal.svg's shapes
// and packed as an .ico Windows reads (BMP entries, a PNG for 256 px).
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

describe("the Windows icon", () => {
  it("draws the night-sky tile with the moon, a star and the mint prompt", () => {
    const icon = renderIcon(256);
    // Outside the rounded tile: transparent.
    expect(pixel(icon, 256, 2, 2)[3]).toBe(0);
    expect(pixel(icon, 256, 12, 12)[3]).toBe(0);
    // The sky, dark violet and opaque, lighter at the top than at the bottom.
    const top = pixel(icon, 256, 128, 20);
    const bottom = pixel(icon, 256, 128, 236);
    expect(top[3]).toBe(255);
    expect(top[2]).toBeGreaterThan(bottom[2]);
    // The crescent's lit part, and its dark inside where the second circle cuts it.
    expect(pixel(icon, 256, 100, 120)).toEqual([0xf4, 0xf1, 0xff, 255]);
    expect(pixel(icon, 256, 175, 80).slice(0, 3)).not.toEqual([0xf4, 0xf1, 0xff]);
    // The gold star and the prompt's chevron and cursor bar.
    expect(pixel(icon, 256, 196, 150)).toEqual([0xe0, 0xc8, 0x80, 255]);
    expect(pixel(icon, 256, 84, 192)).toEqual([0x7f, 0xe3, 0xc6, 255]);
    expect(pixel(icon, 256, 124, 206)).toEqual([0x7f, 0xe3, 0xc6, 255]);
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
