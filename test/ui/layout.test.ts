import { describe, expect, it } from "vitest";
import { computeLayout, gridColumns, MIN_PANEL_HEIGHT, type Rect } from "../../src/ui/layout.js";

const agents = (n: number) => [
  { id: "lead", role: "lead" as const },
  ...Array.from({ length: n }, (_, i) => ({ id: `w${i}`, role: "worker" as const })),
];

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("computeLayout", () => {
  it("gives a lone lead the whole content area", () => {
    const l = computeLayout({ width: 120, height: 40, agents: agents(0), focusedId: "lead", zoomed: false, axo: true });
    expect(l.panels).toHaveLength(1);
    expect(l.panels[0].rect).toEqual(l.content);
    expect(l.axo).not.toBeNull();
  });

  it("lays six workers out in two columns under the lead without overlaps, inside the content", () => {
    const l = computeLayout({ width: 140, height: 50, agents: agents(6), focusedId: "lead", zoomed: false, axo: true });
    expect(l.panels).toHaveLength(7);
    expect(l.hiddenWorkers).toBe(0);
    const rects = l.panels.map((p) => p.rect);
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      expect(r.x).toBeGreaterThanOrEqual(l.content.x);
      expect(r.y).toBeGreaterThanOrEqual(l.content.y);
      expect(r.x + r.width).toBeLessThanOrEqual(l.content.x + l.content.width);
      expect(r.y + r.height).toBeLessThanOrEqual(l.content.y + l.content.height);
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(r, rects[j])).toBe(false);
    }
    const workers = rects.slice(1);
    expect(new Set(workers.map((r) => r.x)).size).toBe(2);
    for (const w of workers) expect(w.height).toBeGreaterThanOrEqual(MIN_PANEL_HEIGHT);
    expect(l.connectors).toHaveLength(1);
  });

  it("pages workers that don't fit and shows the focused one's page", () => {
    const l = computeLayout({ width: 100, height: 30, agents: agents(9), focusedId: "w8", zoomed: false, axo: false });
    expect(l.pages).toBeGreaterThan(1);
    expect(l.panels.some((p) => p.agentId === "w8")).toBe(true);
    expect(l.hiddenWorkers).toBeGreaterThan(0);
    expect(l.panels.length - 1 + l.hiddenWorkers).toBe(9);
  });

  it("zooms the focused agent to the whole content area", () => {
    const l = computeLayout({ width: 100, height: 30, agents: agents(3), focusedId: "w1", zoomed: true, axo: true });
    expect(l.panels).toEqual([{ agentId: "w1", rect: l.content }]);
  });

  it("hides Axo when the lead panel is too small", () => {
    const l = computeLayout({ width: 80, height: 30, agents: agents(2), focusedId: "lead", zoomed: false, axo: true });
    expect(l.axo).toBeNull();
  });

  it("grows the lead's panel for a question card, down to one row of workers", () => {
    const base = { width: 120, height: 36, agents: agents(2), focusedId: "lead", zoomed: false, axo: false };
    const plain = computeLayout(base).panels[0].rect;
    expect(plain.height).toBe(12);
    // 20 inner rows wanted: 22 with the frame, and the workers keep their row.
    const asking = computeLayout({ ...base, leadRows: 20 });
    expect(asking.panels[0].rect.height).toBe(22);
    expect(asking.hiddenWorkers).toBe(0);
    for (const w of asking.panels.slice(1)) expect(w.rect.height).toBeGreaterThanOrEqual(MIN_PANEL_HEIGHT);
    // More than fits: as much as leaves one row of workers.
    const huge = computeLayout({ ...base, leadRows: 200 });
    expect(huge.panels[0].rect.height).toBe(huge.content.height - MIN_PANEL_HEIGHT - 1);
    expect(huge.panels.slice(1).every((w) => w.rect.height >= MIN_PANEL_HEIGHT)).toBe(true);
    // A short card doesn't shrink it, and a lone lead has the whole area anyway.
    expect(computeLayout({ ...base, leadRows: 3 }).panels[0].rect).toEqual(plain);
    const alone = computeLayout({ ...base, agents: agents(0), leadRows: 200 });
    expect(alone.panels[0].rect).toEqual(alone.content);
  });

  it("uses one to three columns by width", () => {
    expect(gridColumns(80, 6)).toBe(1);
    expect(gridColumns(120, 6)).toBe(2);
    expect(gridColumns(200, 6)).toBe(3);
    expect(gridColumns(200, 2)).toBe(2);
  });
});
