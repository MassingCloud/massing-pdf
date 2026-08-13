import { describe, expect, it } from "vitest";
import { extractRequirements, parseSpecLines, specsPlugin, type SpecLine } from "../src/plugins/specs";
import { EventBus } from "../src/core/events";
import type { PluginContext } from "../src/core/plugin";
import type { Viewer } from "../src/core/viewer";

/** Build spec lines with plausible geometry; only the text drives the parse. */
const lines = (...texts: (string | [string, number])[]): SpecLine[] =>
  texts.map((t, i) => {
    const [text, page] = Array.isArray(t) ? t : [t, 1];
    return { text, page, box: { x: 72, y: 100 + i * 14, w: 400, h: 11 } };
  });

const SAMPLE = lines(
  "SECTION 07 84 00 - FIRESTOPPING",
  "PART 1 - GENERAL",
  "1.1 SUMMARY",
  "A. Section includes penetration firestopping of fire-resistance-rated construction.",
  "1.2 SUBMITTALS",
  "A. Product Data: For each type of product.",
  "B. Shop Drawings: Submit for each firestop configuration.",
  "1. Include location and construction details.",
  "2. Include listing agency designations.",
  "1.3 QUALITY ASSURANCE",
  "A. Installer Qualifications: A firm that has been approved by FM Global.",
  "PART 2 - PRODUCTS",
  "2.1 MATERIALS",
  "A. Provide firestopping complying with UL 1479.",
  "PART 3 - EXECUTION",
  "3.1 INSTALLATION",
  "A. Install per manufacturer written instructions.",
);

describe("section headings", () => {
  it("finds a CSI section and normalises its number", () => {
    const [section] = parseSpecLines(SAMPLE);
    expect(section!.number).toBe("07 84 00");
    expect(section!.title).toBe("FIRESTOPPING");
    expect(section!.division).toBe("07");
  });

  it("accepts an unspaced section number", () => {
    const [section] = parseSpecLines(lines("078400 FIRESTOPPING"));
    expect(section!.number).toBe("07 84 00");
  });

  it("accepts an en dash separator", () => {
    const [section] = parseSpecLines(lines("SECTION 09 91 23 – INTERIOR PAINTING"));
    expect(section!.number).toBe("09 91 23");
    expect(section!.title).toBe("INTERIOR PAINTING");
  });

  it("ignores a numeric run with no title — a dimension string is not a section", () => {
    expect(parseSpecLines(lines("12 34 56"))).toHaveLength(0);
    expect(parseSpecLines(lines("07 84 00"))).toHaveLength(0);
  });

  it("starts a new section when the next heading appears", () => {
    const sections = parseSpecLines(lines(
      "SECTION 07 84 00 - FIRESTOPPING",
      "1.1 SUMMARY",
      "SECTION 09 91 23 - INTERIOR PAINTING",
      "1.1 SUMMARY",
    ));
    expect(sections.map((s) => s.number)).toEqual(["07 84 00", "09 91 23"]);
    expect(sections[1]!.clauses).toHaveLength(1);
  });

  it("drops content appearing before any section heading", () => {
    expect(parseSpecLines(lines("1.1 SUMMARY", "A. Orphaned clause."))).toHaveLength(0);
  });
});

describe("clause structure", () => {
  const [section] = parseSpecLines(SAMPLE);
  const refs = section!.clauses.map((c) => c.ref);

  it("records parts, articles, paragraphs and subparagraphs", () => {
    expect(refs).toContain("PART 1");
    expect(refs).toContain("1.2");
    expect(refs).toContain("1.2.A");
    expect(refs).toContain("1.2.B");
  });

  it("nests a subparagraph under the paragraph above it", () => {
    expect(refs).toContain("1.2.B.1");
    expect(refs).toContain("1.2.B.2");
  });

  it("assigns depths that reflect the hierarchy", () => {
    const byRef = new Map(section!.clauses.map((c) => [c.ref, c]));
    expect(byRef.get("PART 1")!.depth).toBe(0);
    expect(byRef.get("1.2")!.depth).toBe(1);
    expect(byRef.get("1.2.A")!.depth).toBe(2);
    expect(byRef.get("1.2.B.1")!.depth).toBe(3);
  });

  it("keeps the clause text", () => {
    const clause = section!.clauses.find((c) => c.ref === "1.2.A")!;
    expect(clause.text).toBe("Product Data: For each type of product.");
  });

  it("resets article numbering across parts", () => {
    // 3.1 belongs to PART 3, and must not be confused with 1.1 in PART 1.
    expect(refs).toContain("3.1");
    expect(refs).toContain("3.1.A");
  });

  it("carries the page each clause was found on", () => {
    const spread = parseSpecLines(lines(
      ["SECTION 07 84 00 - FIRESTOPPING", 12],
      ["1.1 SUMMARY", 12],
      ["A. Later paragraph.", 13],
    ));
    expect(spread[0]!.page).toBe(12);
    expect(spread[0]!.clauses.find((c) => c.ref === "1.1.A")!.page).toBe(13);
  });

  it("ignores a paragraph marker with no article to attach to", () => {
    const sections = parseSpecLines(lines("SECTION 07 84 00 - FIRESTOPPING", "A. Stray paragraph."));
    expect(sections[0]!.clauses).toHaveLength(0);
  });

  it("skips absurdly long lines rather than treating body text as a heading", () => {
    const long = "A. " + "x".repeat(400);
    const sections = parseSpecLines(lines("SECTION 07 84 00 - FIRESTOPPING", "1.1 SUMMARY", long));
    expect(sections[0]!.clauses.map((c) => c.ref)).toEqual(["1.1"]);
  });
});

