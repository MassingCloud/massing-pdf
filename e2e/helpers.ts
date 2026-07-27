import { expect, type Page } from "@playwright/test";
import type { Viewer } from "../src/core/viewer";

/**
 * Shared fixture setup and the page-space ⇄ client-space bridge the gesture tests need.
 *
 * Everything here talks to the demo through `window.viewer`, which the demo exposes deliberately as
 * its scripting surface. Gestures are driven with real `page.mouse` calls rather than by poking the
 * store, because the whole point of these tests is to exercise the pointer handling.
 */

declare global {
  interface Window {
    /** The demo exposes the viewer deliberately, as its scripting and test surface. */
    viewer: Viewer;
  }
}

/**
 * A point in page space that is definitely inside the sample plan's linework.
 *
 * The sheet is mostly white — the drawing occupies roughly y 684–1548, with blank bands above and
 * below. At fit-width a tile spans most of the page so any tile has ink in it; at high zoom a tile
 * covers a couple of hundred points and can easily be pure margin. Tests that assert "something
 * painted" have to look somewhere that has something to paint.
 */
export const INKED_POINT = { x: 600, y: 1000 };

/** Open the demo and load the generated three-page sample. */
export async function openSample(page: Page): Promise<void> {
  await page.goto("/demo/index.html");
  await page.waitForFunction(() => Boolean(window.viewer), null, { timeout: 30_000 });

  // Start from a clean slate: the demo persists markups in IndexedDB across runs.
  await page.evaluate(async () => {
    const { IndexedDbAdapter } = await import("/src/index.ts");
    const doc = window.viewer.doc?.fingerprint;
    if (doc) await new IndexedDbAdapter().clear({ documentId: doc });
  }).catch(() => { /* nothing stored yet */ });

  // Arm the restore watcher before the load starts, or a fast restore fires before we listen.
  await page.evaluate(() => {
    (window as unknown as { __restored?: boolean }).__restored = false;
    window.viewer.bus.on("markups:restored", () => {
      (window as unknown as { __restored?: boolean }).__restored = true;
    });
  });

  await page.locator("#sample").click();
  await page.waitForFunction(() => Boolean(window.viewer.doc), null, { timeout: 60_000 });
  await page.waitForFunction(() => window.viewer.numPages === 3);
  // Restore lands asynchronously and replaces the entire store when it does. Reset before it has
  // landed and it simply overwrites the reset — along with anything the test went on to add.
  await page.waitForFunction(() => (window as unknown as { __restored?: boolean }).__restored === true,
    null, { timeout: 30_000 });
  // Clear anything a previous run left behind for this fingerprint.
  await page.evaluate(() => { window.viewer.store.reset([], { undoable: false }); window.viewer.redraw(); });
  await expect(page.locator(".mpdf-page-wrap")).toHaveCount(3);
}

/** Wait until a page has painted at least one tile with actual ink on it. */
export async function waitForRender(page: Page, pageNum = 1): Promise<void> {
  await expect
    .poll(async () => inkPixels(page, pageNum), { timeout: 45_000, message: `page ${pageNum} never painted` })
    .toBeGreaterThan(0);
}

/**
 * Count non-white pixels across a page's rendered tiles — proof that pdf.js actually drew.
 *
 * Reads a bounded window out of each tile rather than the whole thing. At high zoom a page carries
 * a dozen or more megapixel tiles, and `getImageData` over all of them costs more than the
 * assertion it serves — enough, on WebKit, to time out a poll while the renderer was working fine.
 */
