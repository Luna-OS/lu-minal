import { describe, expect, it } from "vitest";
import { contrast, hexToRgb, isDark, isHex, luminance, mixHex, normalizeHex, readableOn, rgbToHex } from "../../src/themes/color.js";

describe("hex parsing", () => {
  it("accepts only #rrggbb in isHex", () => {
    expect(isHex("#0b0920")).toBe(true);
    expect(isHex("#B9AEFB")).toBe(true);
    expect(isHex("#abc")).toBe(false);
    expect(isHex("0b0920")).toBe(false);
    expect(isHex("#0b092")).toBe(false);
    expect(isHex("#0b0920ff")).toBe(false);
    expect(isHex(null)).toBe(false);
    expect(isHex(0x0b0920)).toBe(false);
  });

  it("normalizes short and upper-case forms", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("  #B9AEFB ")).toBe("#b9aefb");
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });

  it("round-trips rgb", () => {
    expect(hexToRgb("#7fe3c6")).toEqual({ r: 0x7f, g: 0xe3, b: 0xc6 });
    expect(rgbToHex({ r: 0x7f, g: 0xe3, b: 0xc6 })).toBe("#7fe3c6");
    expect(rgbToHex(0, 0, 0)).toBe("#000000");
    // Rounds and clamps.
    expect(rgbToHex(300, -4, 127.6)).toBe("#ff0080");
    expect(() => hexToRgb("nope")).toThrow(/rrggbb/);
  });
});

describe("mixHex", () => {
  it("returns a at t=0 and b at t=1", () => {
    expect(mixHex("#0b0920", "#fbf7f0", 0)).toBe("#0b0920");
    expect(mixHex("#0b0920", "#fbf7f0", 1)).toBe("#fbf7f0");
  });

  it("blends linearly per channel, like color-mix over an opaque background", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    // lavender-400 at 18 % over night-900.
    expect(mixHex("#141030", "#b9aefb", 0.18)).toBe("#322c55");
    expect(mixHex("#ff0000", "#0000ff", 0.25)).toBe("#bf0040");
  });

  it("clamps t and treats NaN as 0", () => {
    expect(mixHex("#102030", "#ffffff", -1)).toBe("#102030");
    expect(mixHex("#102030", "#ffffff", 7)).toBe("#ffffff");
    expect(mixHex("#102030", "#ffffff", Number.NaN)).toBe("#102030");
  });

  it("accepts short hex inputs", () => {
    expect(mixHex("#000", "#fff", 1)).toBe("#ffffff");
  });
});

describe("contrast", () => {
  it("matches the WCAG reference values", () => {
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
    expect(luminance("#000000")).toBe(0);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(contrast("#123456", "#123456")).toBe(1);
  });

  it("picks black or white text", () => {
    expect(readableOn("#0b0920")).toBe("#ffffff");
    expect(readableOn("#f5f2fb")).toBe("#000000");
    expect(readableOn("#7fe3c6")).toBe("#000000");
  });

  it("tells dark backgrounds from light ones", () => {
    expect(isDark("#0b0920")).toBe(true);
    expect(isDark("#282828")).toBe(true);
    expect(isDark("#f5f2fb")).toBe(false);
  });
});
