import { describe, expect, it } from "vitest";
import { mergeByLine, splitWords, unionBox } from "../src/core/textLayer";
import { findInWords } from "../src/plugins/search";
import { dedupeWords, planTileGrid, toTextItems } from "../src/plugins/ocr";
import { migrate, planMigration } from "../src/plugins/migration";
import type { TextItem } from "../src/core/document";
import type { Annotation } from "../src/core/types";
import type { CompareResult } from "../src/plugins/compare";

const item = (str: string, x: number, y: number, w: number, h = 10): TextItem => ({ str, x, y, w, h });

describe("splitWords", () => {
  it("splits a text run into words with apportioned boxes", () => {
    // 12 characters across 120pt → 10pt per character.
    const words = splitWords([item("ABC DEF GHIJ", 0, 100, 120)]);
    expect(words.map((w) => w.str)).toEqual(["ABC", "DEF", "GHIJ"]);
    expect(words[0]!.x).toBeCloseTo(0, 6);
    expect(words[0]!.w).toBeCloseTo(30, 6);
    expect(words[1]!.x).toBeCloseTo(40, 6);
    expect(words[2]!.x).toBeCloseTo(80, 6);
    expect(words[2]!.w).toBeCloseTo(40, 6);
  });

  it("keeps the source item index so a caller can recover the run", () => {
    const words = splitWords([item("one two", 0, 0, 70), item("three", 0, 20, 50)]);
    expect(words.map((w) => w.item)).toEqual([0, 0, 1]);
  });

  it("ignores whitespace-only runs", () => {
    expect(splitWords([item("   ", 0, 0, 30)])).toHaveLength(0);
  });

  it("handles a run with no spaces", () => {
    const words = splitWords([item("FIRESTOPPING", 10, 50, 120)]);
    expect(words).toHaveLength(1);
    expect(words[0]!.str).toBe("FIRESTOPPING");
  });
});

