import { describe, expect, it } from "vitest";
import { mergeByLine, splitWords, unionBox } from "../src/core/textLayer";
import { findInWords } from "../src/plugins/search";
import { planMigration } from "../src/plugins/migration";
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

// ---- migration -------------------------------------------------------------

const annot = (over: Partial<Annotation> = {}): Annotation => ({
  id: "an_1", kind: "cloud", sheetId: "A-201", page: 1,
  points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }],
  author: "A. Reviewer", createdAt: "2026-07-20T09:00:00.000Z", version: 1, status: "open",
  subject: "Verify header", ...over,
});

const result = (over: Partial<CompareResult> = {}): CompareResult => ({
  offset: { x: 0, y: 0 }, regions: [], changedFraction: 0, ...over,
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
});