describe("requirement extraction", () => {
  const reqs = extractRequirements(parseSpecLines(SAMPLE));

  it("pulls out submittal requirements", () => {
    const submittals = reqs.filter((r) => r.kind === "submittal");
    expect(submittals.length).toBeGreaterThanOrEqual(2);
    expect(submittals.some((r) => /Product Data/i.test(r.text))).toBe(true);
    expect(submittals.some((r) => /Shop Drawings/i.test(r.text))).toBe(true);
  });

  it("classifies quality-assurance requirements", () => {
    expect(reqs.some((r) => r.kind === "quality" && /Installer Qualifications/i.test(r.text))).toBe(true);
  });

  it("cites the section and clause each requirement came from", () => {
    const r = reqs.find((x) => /Product Data/i.test(x.text))!;
    expect(r.section).toBe("07 84 00");
    expect(r.clause).toBe("1.2.A");
  });

  it("does not treat headings as requirements", () => {
    // "1.2 SUBMITTALS" is an article heading, not something anyone has to do.
    expect(reqs.some((r) => r.clause === "1.2")).toBe(false);
  });

  it("returns nothing for a section with no actionable language", () => {
    const plain = parseSpecLines(lines(
      "SECTION 00 00 00 - NOTHING",
      "1.1 SUMMARY",
      "A. This paragraph asks for nothing at all whatsoever.",
    ));
    expect(extractRequirements(plain)).toHaveLength(0);
  });
});

/**
 * Corrections — overriding the parser on one line.
 *
 * The heuristics are forgiving, and forgiving is wrong sometimes. What makes a wrong parse a *dead
 * end* rather than a nuisance is a missed section heading: you cannot navigate to a section that
 * was never found, and no amount of clause-level accuracy makes up for it. These probe that path
 * first, then the reverse (a false positive) and the clause cases.
 */
