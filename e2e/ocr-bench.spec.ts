import { expect, test } from "@playwright/test";
import { openSample } from "./helpers";

/**
 * PaddleOCR against Tesseract, on an actual drawing.
 *
 * Every published OCR benchmark is measured on document-shaped input — receipts, scanned pages,
 * OmniDocBench. A construction sheet is not that: sparse text on a mostly-white ARCH D canvas, small
 * lettering, glyphs sitting on top of linework, and labels at arbitrary angles. Those numbers do not
 * obviously transfer, so this measures the thing we actually care about.
 *
 * **Not part of the normal suite.** It downloads ~12 MB of ONNX weights on first run and takes
 * minutes. Run it deliberately:
 *
 * ```
 * npx playwright test --project=ocr-bench
 * ```
 *
 * The fixture is the demo's generated sample sheet, so the expected strings are known exactly
 * rather than eyeballed — the title block is drawn by `demo/sample.ts` and its contents are the
 * ground truth.
 */

/**
 * Text the sample sheet's title block is drawn with, at 6–22pt.
 *
 * Taken from `drawPlanSheet` in `demo/sample.ts`, which draws page 1 as `A-201 / SECOND FLOOR PLAN`.
 * The first version of this list guessed `A-101` and scored a correct engine at 87.5% — ground
 * truth has to come from the generator, not from memory.
 */
const EXPECTED = [
  "SCALE", "DATE", "DRAWING TITLE", "SHEET NUMBER", "REV",
  "2026-07-26", "A-201", "SECOND FLOOR PLAN",
];

/** The title-block cluster, in page space. The sheet is 2592 × 1728pt. */
const REGION = { x: 2340, y: 1590, w: 230, h: 120 };

/** 300 DPI is the floor for recognition: ~18–20px of character height. A PDF point is 1/72". */
const DPI = 300;

test.describe("OCR engines on a drawing", () => {
  test("PaddleOCR vs Tesseract on the title block", async ({ page }) => {
    test.setTimeout(600_000);

    // Warm Vite's dependency optimiser first. The first import of a bare specifier it has not seen
    // makes the dev server re-bundle and reload the page, which destroys the execution context in
    // the middle of whatever `page.evaluate` is running. Provoke that here, where it is harmless.
    await page.goto("/demo/index.html");
    await page
      .evaluate(() => import("/e2e/ocr-modules.ts").then(() => true))
      .catch(() => false);
    await page.waitForTimeout(2_000);

    await openSample(page);

    const report = await page.evaluate(async ({ region, dpi, expected }) => {
      const v = window.viewer;
      const scale = dpi / 72;

      // Rasterise the region, the same way the OCR plugin's tiler does.
      const width = Math.round(region.w * scale);
      const height = Math.round(region.h * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      const pg = await v.doc!.page(1);
      await pg.render({
        canvas,
        canvasContext: ctx,
        viewport: pg.getViewport({ scale }),
        transform: [1, 0, 0, 1, -region.x * scale, -region.y * scale],
      }).promise;

      const normalise = (s: string) => s.toUpperCase().replace(/[^A-Z0-9-]/g, "");
      const score = (words: { text: string }[]) => {
        const haystack = normalise(words.map((w) => w.text).join(" "));
        const found = expected.filter((e) => haystack.includes(normalise(e)));
        return { found, recall: found.length / expected.length };
      };

      // Served by the dev server, so Vite resolves the bare specifiers. Code in `page.evaluate`
      // does not go through the bundler and cannot resolve them itself.
      const engines = await import("/e2e/ocr-modules.ts");

      const out: Record<string, unknown> = { tile: { width, height } };

      const input = {
        page: 1, canvas, width, height, scale,
        offset: { x: region.x, y: region.y }, index: 0, count: 1,
      };

      /**
       * A second, *different* tile for the steady-state measurement.
       *
       * Two traps here, both of which produced a bogus 1 ms. Re-running the *same* image can hit
       * the wrapper's result cache; and a tile taken from the blank sheet above the title block has
       * nothing to detect, so it returns before doing any recognition work. This one is offset by a
       * few points — different bytes, same dense text — so the number reflects an actual pass.
       */
      const render = async (r: { x: number; y: number; w: number; h: number }) => {
        const c = document.createElement("canvas");
        c.width = Math.round(r.w * scale);
        c.height = Math.round(r.h * scale);
        const cx = c.getContext("2d", { alpha: false, willReadFrequently: true })!;
        cx.fillStyle = "#fff";
        cx.fillRect(0, 0, c.width, c.height);
        await pg.render({
          canvas: c, canvasContext: cx,
          viewport: pg.getViewport({ scale }),
          transform: [1, 0, 0, 1, -r.x * scale, -r.y * scale],
        }).promise;
        return c;
      };
      const shifted = { x: region.x + 8, y: region.y + 6, w: region.w, h: region.h };
      const neighbour = await render(shifted);
      const warmInput = { ...input, canvas: neighbour, offset: { x: shifted.x, y: shifted.y } };

      /**
       * Time the first tile and a second one separately.
       *
       * The first pays for fetching and compiling the models; every tile after it does not. A
       * drawing set is thousands of tiles, so the steady-state number is the one that decides
       * whether this is usable — quoting the cold number alone misleads in the engine's disfavour.
       */
      type Measurable = {
        recognise: (i: typeof input) => Promise<{ words: { text: string }[] }>;
        dispose?: () => unknown;
      };
      const measure = async (provider: Measurable) => {
        const cold0 = performance.now();
        const first = await provider.recognise(input);
        const coldMs = performance.now() - cold0;
        const warm0 = performance.now();
        await provider.recognise(warmInput);
        const warmMs = performance.now() - warm0;
        await provider.dispose?.();
        return {
          coldMs: Math.round(coldMs),
          warmMs: Math.round(warmMs),
          words: first.words.length,
          text: first.words.map((w) => w.text).join(" ").slice(0, 300),
          ...score(first.words),
        };
      };

      const { paddleOcrProvider, tesseractProvider } = await import("/src/index.ts");

      try {
        out["paddle"] = await measure(paddleOcrProvider({ load: engines.loadPaddle }));
      } catch (e) {
        out["paddle"] = { error: (e as Error).message };
      }

      try {
        out["tesseract"] = await measure(tesseractProvider({ load: engines.loadTesseract }));
      } catch (e) {
        out["tesseract"] = { error: (e as Error).message };
      }

      return out;
    }, { region: REGION, dpi: DPI, expected: EXPECTED });

    console.log("\n=== OCR benchmark: title block, 300 DPI ===");
    console.log(JSON.stringify(report, null, 2));

    // No recall threshold: this exists to produce a number, and a hard bar would encode today's
    // model version as a requirement. But an engine that failed to *run* is not a result — the
    // first version of this test reported two load errors and still went green.
    for (const name of ["paddle", "tesseract"] as const) {
      const r = report[name] as { error?: string; words?: number } | undefined;
      expect(r, `${name} produced no report at all`).toBeDefined();
      expect(r?.error, `${name} failed to run: ${r?.error}`).toBeUndefined();
    }
    // Both engines are pointed at a title block full of 6–22pt text. Finding nothing means the
    // rasterised tile was wrong, not that the engine is bad.
    expect((report["paddle"] as { words: number }).words).toBeGreaterThan(0);
    expect((report["tesseract"] as { words: number }).words).toBeGreaterThan(0);
  });
});