export async function inkPixels(page: Page, pageNum = 1): Promise<number> {
  return page.evaluate((n) => {
    const wrap = document.querySelector(`.mpdf-page-wrap[data-page="${n}"]`);
    const tiles = (wrap ? Array.from(wrap.querySelectorAll("canvas.mpdf-tile")) : []) as HTMLCanvasElement[];
    const WINDOW = 256;
    let ink = 0;
    // Every tile, but only a window out of each: sampling the first few in DOM order is arbitrary,
    // and at high zoom those happen to be the blank margin at the top of the sheet.
    for (const canvas of tiles) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx || !canvas.width || !canvas.height) continue;
      const w = Math.min(WINDOW, canvas.width);
      const h = Math.min(WINDOW, canvas.height);
      // Centred, because a tile's edges are more often margin than drawing.
      const x = Math.max(0, Math.floor((canvas.width - w) / 2));
      const y = Math.max(0, Math.floor((canvas.height - h) / 2));
      const data = ctx.getImageData(x, y, w, h).data;
      for (let i = 0; i < data.length; i += 4 * 7) {
        if (data[i]! < 240 || data[i + 1]! < 240 || data[i + 2]! < 240) ink++;
      }
    }
    return ink;
  }, pageNum);
}

/** Page-space point → viewport client coordinates, using the live layout. */
export async function toClient(
  page: Page,
  pt: { x: number; y: number },
  pageNum = 1,
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ pt, pageNum }) => {
    const overlay = document.querySelector(`.mpdf-overlay[data-page="${pageNum}"]`);
    if (!overlay) throw new Error(`page ${pageNum} is not mounted`);
    const r = overlay.getBoundingClientRect();
    const zoom = window.viewer.zoom;
    return { x: r.left + pt.x * zoom, y: r.top + pt.y * zoom };
  }, { pt, pageNum });
}

/** Scroll a page-space point into the middle of the viewport, so a gesture there is reachable. */
export async function scrollTo(page: Page, pt: { x: number; y: number }, pageNum = 1): Promise<void> {
  await page.evaluate(({ pt, pageNum }) => {
    const v = window.viewer;
    const wrap = document.querySelector<HTMLElement>(`.mpdf-page-wrap[data-page="${pageNum}"]`);
    if (!wrap) return;
    const s = v.el.scroll;
    s.scrollLeft = wrap.offsetLeft + pt.x * v.zoom - s.clientWidth / 2;
    s.scrollTop = wrap.offsetTop + pt.y * v.zoom - s.clientHeight / 2;
  }, { pt, pageNum });
  // One frame for the scroll to settle before anything reads a bounding box.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

/** Press, move through each point, release — the shape of a drag or freehand gesture. */
export async function dragThrough(
  page: Page,
  points: { x: number; y: number }[],
  pageNum = 1,
  opts: { steps?: number } = {},
): Promise<void> {
  const [first, ...rest] = points;
  if (!first) return;
  const start = await toClient(page, first, pageNum);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const p of rest) {
    const c = await toClient(page, p, pageNum);
    await page.mouse.move(c.x, c.y, { steps: opts.steps ?? 6 });
  }
  await page.mouse.up();
}

/** Click at a page-space point. */
export async function clickAt(
  page: Page,
  pt: { x: number; y: number },
  pageNum = 1,
  opts: { clickCount?: number } = {},
): Promise<void> {
  const c = await toClient(page, pt, pageNum);
  await page.mouse.click(c.x, c.y, opts.clickCount ? { clickCount: opts.clickCount } : {});
}

/** Every markup currently in the store, as plain data. */
export async function annotations(page: Page) {
  return page.evaluate(() => window.viewer.store.all().map((a) => ({
    id: a.id, kind: a.kind, page: a.page, subject: a.subject,
    points: a.points, quantity: a.quantity, status: a.status,
  })));
}

/** Set the page calibration from a named scale preset. */
export async function calibrate(page: Page, label: string, pageNum = 1): Promise<void> {
  await page.evaluate(async ({ label, pageNum }) => {
    const { calibrationFromPreset } = await import("/src/index.ts");
    const cal = calibrationFromPreset(label, pageNum);
    if (!cal) throw new Error(`unknown scale preset ${label}`);
    window.viewer.store.setCalibration(cal, pageNum);
  }, { label, pageNum });
}

/** Answer the next `window.prompt` with a fixed string (or dismiss it with `null`). */
export async function stubPrompt(page: Page, answer: string | null): Promise<void> {
  await page.evaluate((a) => {
    (window as unknown as { prompt: (m?: string, d?: string) => string | null }).prompt = () => a;
  }, answer);
}
