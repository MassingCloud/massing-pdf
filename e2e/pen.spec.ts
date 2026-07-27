import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { annotations, openSample, scrollTo, toClient, waitForRender } from "./helpers";

/**
 * Pen and stylus.
 *
 * The behaviour that matters is what the viewer *ignores*: a hand resting on a tablet is a touch
 * contact, and without rejection it draws across whatever the stylus is writing. Playwright has no
 * pen API, so these dispatch raw CDP pointer events with `pointerType: "pen"`.
 */

const sessions = new WeakMap<Page, Promise<CDPSession>>();
function cdp(page: Page) {
  let s = sessions.get(page);
  if (!s) { s = page.context().newCDPSession(page); sessions.set(page, s); }
  return s;
}

/** A pen contact. `pressure` is what a real stylus varies through a stroke. */
async function pen(
  page: Page,
  type: "mousePressed" | "mouseMoved" | "mouseReleased",
  at: { x: number; y: number },
  pressure = 0.5,
): Promise<void> {
  const client = await cdp(page);
  await client.send("Input.dispatchMouseEvent", {
    type,
    x: at.x,
    y: at.y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
    pointerType: "pen",
    force: pressure,
  });
}

async function touch(
  page: Page,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: { x: number; y: number }[],
): Promise<void> {
  const client = await cdp(page);
  await client.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })),
  });
}

test.describe("pen", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
    await scrollTo(page, { x: 400, y: 400 });
  });

  test("draws with a stylus", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("ink"));
    const from = await toClient(page, { x: 300, y: 350 });

    await pen(page, "mousePressed", from, 0.4);
    for (let i = 1; i <= 8; i++) {
      await pen(page, "mouseMoved", { x: from.x + i * 12, y: from.y + Math.sin(i) * 8 }, 0.4 + i * 0.05);
    }
    await pen(page, "mouseReleased", { x: from.x + 96, y: from.y });

    await expect.poll(async () => (await annotations(page)).length, { timeout: 10_000 }).toBe(1);
    expect((await annotations(page))[0]?.kind).toBe("ink");
  });

  test("keeps the pressure samples on the record", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("ink"));
    const from = await toClient(page, { x: 300, y: 350 });
    await pen(page, "mousePressed", from, 0.2);
    for (let i = 1; i <= 8; i++) {
      await pen(page, "mouseMoved", { x: from.x + i * 12, y: from.y }, 0.2 + i * 0.08);
    }
    await pen(page, "mouseReleased", { x: from.x + 96, y: from.y }, 0.9);

    await expect.poll(async () => (await annotations(page)).length, { timeout: 10_000 }).toBe(1);
    const pressures = await page.evaluate(() =>
      window.viewer.store.all()[0]!.ext?.["pressures"] as number[] | undefined);
    // Kept even though the renderer draws a single width, because discarding them at capture time
    // would make variable-width rendering unrecoverable later.
    expect(pressures?.length ?? 0).toBeGreaterThan(1);
  });

  test("ignores a palm resting while the pen is drawing", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("rect"));
    const start = await toClient(page, { x: 300, y: 300 });

    // Pen down and moving — a stroke in progress.
    await pen(page, "mousePressed", start, 0.5);
    await pen(page, "mouseMoved", { x: start.x + 40, y: start.y + 30 }, 0.5);

    // A hand lands on the sheet. Without rejection this becomes a second pointer and, with two
    // contacts, a pinch — which would abandon the stroke and zoom the sheet under the stylus.
    await touch(page, "touchStart", [{ x: start.x + 300, y: start.y + 200 }]);
    await touch(page, "touchMove", [{ x: start.x + 320, y: start.y + 220 }]);

    const zoomDuringPalm = await page.evaluate(() => window.viewer.zoom);
    await pen(page, "mouseMoved", { x: start.x + 120, y: start.y + 90 }, 0.5);
    await pen(page, "mouseReleased", { x: start.x + 120, y: start.y + 90 });
    await touch(page, "touchEnd", []);

    // The stroke completed, and the palm neither zoomed nor drew.
    await expect.poll(async () => (await annotations(page)).length, { timeout: 10_000 }).toBe(1);
    const [a] = await annotations(page);
    expect(a?.kind).toBe("rect");
    expect(await page.evaluate(() => window.viewer.zoom)).toBeCloseTo(zoomDuringPalm, 5);
  });

  test("lets fingers work again once the pen is put down", async ({ page }) => {
    // Rejection is a short window, not a mode — picking up the tablet after writing should not
    // leave touch dead.
    const at = await toClient(page, { x: 350, y: 350 });
    await pen(page, "mousePressed", at, 0.5);
    await pen(page, "mouseReleased", at);

    await page.waitForTimeout(900);   // longer than the palm window

    await page.evaluate(() => window.viewer.setTool("count"));
    await touch(page, "touchStart", [at]);
    await touch(page, "touchEnd", []);
    await expect.poll(async () => (await annotations(page)).length, { timeout: 10_000 }).toBe(1);
  });

  test("a pen landing mid-pinch abandons the pinch rather than fighting it", async ({ page }) => {
    const centre = { x: 800, y: 500 };
    await touch(page, "touchStart", [
      { x: centre.x - 80, y: centre.y },
      { x: centre.x + 80, y: centre.y },
    ]);
    await touch(page, "touchMove", [
      { x: centre.x - 140, y: centre.y },
      { x: centre.x + 140, y: centre.y },
    ]);
    const zoomed = await page.evaluate(() => window.viewer.zoom);

    // Stylus touches down: the fingers are now a resting hand.
    await pen(page, "mousePressed", { x: centre.x, y: centre.y + 100 }, 0.5);
    await touch(page, "touchMove", [
      { x: centre.x - 300, y: centre.y },
      { x: centre.x + 300, y: centre.y },
    ]);
    await pen(page, "mouseReleased", { x: centre.x, y: centre.y + 100 });
    await touch(page, "touchEnd", []);

    // The abandoned pinch did not keep zooming.
    expect(await page.evaluate(() => window.viewer.zoom)).toBeCloseTo(zoomed, 5);
  });
});
