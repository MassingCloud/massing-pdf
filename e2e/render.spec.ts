import { expect, test } from "@playwright/test";
import { INKED_POINT, inkPixels, openSample, scrollTo, waitForRender } from "./helpers";

/**
 * Rasterisation, tiling and view state.
 *
 * None of this can be unit-tested: pdf.js schedules its render continuation on
 * `requestAnimationFrame`, which never fires without a compositor, so in a headless DOM every
 * render simply hangs forever. These assertions look at actual pixels.
 */
test.describe("rasterisation", () => {
  test("paints the sheet", async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
    expect(await inkPixels(page, 1)).toBeGreaterThan(50);
  });

  test("resolves load() without waiting for pixels", async ({ page }) => {
    // The regression this guards: `load()` used to await rasterisation, so a backgrounded tab —
    // where rAF stops — left the host's `await viewer.load(...)` hanging indefinitely.
    await page.goto("/demo/index.html");
    await page.waitForFunction(() => Boolean(window.viewer));
    const settled = await page.evaluate(async () => {
      const t0 = performance.now();
      document.getElementById("sample")!.click();
      for (let i = 0; i < 200 && (document.getElementById("sample") as HTMLButtonElement).disabled; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ms: performance.now() - t0, doc: Boolean(window.viewer.doc) };
    });
    expect(settled.doc).toBe(true);
    expect(settled.ms).toBeLessThan(20_000);
  });

  test("renders every page of the set", async ({ page }) => {
    await openSample(page);
    for (const n of [1, 2, 3]) {
      await page.evaluate((p) => window.viewer.goToPage(p), n);
      await waitForRender(page, n);
    }
  });

  test("tiles a large sheet once it exceeds the single-canvas budget", async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
    const before = await page.locator('.mpdf-page-wrap[data-page="1"] canvas.mpdf-tile').count();

    // An ARCH D sheet at 400% is far past the ~4k-per-side budget, so it must split into tiles.
    await page.evaluate(() => window.viewer.setZoom(4));
    await scrollTo(page, INKED_POINT);
    await expect
      .poll(async () => page.locator('.mpdf-page-wrap[data-page="1"] canvas.mpdf-tile').count(), { timeout: 45_000 })
      .toBeGreaterThan(before);
    await waitForRender(page, 1);
  });

  test("keeps every tile within the per-canvas size budget", async ({ page }) => {
    await openSample(page);
    await page.evaluate(() => window.viewer.setZoom(6));
    await scrollTo(page, INKED_POINT);
    await waitForRender(page, 1);

    const oversized = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas.mpdf-tile"))
        .filter((c) => c.width > 4096 || c.height > 4096 || c.width * c.height > 4096 * 4096).length);
    // Exceeding it does not throw — the browser silently yields a blank canvas, which is precisely
    // the failure this tiling exists to prevent.
    expect(oversized).toBe(0);
  });

  test("still has ink after zooming in, not a blank sheet", async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
    await page.evaluate(() => window.viewer.setZoom(5));
    await scrollTo(page, INKED_POINT);
    await waitForRender(page, 1);
    expect(await inkPixels(page, 1)).toBeGreaterThan(50);
  });

  test("releases rasters for pages scrolled far away", async ({ page }) => {
    await openSample(page);
    // Two screens of slack are kept deliberately, so a flick-scroll back is instant. Zoom in far
    // enough that page 1 is unambiguously past that before asserting it was dropped.
    await page.evaluate(() => window.viewer.setZoom(3));
    await waitForRender(page, 1);
    await page.evaluate(() => window.viewer.goToPage(3));
    await waitForRender(page, 3);
    await expect
      .poll(() => page.locator('.mpdf-page-wrap[data-page="1"] canvas.mpdf-tile').count(), { timeout: 30_000 })
      .toBe(0);
  });

  test("paints sheet-index thumbnails", async ({ page }) => {
    await openSample(page);
    await expect(page.locator(".mpdf-sheet-card")).toHaveCount(3);
    await expect
      .poll(() => page.locator(".mpdf-sheet-thumb canvas").count(), { timeout: 45_000 })
      .toBeGreaterThan(0);
  });
});

test.describe("view state", () => {
  test("fit-width sizes the page to the viewport", async ({ page }) => {
    await openSample(page);
    await page.evaluate(() => window.viewer.fitWidth());
    const fit = await page.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>('.mpdf-page-wrap[data-page="1"]')!;
      return { pageWidth: wrap.offsetWidth, available: window.viewer.el.scroll.clientWidth };
    });
    expect(fit.pageWidth).toBeGreaterThan(fit.available * 0.8);
    expect(fit.pageWidth).toBeLessThanOrEqual(fit.available);
  });

  test("rotation swaps the page box and leaves geometry untouched", async ({ page }) => {
    await openSample(page);
    const before = await page.evaluate(() => {
      const w = document.querySelector<HTMLElement>('.mpdf-page-wrap[data-page="1"]')!;
      return { w: w.offsetWidth, h: w.offsetHeight };
    });
    const annot = await page.evaluate(() => window.viewer.addAnnotation({
      kind: "rect", page: 1, points: [{ x: 100, y: 100 }, { x: 300, y: 200 }],
    }).points);

    await page.evaluate(() => window.viewer.rotate(90));
    const after = await page.evaluate(() => {
      const w = document.querySelector<HTMLElement>('.mpdf-page-wrap[data-page="1"]')!;
      return { w: w.offsetWidth, h: w.offsetHeight };
    });
    expect(after.w).toBeCloseTo(before.h, 0);
    expect(after.h).toBeCloseTo(before.w, 0);

    // Rotation is a view concern; a stored point must never be rewritten by it.
    const stored = await page.evaluate(() => window.viewer.store.all()[0]!.points);
    expect(stored).toEqual(annot);
  });

  test("zooms about the cursor, keeping the point under it fixed", async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
    const anchor = { clientX: 700, clientY: 500 };
    const pageAt = (v: typeof anchor) => page.evaluate(
      (a) => window.viewer.clientToPage(a.clientX, a.clientY, 1),
      v,
    );
    const before = await pageAt(anchor);
    await page.evaluate((a) => window.viewer.setZoom(window.viewer.zoom * 2, a), anchor);
    const after = await pageAt(anchor);
    expect(after!.x).toBeCloseTo(before!.x, 0);
    expect(after!.y).toBeCloseTo(before!.y, 0);
  });

  test("hides the text layer under rotation rather than mis-placing selections", async ({ page }) => {
    await openSample(page);
    await page.evaluate(() => window.viewer.setTool("highlight"));
    await expect
      .poll(() => page.locator(".mpdf-textlayer span").count(), { timeout: 20_000 })
      .toBeGreaterThan(0);

    const visible = () => page.evaluate(() =>
      getComputedStyle(document.querySelector(".mpdf-textlayer")!).display);
    expect(await visible()).not.toBe("none");
    await page.evaluate(() => window.viewer.rotate(90));
    expect(await visible()).toBe("none");
    await page.evaluate(() => window.viewer.rotate(270));
    expect(await visible()).not.toBe("none");
  });
});
