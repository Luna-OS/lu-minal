// Small "#rrggbb" colour helpers: parsing, mixing (what CSS color-mix does over an opaque
// background) and WCAG contrast, so themes can derive their muted / border shades from the palette
// and tests can prove every theme is readable.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

/** True for "#rrggbb" (any case). Short "#rgb" forms are not accepted here; see `normalizeHex`. */
export function isHex(s: unknown): s is string {
  return typeof s === "string" && HEX6.test(s);
}

/** "#ABC" / "#AABBCC" / " #aabbcc " -> "#aabbcc"; anything else -> null. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (HEX3.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX6.test(v) ? v : null;
}

/** "#rrggbb" -> { r, g, b } (0..255). Throws on anything that is not a 6-digit hex colour. */
export function hexToRgb(hex: string): Rgb {
  const n = normalizeHex(hex);
  if (!n) throw new Error(`Not a "#rrggbb" colour: ${JSON.stringify(hex)}`);
  const v = parseInt(n.slice(1), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** { r, g, b } (rounded and clamped to 0..255) -> "#rrggbb". */
export function rgbToHex(rgb: Rgb): string;
export function rgbToHex(r: number, g: number, b: number): string;
export function rgbToHex(a: Rgb | number, g?: number, b?: number): string {
  const c = typeof a === "number" ? { r: a, g: g ?? 0, b: b ?? 0 } : a;
  const v = (clampByte(c.r) << 16) | (clampByte(c.g) << 8) | clampByte(c.b);
  return `#${v.toString(16).padStart(6, "0")}`;
}

/**
 * Linear blend of two colours: t = 0 gives `a`, t = 1 gives `b`. `mixHex(bg, fg, 0.18)` is the
 * opaque result of drawing `fg` at 18 % opacity over `bg` (CSS `color-mix(in srgb, fg 18%, bg)`).
 */
export function mixHex(a: string, b: string, t: number): string {
  const k = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.r + (y.r - x.r) * k, x.g + (y.g - x.g) * k, x.b + (y.b - x.b) * k);
}

/** WCAG relative luminance (0 black .. 1 white). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two colours (1 .. 21). 4.5 is readable body text, 3 large text / UI. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on `bg`. */
export function readableOn(bg: string): "#000000" | "#ffffff" {
  return contrast(bg, "#000000") >= contrast(bg, "#ffffff") ? "#000000" : "#ffffff";
}

/** True when the colour is dark enough to call a theme with it as background "dark". */
export function isDark(bg: string): boolean {
  return luminance(bg) < 0.18;
}
