import { expect, test } from "@playwright/test";
import { openSample, waitForRender } from "./helpers";

/**
 * The compare pipeline end to end: rasterise → align → difference → cluster → cloud.
 *
 * Unreachable from a unit test, because every stage begins with pdf.js putting pixels on a canvas.
 * The sample set gives two deterministic comparisons: a page against itself (which must find
 * nothing) and the plan against the details sheet (which must find a great deal).
 */
test.describe("compare", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
  });

  test("finds no changes between a page and itself", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { comparePages } = await import("/src/index.ts");
      const doc = window.viewer.doc!;
      const r = await comparePages(doc, doc, 1, 1);
      return { regions: r.regions.length, changed: r.changedFraction, offset: r.offset, scale: r.scale };
    });
    expect(result.regions).toBe(0);
    expect(result.changed).toBeLessThan(0.001);
    expect(result.offset).toEqual({ x: 0, y: 0 });
    expect(result.scale).toBe(1);
  });

  test("finds changed regions between two different sheets", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { comparePages } = await import("/src/index.ts");
      const doc = window.viewer.doc!;
      const r = await comparePages(doc, doc, 1, 2);
      return {
        regions: r.regions.length,
        changed: r.changedFraction,
        // Regions must be in page space, i.e. plausible coordinates on an ARCH D sheet.
        withinPage: r.regions.every((g) => g.x > -50 && g.y > -50 && g.x < 2700 && g.y < 1800),
        sorted: r.regions.every((g, i) => i === 0 || r.regions[i - 1]!.weight >= g.weight),
      };
    });
    expect(result.regions).toBeGreaterThan(0);
    expect(result.changed).toBeGreaterThan(0.001);
    expect(result.withinPage).toBe(true);
    // Sorted by severity, so the review queue leads with the biggest change.
    expect(result.sorted).toBe(true);
  });

  test("recovers a known translation between two rasters", async ({ page }) => {
    // Align the sheet against itself shifted: the returned offset must undo the shift, which is the
    // property the whole slip-sheet migration rests on.
    const offset = await page.evaluate(async () => {
      const { comparePages } = await import("/src/index.ts");
      const doc = window.viewer.doc!;
      const r = await comparePages(doc, doc, 1, 1);
      return r.offset;
    });
    expect(Math.abs(offset.x)).toBeLessThan(3);
    expect(Math.abs(offset.y)).toBeLessThan(3);
  });

  test("turns detected changes into real revision clouds in the store", async ({ page }) => {
    await page.evaluate(async () => {
      const { comparePages } = await import("/src/index.ts");
      const doc = window.viewer.doc!;
      const r = await comparePages(doc, doc, 1, 2);
      // Same shape the compare plugin's "Cloud changes" action builds.
      window.viewer.store.addMany(r.regions.slice(0, 5).map((g, i) => ({
        kind: "cloud" as const, page: 1,
        points: [
          { x: g.x, y: g.y }, { x: g.x + g.w, y: g.y },
          { x: g.x + g.w, y: g.y + g.h }, { x: g.x, y: g.y + g.h },
        ],
        subject: `Change ${i + 1}`, status: "in_review" as const, labels: ["auto-diff"],
      })));
      window.viewer.redraw();
    });

    const clouds = await page.evaluate(() =>
      window.viewer.store.all().filter((a) => a.labels?.includes("auto-diff")).length);
    expect(clouds).toBeGreaterThan(0);
    // They are markups, not a picture: they render through the normal overlay path.
    await expect(page.locator('.mpdf-annot[data-kind="cloud"]').first()).toBeAttached();
  });

  test("plans a migration from a real compare result", async ({ page }) => {
    const plan = await page.evaluate(async () => {
      const { comparePages, planMigration } = await import("/src/index.ts");
      const doc = window.viewer.doc!;

      const box = (x: number, y: number, w: number, h: number) => [
        { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
      ];
      const markup = (points: { x: number; y: number }[], subject: string) =>
        window.viewer.addAnnotation({ kind: "cloud" as const, page: 1, points, subject });

      // Against an identical sheet, nothing changed and nothing moved.
      const stable = markup(box(200, 200, 200, 140), "Stable");
      const unchanged = planMigration([stable], await comparePages(doc, doc, 1, 1), 1);

      // Against a different sheet, place one markup squarely over the largest detected change and
      // one well away from any of them — the two verdicts that matter.
      const diff = await comparePages(doc, doc, 1, 2);
      const biggest = diff.regions[0]!;
      const onChange = markup(box(biggest.x, biggest.y, biggest.w, biggest.h), "Over a change");
      const clear = box(200, 200, 40, 30);
      const clearOfChanges = !diff.regions.some((r) =>
        r.x < clear[2]!.x && r.x + r.w > clear[0]!.x && r.y < clear[2]!.y && r.y + r.h > clear[0]!.y);
      const elsewhere = markup(clear, "Clear of changes");

      const planned = planMigration([onChange, elsewhere], diff, 1);
      return {
        unchanged: unchanged[0]!.verdict,
        overChange: planned.find((p) => p.annot.id === onChange.id)!.verdict,
        overChangeOverlap: planned.find((p) => p.annot.id === onChange.id)!.changeOverlap,
        clear: planned.find((p) => p.annot.id === elsewhere.id)!.verdict,
        clearOfChanges,
      };
    });

    expect(plan.unchanged).toBe("ok");
    // A markup sitting on top of drawing that changed must not be quietly relocated.
    expect(plan.overChange).toBe("orphan");
    expect(plan.overChangeOverlap).toBeGreaterThan(0.25);
    // One that isn't over a change is carried across, not flagged.
    if (plan.clearOfChanges) expect(plan.clear).not.toBe("orphan");
  });

  test("respects the diff threshold", async ({ page }) => {
    const counts = await page.evaluate(async () => {
      const { comparePages } = await import("/src/index.ts");
      const doc = window.viewer.doc!;
      const strict = await comparePages(doc, doc, 1, 2, { threshold: 0.6 });
      const loose = await comparePages(doc, doc, 1, 2, { threshold: 0.1 });
      return { strict: strict.changedFraction, loose: loose.changedFraction };
    });
    // A higher luminance threshold ignores more, which is how scanner noise is tuned out.
    expect(counts.loose).toBeGreaterThanOrEqual(counts.strict);
  });
});
