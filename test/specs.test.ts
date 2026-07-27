import { describe, expect, it } from "vitest";
import { extractRequirements, parseSpecLines, type SpecLine } from "../src/plugins/specs";

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