describe("mergeByLine", () => {
  it("merges quads that share a line into one band", () => {
    const merged = mergeByLine([
      { page: 1, x: 0, y: 100, w: 30, h: 10 },
      { page: 1, x: 35, y: 101, w: 40, h: 10 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.x).toBe(0);
    expect(merged[0]!.w).toBe(75);
  });

  it("keeps quads on different lines separate", () => {
    const merged = mergeByLine([
      { page: 1, x: 0, y: 100, w: 30, h: 10 },
      { page: 1, x: 0, y: 130, w: 30, h: 10 },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("does not merge across pages", () => {
    const merged = mergeByLine([
      { page: 1, x: 0, y: 100, w: 30, h: 10 },
      { page: 2, x: 0, y: 100, w: 30, h: 10 },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("returns an empty list for no input", () => {
    expect(mergeByLine([])).toEqual([]);
  });
});

describe("unionBox", () => {
  it("spans every box given", () => {
    expect(unionBox([{ x: 10, y: 10, w: 10, h: 10 }, { x: 40, y: 5, w: 10, h: 30 }]))
      .toEqual({ x: 10, y: 5, w: 40, h: 30 });
  });

  it("is empty for no boxes", () => {
    expect(unionBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("findInWords", () => {
  const words = splitWords([
    item("PROVIDE FIRESTOPPING AT ALL", 0, 100, 270),
    item("RATED PENETRATIONS PER SPEC", 0, 120, 270),
  ]);

  it("finds a single word and boxes it", () => {
    const hits = findInWords(words, "FIRESTOPPING", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.page).toBe(1);
    expect(hits[0]!.box!.w).toBeGreaterThan(0);
  });

  it("is case-insensitive", () => {
    expect(findInWords(words, "firestopping", 1)).toHaveLength(1);
  });

  it("matches a phrase spanning two separate text runs", () => {
    // "ALL RATED" crosses the item boundary — the case a word-by-word matcher misses.
    const hits = findInWords(words, "ALL RATED", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.box!.w).toBeGreaterThan(0);
  });

  it("returns every occurrence, up to the limit", () => {
    const repeated = splitWords([item("AA BB AA BB AA", 0, 0, 140)]);
    expect(findInWords(repeated, "AA", 1)).toHaveLength(3);
    expect(findInWords(repeated, "AA", 1, 2)).toHaveLength(2);
  });

  it("gives a snippet with surrounding context", () => {
    const hits = findInWords(words, "PENETRATIONS", 1);
    expect(hits[0]!.snippet).toContain("PENETRATIONS");
    expect(hits[0]!.snippet.length).toBeGreaterThan("PENETRATIONS".length);
  });

  it("returns nothing for a miss or an empty query", () => {
    expect(findInWords(words, "CONCRETE", 1)).toHaveLength(0);
    expect(findInWords(words, "", 1)).toHaveLength(0);
    expect(findInWords([], "anything", 1)).toHaveLength(0);
  });
});

// ---- OCR mapping -----------------------------------------------------------

describe("toTextItems", () => {
  const words = [
    { text: "DEMOLITION", x: 400, y: 200, w: 300, h: 40, confidence: 0.92 },
    { text: "PLAN", x: 720, y: 200, w: 120, h: 40, confidence: 0.88 },
  ];

  it("converts raster pixels to page points", () => {
    // 4 px per point: a word 400px from the left starts at 100pt.
    const items = toTextItems(words, 4);
    expect(items[0]).toEqual({ str: "DEMOLITION", x: 100, y: 50, w: 75, h: 10 });
    expect(items[1]).toEqual({ str: "PLAN", x: 180, y: 50, w: 30, h: 10 });
  });

  it("emits the same shape pdf.js does, so every text consumer works unchanged", () => {
    const [item] = toTextItems(words, 1);
    expect(Object.keys(item!).sort()).toEqual(["h", "str", "w", "x", "y"]);
  });

  it("drops words below the confidence floor", () => {
    const noisy = [...words, { text: "rn1st4ke", x: 0, y: 0, w: 50, h: 20, confidence: 0.1 }];
    expect(toTextItems(noisy, 1, 0.4).map((i) => i.str)).toEqual(["DEMOLITION", "PLAN"]);
    // A lower floor keeps it — the threshold is the caller's judgement, not a hard rule.
    expect(toTextItems(noisy, 1, 0.05)).toHaveLength(3);
  });

  it("keeps words with no confidence reported", () => {
    expect(toTextItems([{ text: "SURE", x: 0, y: 0, w: 40, h: 10 }], 1)).toHaveLength(1);
  });

  it("drops blank recognitions", () => {
    expect(toTextItems([{ text: "   ", x: 0, y: 0, w: 40, h: 10, confidence: 1 }], 1)).toHaveLength(0);
  });

  it("feeds the same search path as native text", () => {
    const items = toTextItems(words, 4);
    expect(findInWords(splitWords(items), "DEMOLITION PLAN", 7)).toHaveLength(1);
  });
});

// ---- OCR tiling ------------------------------------------------------------

describe("planTileGrid", () => {
  // ARCH D and US Letter, in PDF points.
  const ARCH_D = { w: 36 * 72, h: 24 * 72 };
  const LETTER = { w: 8.5 * 72, h: 11 * 72 };
  const opts = { dpi: 300, maxTilePixels: 12e6, overlap: 72 };

  it("leaves a page that already fits as a single tile", () => {
    // Letter at 300 DPI is 8.4 MP — under the budget, so cutting it would only add seams.
    const tiles = planTileGrid(LETTER.w, LETTER.h, opts);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ x: 0, y: 0, w: LETTER.w, h: LETTER.h });
  });

  it("splits a large sheet so no tile exceeds the budget", () => {
    const tiles = planTileGrid(ARCH_D.w, ARCH_D.h, opts);
    expect(tiles.length).toBeGreaterThan(1);
    for (const t of tiles) {
      expect(t.w * t.scale * t.h * t.scale).toBeLessThanOrEqual(opts.maxTilePixels * 1.35);
    }
  });

  it("reaches the requested DPI — the whole point of tiling", () => {
    const [tile] = planTileGrid(ARCH_D.w, ARCH_D.h, opts);
    // A PDF point is 1/72", so scale is DPI/72. At 300 DPI, 1/8" lettering is ~37px tall; the
    // ~9px it gets from fitting a whole D sheet in one raster is unreadable to any engine.
    expect(tile!.scale).toBeCloseTo(300 / 72, 6);
    expect(0.125 * 72 * tile!.scale).toBeGreaterThan(20);
  });

  it("covers the whole page", () => {
    const tiles = planTileGrid(ARCH_D.w, ARCH_D.h, opts);
    expect(Math.min(...tiles.map((t) => t.x))).toBe(0);
    expect(Math.min(...tiles.map((t) => t.y))).toBe(0);
    expect(Math.max(...tiles.map((t) => t.x + t.w))).toBeCloseTo(ARCH_D.w, 6);
    expect(Math.max(...tiles.map((t) => t.y + t.h))).toBeCloseTo(ARCH_D.h, 6);
  });

  it("overlaps neighbours so a word on a seam is whole somewhere", () => {
    const tiles = planTileGrid(ARCH_D.w, ARCH_D.h, opts);
    const first = tiles[0]!;
    const rightNeighbour = tiles.find((t) => t.y === first.y && t.x > first.x);
    expect(rightNeighbour).toBeDefined();
    // The neighbour starts before the first tile ends.
    expect(rightNeighbour!.x).toBeLessThan(first.x + first.w);
    expect(first.x + first.w - rightNeighbour!.x).toBeGreaterThanOrEqual(opts.overlap);
  });

  it("never lets a tile spill off the page", () => {
    for (const t of planTileGrid(ARCH_D.w, ARCH_D.h, opts)) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(ARCH_D.w + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(ARCH_D.h + 1e-6);
    }
  });

  it("numbers tiles for progress reporting", () => {
    const tiles = planTileGrid(ARCH_D.w, ARCH_D.h, opts);
    expect(tiles.map((t) => t.index)).toEqual(tiles.map((_, i) => i));
    expect(new Set(tiles.map((t) => t.count))).toEqual(new Set([tiles.length]));
  });

  it("needs more tiles at a higher DPI", () => {
    const at300 = planTileGrid(ARCH_D.w, ARCH_D.h, opts).length;
    const at600 = planTileGrid(ARCH_D.w, ARCH_D.h, { ...opts, dpi: 600 }).length;
    expect(at600).toBeGreaterThan(at300);
  });
});

describe("dedupeWords", () => {
  const w = (str: string, x: number, y: number, width = 40, h = 10) => ({ str, x, y, w: width, h });

  it("keeps distinct words", () => {
    expect(dedupeWords([w("PLAN", 0, 0), w("SECTION", 200, 0)])).toHaveLength(2);
  });

  it("merges the same word recognised twice in a tile overlap", () => {
    expect(dedupeWords([w("FIRESTOP", 100, 100), w("FIRESTOP", 100.4, 100.3)])).toHaveLength(1);
  });

  it("prefers the copy that was less clipped by the seam", () => {
    // The tile where the word sat further from an edge captured more of it.
    const merged = dedupeWords([w("FIRESTOPPING", 100, 100, 30), w("FIRESTOPPING", 100.2, 100, 90)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.w).toBe(90);
  });

  it("keeps the same word appearing in genuinely different places", () => {
    // A drawing repeats labels; only near-identical positions are duplicates.
    expect(dedupeWords([w("TYP", 100, 100), w("TYP", 800, 400)])).toHaveLength(2);
  });

  it("handles an empty list", () => {
    expect(dedupeWords([])).toEqual([]);
  });
});

// ---- migration -------------------------------------------------------------

const annot = (over: Partial<Annotation> = {}): Annotation => ({
  id: "an_1", kind: "cloud", sheetId: "A-201", page: 1,
  points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }],
  author: "A. Reviewer", createdAt: "2026-07-20T09:00:00.000Z", version: 1, status: "open",
  subject: "Verify header", ...over,
});

const result = (over: Partial<CompareResult> = {}): CompareResult => ({
  offset: { x: 0, y: 0 }, scale: 1, regions: [], changedFraction: 0, ...over,
});

describe("planMigration", () => {
  it("marks a markup over unchanged drawing as ok", () => {
    const [p] = planMigration([annot()], result(), 1);
    expect(p!.verdict).toBe("ok");
    expect(p!.offset).toEqual({ x: 0, y: 0 });
  });

  it("relocates markups when the sheet origin moved", () => {
    // The compare aligns the *previous* sheet onto the current one, so markups move the other way.
    const [p] = planMigration([annot()], result({ offset: { x: 5, y: -3 } }), 1);
    expect(p!.verdict).toBe("shifted");
    expect(p!.offset).toEqual({ x: -5, y: 3 });
  });

  it("flags a markup sitting over changed drawing as an orphan", () => {
    const [p] = planMigration(
      [annot()],
      result({ regions: [{ x: 90, y: 90, w: 120, h: 120, weight: 500 }] }),
      1,
    );
    expect(p!.verdict).toBe("orphan");
    expect(p!.changeOverlap).toBeGreaterThan(0.9);
    expect(p!.reason).toMatch(/changed/i);
  });

  it("does not flag a change that barely clips the markup", () => {
    // A 10×10 corner nick of a 100×100 markup is 1% — well under the threshold.
    const [p] = planMigration(
      [annot()],
      result({ regions: [{ x: 195, y: 195, w: 10, h: 10, weight: 20 }] }),
      1,
    );
    expect(p!.verdict).toBe("ok");
    expect(p!.changeOverlap).toBeCloseTo(0.0025, 4);
  });

  it("honours a custom orphan threshold", () => {
    const regions = [{ x: 100, y: 100, w: 50, h: 50, weight: 100 }];   // 25% of the markup
    expect(planMigration([annot()], result({ regions }), 1, 0.5)[0]!.verdict).toBe("ok");
    expect(planMigration([annot()], result({ regions }), 1, 0.2)[0]!.verdict).toBe("orphan");
  });

  it("treats any intersection as total for a point markup", () => {
    // A pin has no area to divide by; dividing would yield a meaningless ratio.
    const pin = annot({ kind: "pin", points: [{ x: 150, y: 150 }] });
    const [p] = planMigration([pin], result({ regions: [{ x: 140, y: 140, w: 30, h: 30, weight: 90 }] }), 1);
    expect(p!.changeOverlap).toBe(1);
    expect(p!.verdict).toBe("orphan");
  });

  it("prefers the orphan verdict over shifted when both apply", () => {
    // A markup that both moved and sits over a change still needs a human, not a quiet relocation.
    const [p] = planMigration(
      [annot()],
      result({ offset: { x: 8, y: 8 }, regions: [{ x: 80, y: 80, w: 140, h: 140, weight: 900 }] }),
      1,
    );
    expect(p!.verdict).toBe("orphan");
  });

  it("only plans for the requested page", () => {
    const plans = planMigration([annot({ id: "a", page: 1 }), annot({ id: "b", page: 2 })], result(), 1);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.annot.id).toBe("a");
  });

  it("gives every proposal a human-readable reason", () => {
    const plans = planMigration([annot()], result({ offset: { x: 4, y: 0 } }), 1);
    expect(plans[0]!.reason.length).toBeGreaterThan(10);
  });

  it("rescales markups for a sheet re-plotted at another size", () => {
    // ARCH C to ARCH D is roughly 1.29x. A translation-only migration would leave every markup
    // clustered near the origin.
    const [p] = planMigration([annot()], result({ scale: 1.294 }), 1);
    expect(p!.verdict).toBe("shifted");
    expect(p!.scale).toBeCloseTo(1.294, 6);
    const moved = migrate(p!.annot.points, p!.scale, p!.offset);
    expect(moved[0]).toEqual({ x: 129.4, y: 129.4 });
    expect(moved[2]).toEqual({ x: 258.8, y: 258.8 });
  });

  it("combines scale and offset in the right order", () => {
    // Compare aligns as scale-then-shift, so the markup must follow the same order.
    const [p] = planMigration([annot()], result({ scale: 2, offset: { x: 10, y: 0 } }), 1);
    const moved = migrate(p!.annot.points, p!.scale, p!.offset);
    expect(moved[0]).toEqual({ x: 100 * 2 - 10, y: 200 });
  });

  it("treats a scale of exactly 1 as unmoved", () => {
    const [p] = planMigration([annot()], result({ scale: 1 }), 1);
    expect(p!.verdict).toBe("ok");
  });

  it("defaults a missing scale to 1 rather than collapsing geometry to a point", () => {
    // A result from an older run, or a hand-built one, must not silently zero every markup.
    const legacy = { offset: { x: 0, y: 0 }, regions: [], changedFraction: 0 } as unknown as CompareResult;
    const [p] = planMigration([annot()], legacy, 1);
    expect(p!.scale).toBe(1);
    expect(migrate(p!.annot.points, p!.scale, p!.offset)[0]).toEqual({ x: 100, y: 100 });
  });
});
