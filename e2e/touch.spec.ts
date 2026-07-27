import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { annotations, openSample, scrollTo, toClient, waitForRender } from "./helpers";

/**
 * Touch input.
 *
 * The field half of the product runs on tablets, and touch is not just "a mouse with a fat cursor":
 * the browser competes for the gesture. One finger scrolls unless something takes it away, two
 * fingers pinch unless something opts out, and a gesture the browser claims mid-way ends in
 * `pointercancel` with no `pointerup` at all.
 *
 * Playwright's `page.mouse` can't express any of that, so these drive CDP's raw touch input.
 */

/**
 * One CDP session per page, reused.
 *
 * Touch state lives in the session: a `touchMove` on a fresh session is rejected because that
 * session never saw the `touchStart` that began the sequence.
 */
const sessions = new WeakMap<Page, Promise<CDPSession>>();

function cdp(page: Page) {
  let s = sessions.get(page);
  if (!s) { s = page.context().newCDPSession(page); sessions.set(page, s); }
  return s;
}

/** Dispatch a raw touch event with the given points, in viewport coordinates. */
async function touch(
  page: Page,
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  points: { x: number; y: number }[],
): Promise<void> {
  const client = await cdp(page);
  await client.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })),
  });
}

/** A pinch about a centre: both fingers move from `from` to `to` separation. */
async function pinch(page: Page, centre: { x: number; y: number }, from: number, to: number): Promise<void> {
  const at = (gap: number) => [
    { x: centre.x - gap / 2, y: centre.y },
    { x: centre.x + gap / 2, y: centre.y },
  ];
  await touch(page, "touchStart", at(from));
  // Several steps, because the handler tracks a ratio against the starting spread.
  for (let i = 1; i <= 5; i++) await touch(page, "touchMove", at(from + ((to - from) * i) / 5));
  await touch(page, "touchEnd", []);
}

test.describe("touch", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
  });

  test("pinching out zooms in", async ({ page }) => {
    const before = await page.evaluate(() => window.viewer.zoom);
    await pinch(page, { x: 800, y: 500 }, 120, 420);
    await expect.poll(() => page.evaluate(() => window.viewer.zoom), { timeout: 15_000 })
      .toBeGreaterThan(before * 1.5);
  });

  test("pinching in zooms out", async ({ page }) => {
    await page.evaluate(() => window.viewer.setZoom(2));
    const before = await page.evaluate(() => window.viewer.zoom);
    await pinch(page, { x: 800, y: 500 }, 420, 120);
    await expect.poll(() => page.evaluate(() => window.viewer.zoom), { timeout: 15_000 })
      .toBeLessThan(before * 0.7);
  });

  test("keeps the pinched point roughly under the fingers", async ({ page }) => {
    const centre = { x: 800, y: 500 };
    const pageAt = () => page.evaluate(
      (c) => window.viewer.clientToPage(c.x, c.y, window.viewer.page),
      centre,
    );
    const before = await pageAt();
    await pinch(page, centre, 150, 300);
    await expect.poll(async () => {
      const after = await pageAt();
      return Math.hypot((after?.x ?? 0) - (before?.x ?? 0), (after?.y ?? 0) - (before?.y ?? 0));
      // Solved against the pinch start, so the drift is sub-pixel arithmetic rather than the
      // accumulated error of one correction per frame.
    }, { timeout: 15_000 }).toBeLessThan(20);
  });

  test("does not zoom past the clamps", async ({ page }) => {
    await page.evaluate(() => window.viewer.setZoom(15));
    await pinch(page, { x: 800, y: 500 }, 100, 900);
    expect(await page.evaluate(() => window.viewer.zoom)).toBeLessThanOrEqual(16);

    await page.evaluate(() => window.viewer.setZoom(0.1));
    await pinch(page, { x: 800, y: 500 }, 900, 100);
    expect(await page.evaluate(() => window.viewer.zoom)).toBeGreaterThanOrEqual(0.08);
  });

  test("a pinch never leaves a markup behind", async ({ page }) => {
    // Two fingers while a tool is armed must reposition, not draw — otherwise every zoom on a
    // tablet litters the sheet.
    await page.evaluate(() => window.viewer.setTool("rect"));
    await pinch(page, { x: 800, y: 500 }, 150, 350);
    expect(await annotations(page)).toHaveLength(0);
  });

  test("hands one-finger drags to the viewer when a tool is armed", async ({ page }) => {
    // With the browser owning the gesture, a touch-drag pans the sheet and draws nothing. The
    // viewer has to claim it — which is what `touch-action: none` on the page column does.
    const idle = await page.evaluate(() => getComputedStyle(window.viewer.el.pages).touchAction);
    await page.evaluate(() => window.viewer.setTool("rect"));
    const armed = await page.evaluate(() => getComputedStyle(window.viewer.el.pages).touchAction);

    expect(idle).toContain("pan");
    expect(armed).toBe("none");
  });

  test("draws a rectangle from a one-finger drag", async ({ page }) => {
    await scrollTo(page, { x: 400, y: 400 });
    await page.evaluate(() => window.viewer.setTool("rect"));
    const from = await toClient(page, { x: 300, y: 300 });
    const to = await toClient(page, { x: 500, y: 420 });

    await touch(page, "touchStart", [from]);
    for (let i = 1; i <= 4; i++) {
      await touch(page, "touchMove", [{
        x: from.x + ((to.x - from.x) * i) / 4,
        y: from.y + ((to.y - from.y) * i) / 4,
      }]);
    }
    await touch(page, "touchEnd", []);

    await expect.poll(async () => (await annotations(page)).length, { timeout: 10_000 }).toBe(1);
    const [a] = await annotations(page);
    expect(a?.kind).toBe("rect");
    expect(a!.points[0]!.x).toBeCloseTo(300, -1);
  });

  test("abandons a gesture the browser takes over", async ({ page }) => {
    await scrollTo(page, { x: 400, y: 400 });
    await page.evaluate(() => window.viewer.setTool("rect"));
    const from = await toClient(page, { x: 300, y: 300 });

    await touch(page, "touchStart", [from]);
    await touch(page, "touchMove", [{ x: from.x + 60, y: from.y + 40 }]);
    // A genuine cancel from the browser, carrying the real pointer id — a synthetic event with a
    // guessed id would prove nothing, since the handler matches on the gesture's own pointer.
    await touch(page, "touchCancel", []);

    // Nothing committed, and no draft is left dangling to attach itself to the next tap.
    expect(await annotations(page)).toHaveLength(0);
    await touch(page, "touchStart", [{ x: from.x + 200, y: from.y }]);
    await touch(page, "touchEnd", []);
    expect(await annotations(page)).toHaveLength(0);
  });

  test("taps a point tool once, not twice", async ({ page }) => {
    await scrollTo(page, { x: 400, y: 400 });
    await page.evaluate(() => window.viewer.setTool("count"));
    const at = await toClient(page, { x: 350, y: 350 });
    await touch(page, "touchStart", [at]);
    await touch(page, "touchEnd", []);
    await expect.poll(async () => (await annotations(page)).length, { timeout: 10_000 }).toBe(1);
  });
});