describe("spec corrections", () => {
  it("rescues a section heading the heuristics cannot read", () => {
    // `SECTION_HEADING` caps the title at 80 characters, so a long one takes the whole heading down
    // with it. Real: descriptive titles run long, and the section is then unreachable.
    const heading = "SECTION 07 84 00 - FIRESTOPPING SYSTEMS FOR PENETRATIONS THROUGH "
      + "FIRE-RATED CONSTRUCTION ASSEMBLIES AND JOINTS";
    const src = lines(heading, "PART 1 - GENERAL", "1.1 SUMMARY");
    expect(parseSpecLines(src)).toHaveLength(0);

    const fixed = parseSpecLines(src, [{ page: 1, text: heading, as: "section" }]);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]!.number).toBe("07 84 00");
    expect(fixed[0]!.division).toBe("07");
    expect(fixed[0]!.title).toBe("FIRESTOPPING SYSTEMS FOR PENETRATIONS THROUGH "
      + "FIRE-RATED CONSTRUCTION ASSEMBLIES AND JOINTS");
    // And the clauses below it attach, which is the whole point of rescuing the heading.
    expect(fixed[0]!.clauses.map((c) => c.ref)).toEqual(["PART 1", "1.1"]);
  });

  it("takes an explicit number and title when the line yields neither", () => {
    const fixed = parseSpecLines(lines("FIRESTOPPING OF RATED ASSEMBLIES"), [
      { page: 1, text: "FIRESTOPPING OF RATED ASSEMBLIES", as: "section", number: "07 84 00", title: "Firestopping" },
    ]);
    expect(fixed[0]).toMatchObject({ number: "07 84 00", title: "Firestopping" });
  });

  it("falls back to the heuristics when a section correction carries no usable number", () => {
    // Inventing a number would put an entry in the register that no drawing can ever cite.
    const src = lines("SECTION 07 84 00 - FIRESTOPPING");
    const fixed = parseSpecLines(src, [
      { page: 1, text: "SECTION 07 84 00 - FIRESTOPPING", as: "section", number: undefined },
    ]);
    expect(fixed[0]!.number).toBe("07 84 00");
  });

  it("drops a false positive", () => {
    const src = lines("SECTION 07 84 00 - FIRESTOPPING", "SECTION 12 34 56 - SEE DRAWING", "1.1 SUMMARY");
    expect(parseSpecLines(src)).toHaveLength(2);

    const fixed = parseSpecLines(src, [{ page: 1, text: "SECTION 12 34 56 - SEE DRAWING", as: "none" }]);
    expect(fixed).toHaveLength(1);
    // The clause below it now belongs to the section that survived, not to the one that was dropped.
    expect(fixed[0]!.clauses.map((c) => c.ref)).toEqual(["1.1"]);
  });

  it("promotes a line the parser read as prose into a clause", () => {
    const src = lines("SECTION 07 84 00 - FIRESTOPPING", "SUMMARY OF WORK", "A. Something.");
    expect(parseSpecLines(src)[0]!.clauses).toHaveLength(0);

    const fixed = parseSpecLines(src, [
      { page: 1, text: "SUMMARY OF WORK", as: "clause", depth: 1, ref: "1.1" },
    ]);
    // Forcing the article also re-parents the paragraph under it — paragraphs need an article, so
    // before the correction "A. Something." had nowhere to go.
    expect(fixed[0]!.clauses.map((c) => `${c.ref}@${c.depth}`)).toEqual(["1.1@1", "1.1.A@2"]);
  });

  it("derives a ref from the line when the correction does not give one", () => {
    const fixed = parseSpecLines(
      lines("SECTION 07 84 00 - FIRESTOPPING", "2.03  MATERIALS"),
      [{ page: 1, text: "2.03  MATERIALS", as: "clause", depth: 1 }],
    );
    // A correction says "this is an article", not "this article is numbered differently than it
    // says" — so the line's own number wins over anything positional.
    expect(fixed[0]!.clauses[0]!.ref).toBe("2.03");
  });

  it("keeps a forced ref unique when the line carries no number at all", () => {
    const fixed = parseSpecLines(
      lines("SECTION 07 84 00 - FIRESTOPPING", "GENERAL NOTES", "SPECIAL CONDITIONS"),
      [
        { page: 1, text: "GENERAL NOTES", as: "clause", depth: 2 },
        { page: 1, text: "SPECIAL CONDITIONS", as: "clause", depth: 2 },
      ],
    );
    const refs = fixed[0]!.clauses.map((c) => c.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("matches a line regardless of case and inner spacing", () => {
    const fixed = parseSpecLines(lines("SECTION 07 84 00 - FIRESTOPPING", "1.1 SUMMARY"), [
      { page: 1, text: "  1.1   summary ", as: "none" },
    ]);
    expect(fixed[0]!.clauses).toHaveLength(0);
  });

  it("does not apply a correction to the same text on a different page", () => {
    const src = lines(["SECTION 07 84 00 - FIRESTOPPING", 1], ["1.1 SUMMARY", 1], ["1.1 SUMMARY", 2]);
    const fixed = parseSpecLines(src, [{ page: 2, text: "1.1 SUMMARY", as: "none" }]);
    expect(fixed[0]!.clauses.map((c) => c.page)).toEqual([1]);
  });

  it("ignores a clause correction with no section to attach to", () => {
    // Falls through to the heuristics rather than being dropped, so nothing is lost either way.
    expect(parseSpecLines(lines("1.1 SUMMARY"), [
      { page: 1, text: "1.1 SUMMARY", as: "clause", depth: 1 },
    ])).toHaveLength(0);
  });

  it("leaves the parse untouched when no corrections are given", () => {
    expect(parseSpecLines(SAMPLE, [])).toEqual(parseSpecLines(SAMPLE));
  });
});

/**
 * The correction path end to end: loading corrections, applying one, persisting the result.
 *
 * The pure-parser cases above cover what a correction *means*. These cover the plumbing that makes
 * it usable — that corrections survive a reload, that applying one does not re-read the book, and
 * that the host is handed something it can store in one write.
 */
describe("specs plugin corrections", () => {
  const PAGE_TEXT: Record<number, string[]> = {
    1: [
      "SECTION 07 84 00 - FIRESTOPPING SYSTEMS FOR PENETRATIONS THROUGH FIRE-RATED CONSTRUCTION ASSEMBLIES AND JOINTS",
      "PART 1 - GENERAL",
      "1.1 SUMMARY",
    ],
  };

  /** A viewer stub that serves canned page text and counts how often it is asked. */
  function harness(options: Parameters<typeof specsPlugin>[0] = {}) {
    const bus = new EventBus();
    let reads = 0;
    const viewer = {
      bus,
      numPages: 1,
      doc: { fingerprint: "fp" },
      page: 1,
      redraw() {},
      on: (name: string, fn: () => void) => bus.on(name as "doc:loaded", fn),
      async pageText(page: number) {
        reads++;
        return (PAGE_TEXT[page] ?? []).map((str, i) => ({
          str, x: 72, y: 100 + i * 14, w: str.length * 5, h: 11,
        }));
      },
    } as unknown as Viewer;

    const ctx = {
      viewer, bus,
      store: { get: () => undefined, update: () => undefined, selectedIds: () => [] },
      registerTool() {}, registerAction() {}, registerPanel() {}, registerRenderer() {},
      onCleanup() {},
    } as unknown as PluginContext;

    specsPlugin({ scanReferences: false, ...options }).setup(ctx);
    return { viewer, bus, reads: () => reads };
  }

  it("applies corrections supplied by the host on load", async () => {
    const heading = PAGE_TEXT[1]![0]!;
    const plain = harness();
    expect(await plain.viewer.specs!.load()).toHaveLength(0);

    const h = harness({ corrections: () => [{ page: 1, text: heading, as: "section" }] });
    const sections = await h.viewer.specs!.load();
    expect(sections).toHaveLength(1);
    expect(sections[0]!.number).toBe("07 84 00");
  });

  it("re-parses from cached lines instead of re-reading the book", async () => {
    const h = harness();
    await h.viewer.specs!.load();
    const afterLoad = h.reads();
    expect(afterLoad).toBeGreaterThan(0);

    await h.viewer.specs!.correct({ page: 1, text: PAGE_TEXT[1]![0]!, as: "section" });

    // Reading is the expensive half — a 900-page book on every keystroke of a correction session
    // would make the panel unusable. Parsing is pure and instant.
    expect(h.reads()).toBe(afterLoad);
    expect(h.viewer.specs!.sections()).toHaveLength(1);
  });

  it("hands the host the whole set to store, not a diff", async () => {
    const written: unknown[][] = [];
    const h = harness({ onCorrect: (all) => { written.push([...all]); } });
    await h.viewer.specs!.load();

    await h.viewer.specs!.correct({ page: 1, text: "PART 1 - GENERAL", as: "none" });
    await h.viewer.specs!.correct({ page: 1, text: "1.1 SUMMARY", as: "none" });

    expect(written).toHaveLength(2);
    expect(written[1]).toHaveLength(2);
  });

  it("replaces the correction on a line rather than stacking them", async () => {
    const h = harness();
    await h.viewer.specs!.load();
    const at = { page: 1, text: PAGE_TEXT[1]![0]! };

    await h.viewer.specs!.correct({ ...at, as: "section" });
    await h.viewer.specs!.correct({ ...at, as: "none" });

    // A growing pile of superseded entries is a persistence bug waiting to happen on the host side.
    expect(h.viewer.specs!.corrections()).toHaveLength(1);
    expect(h.viewer.specs!.corrections()[0]!.as).toBe("none");
  });

  it("reports whether uncorrecting did anything", async () => {
    const h = harness();
    await h.viewer.specs!.load();
    expect(await h.viewer.specs!.uncorrect(1, "nothing here")).toBe(false);

    await h.viewer.specs!.correct({ page: 1, text: "1.1 SUMMARY", as: "none" });
    expect(await h.viewer.specs!.uncorrect(1, "1.1 SUMMARY")).toBe(true);
    expect(h.viewer.specs!.corrections()).toHaveLength(0);
  });

  it("exposes the lines a correction points at, per page", async () => {
    const h = harness();
    await h.viewer.specs!.load();
    expect(h.viewer.specs!.lines(1).map((l) => l.text)).toEqual(PAGE_TEXT[1]);
    expect(h.viewer.specs!.lines(2)).toEqual([]);
    expect(h.viewer.specs!.lines()).toHaveLength(3);
  });

  it("drops corrections when a different document opens", async () => {
    const h = harness();
    await h.viewer.specs!.load();
    await h.viewer.specs!.correct({ page: 1, text: "1.1 SUMMARY", as: "none" });
    expect(h.viewer.specs!.corrections()).toHaveLength(1);

    // They are addressed by page and text, which mean nothing in another document.
    h.bus.emit("doc:loaded", { name: "other", pages: 1, fingerprint: "fp2" });
    expect(h.viewer.specs!.corrections()).toHaveLength(0);
    expect(h.viewer.specs!.lines()).toHaveLength(0);
  });
});
