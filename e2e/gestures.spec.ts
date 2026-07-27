import { expect, test } from "@playwright/test";
import {
  annotations, calibrate, clickAt, dragThrough, openSample, scrollTo, stubPrompt, toClient, waitForRender,
} from "./helpers";

/**
 * The pointer gesture loop.
 *
 * Driven with real mouse events, because the thing under test *is* the pointer handling — poking
 * the store directly would assert nothing about it. Coordinates are page-space and converted
 * through the live layout, so these read as "drag from here to there on the drawing".
 */

/** Somewhere in the middle of the sample plan, clear of the title block. */
const AREA = { x: 400, y: 400 };

test.beforeEach(async ({ page }) => {
  await openSample(page);
  await waitForRender(page, 1);
  await scrollTo(page, AREA);
});

test.describe("drag tools", () => {
  test("draws a rectangle from a press-drag-release", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("rect"));
    await dragThrough(page, [{ x: 300, y: 300 }, { x: 500, y: 420 }]);

    const [a] = await annotations(page);
    expect(a?.kind).toBe("rect");
    // Within a couple of points: engines round synthetic pointer coordinates differently, and at
    // fit-width a point is well under a device pixel. Asserting tighter tests the browser's
    // rounding, not the viewer.
    expect(a!.points[0]!.x).toBeCloseTo(300, -1);
    expect(a!.points[1]!.y).toBeCloseTo(420, -1);
  });

  test("discards a click that never moved, rather than storing a zero-size markup", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("rect"));
    await clickAt(page, { x: 350, y: 350 });
    expect(await annotations(page)).toHaveLength(0);
  });

  test("snaps to 15° with shift held", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("line"));
    const from = await toClient(page, { x: 300, y: 400 });
    const to = await toClient(page, { x: 500, y: 415 });   // ~4° off horizontal
    await page.keyboard.down("Shift");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Shift");

    const [a] = await annotations(page);
    const dy = a!.points[1]!.y - a!.points[0]!.y;
    expect(Math.abs(dy)).toBeLessThan(1);
  });

  test("falls back to select after a non-sticky tool commits", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("rect"));
    await dragThrough(page, [{ x: 300, y: 300 }, { x: 400, y: 380 }]);
    expect(await page.evaluate(() => window.viewer.activeTool?.id ?? null)).toBeNull();
  });

  test("stays armed for a sticky tool", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("count"));
    await clickAt(page, { x: 320, y: 320 });
    await clickAt(page, { x: 360, y: 320 });
    await clickAt(page, { x: 400, y: 320 });
    expect(await annotations(page)).toHaveLength(3);
    expect(await page.evaluate(() => window.viewer.activeTool?.id)).toBe("count");
  });
});

test.describe("poly tools", () => {
  test("collects a vertex per click and finishes on double-click", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("cloud"));
    await clickAt(page, { x: 300, y: 300 });
    await clickAt(page, { x: 500, y: 300 });
    await clickAt(page, { x: 500, y: 450 });
    await clickAt(page, { x: 300, y: 450 }, 1, { clickCount: 2 });

    const [a] = await annotations(page);
    expect(a?.kind).toBe("cloud");
    expect(a!.points.length).toBeGreaterThanOrEqual(4);
  });

  test("finishes on Enter", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("polygon"));
    await clickAt(page, { x: 300, y: 300 });
    await clickAt(page, { x: 450, y: 300 });
    await clickAt(page, { x: 450, y: 420 });
    await page.keyboard.press("Enter");
    expect(await annotations(page)).toHaveLength(1);
  });

  test("commits automatically at maxPoints", async ({ page }) => {
    // The angle tool takes exactly three points.
    await page.evaluate(() => window.viewer.setTool("angle"));
    await clickAt(page, { x: 300, y: 420 });
    await clickAt(page, { x: 300, y: 300 });
    await clickAt(page, { x: 420, y: 300 });

    const [a] = await annotations(page);
    expect(a?.kind).toBe("angle");
    expect(a!.quantity!.value).toBeCloseTo(90, 0);
    expect(a!.quantity!.unit).toBe("°");
  });

  test("Escape abandons a part-drawn polygon", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("polygon"));
    await clickAt(page, { x: 300, y: 300 });
    await clickAt(page, { x: 450, y: 300 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    expect(await annotations(page)).toHaveLength(0);
  });
});

test.describe("freehand", () => {
  test("samples and simplifies a pointer path", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("ink"));
    const path = Array.from({ length: 24 }, (_, i) => ({ x: 300 + i * 8, y: 380 + Math.sin(i / 3) * 30 }));
    await dragThrough(page, path, 1, { steps: 2 });

    const [a] = await annotations(page);
    expect(a?.kind).toBe("ink");
    expect(a!.points.length).toBeGreaterThan(2);
    // Simplification must not keep every sampled point, nor collapse the curve to a line.
    expect(a!.points.length).toBeLessThan(200);
  });
});

test.describe("selection and editing", () => {
  test("clicks a markup to select it", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("rect"));
    await dragThrough(page, [{ x: 300, y: 300 }, { x: 500, y: 420 }]);
    await page.evaluate(() => window.viewer.store.select(null));

    await page.evaluate(() => window.viewer.setTool(null));
    await clickAt(page, { x: 300, y: 300 });     // on the edge of the rect
    expect(await page.evaluate(() => window.viewer.store.selectedIds().length)).toBe(1);
  });

  test("clicking empty space clears the selection", async ({ page }) => {
    await page.evaluate(() => {
      window.viewer.addAnnotation({ kind: "rect", page: 1, points: [{ x: 300, y: 300 }, { x: 400, y: 380 }] });
      window.viewer.setTool(null);
    });
    await clickAt(page, { x: 320, y: 320 });
    await clickAt(page, { x: 900, y: 900 });
    expect(await page.evaluate(() => window.viewer.store.selectedIds().length)).toBe(0);
  });

  test("drags a selected markup, recording one undo step for the whole gesture", async ({ page }) => {
    await page.evaluate(() => {
      const a = window.viewer.addAnnotation({
        kind: "rect", page: 1, points: [{ x: 300, y: 300 }, { x: 450, y: 400 }],
        style: { fill: "#4a8cff" },
      });
      window.viewer.store.select(a.id);
      window.viewer.store.clearHistory();
      window.viewer.setTool(null);
    });

    await dragThrough(page, [{ x: 375, y: 350 }, { x: 475, y: 430 }]);
    const moved = (await annotations(page))[0]!;
    expect(moved.points[0]!.x).toBeCloseTo(400, -1);
    expect(moved.points[0]!.y).toBeCloseTo(380, -1);

    // One undo returns it, which is the assertion that matters: the drag applied dozens of
    // intermediate frames, and every one of them landing in the history would be unusable.
    await page.evaluate(() => window.viewer.store.undo());
    const back = (await annotations(page))[0]!;
    expect(back.points[0]!.x).toBeCloseTo(300, 0);
    expect(await page.evaluate(() => window.viewer.store.canUndo)).toBe(false);
  });

  test("drags a vertex of a selected markup", async ({ page }) => {
    await page.evaluate(() => {
      const a = window.viewer.addAnnotation({
        kind: "polygon", page: 1,
        points: [{ x: 300, y: 300 }, { x: 450, y: 300 }, { x: 450, y: 420 }],
      });
      window.viewer.store.select(a.id);
      window.viewer.setTool(null);
    });
    await dragThrough(page, [{ x: 450, y: 300 }, { x: 520, y: 260 }]);

    const pts = (await annotations(page))[0]!.points;
    expect(pts[1]!.x).toBeCloseTo(520, -1);
    expect(pts[1]!.y).toBeCloseTo(260, -1);
    // The other vertices must not have moved.
    expect(pts[0]!.x).toBeCloseTo(300, 0);
  });

  test("Delete removes the selection", async ({ page }) => {
    await page.evaluate(() => {
      const a = window.viewer.addAnnotation({ kind: "rect", page: 1, points: [{ x: 300, y: 300 }, { x: 400, y: 380 }] });
      window.viewer.store.select(a.id);
    });
    await page.locator(".mpdf-root").focus();
    await page.keyboard.press("Delete");
    expect(await annotations(page)).toHaveLength(0);
  });

  test("Ctrl+Z and Ctrl+Shift+Z undo and redo", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("rect"));
    await dragThrough(page, [{ x: 300, y: 300 }, { x: 420, y: 380 }]);
    expect(await annotations(page)).toHaveLength(1);

    await page.locator(".mpdf-root").focus();
    await page.keyboard.press("Control+z");
    expect(await annotations(page)).toHaveLength(0);
    await page.keyboard.press("Control+Shift+z");
    expect(await annotations(page)).toHaveLength(1);
  });

  test("keyboard shortcuts arm tools", async ({ page }) => {
    await page.locator(".mpdf-root").focus();
    await page.keyboard.press("c");
    expect(await page.evaluate(() => window.viewer.activeTool?.id)).toBe("cloud");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => window.viewer.activeTool)).toBeNull();
  });
});

test.describe("measurement through the gesture loop", () => {
  test("measures the dimension printed on the sheet", async ({ page }) => {
    // The sample plan is drawn at 1/8" = 1'-0" with a 144'-0" overall dimension spanning
    // x = 120 to x = 120 + 144*9 pt. Calibrating to the title-block scale and dragging that span
    // must return the number printed on the drawing.
    await calibrate(page, `1/8" = 1'-0"`, 1);
    await page.evaluate(() => window.viewer.setTool("distance"));
    await scrollTo(page, { x: 120 + 144 * 9 / 2, y: 400 });
    await dragThrough(page, [{ x: 120, y: 400 }, { x: 120 + 144 * 9, y: 400 }]);

    const [a] = await annotations(page);
    expect(a?.kind).toBe("distance");
    expect(a!.quantity!.unit).toBe("ft");
    expect(a!.quantity!.value).toBeCloseTo(144, 1);
  });

  test("refuses a measurement before the page is calibrated", async ({ page }) => {
    await page.evaluate(() => window.viewer.setTool("distance"));
    await dragThrough(page, [{ x: 300, y: 400 }, { x: 500, y: 400 }]);
    expect(await annotations(page)).toHaveLength(0);
    await expect(page.locator(".mpdf-notice")).toContainText(/scale/i);
  });

  test("re-calibrating re-derives measurements already on the page", async ({ page }) => {
    await calibrate(page, `1/8" = 1'-0"`, 1);
    await page.evaluate(() => window.viewer.setTool("distance"));
    await dragThrough(page, [{ x: 300, y: 400 }, { x: 300 + 72 * 9, y: 400 }]);
    expect((await annotations(page))[0]!.quantity!.value).toBeCloseTo(72, 1);

    // Half the scale: the same ink is now half the distance.
    await calibrate(page, `1/16" = 1'-0"`, 1);
    await page.evaluate(() => window.viewer.recalculatePage(1));
    expect((await annotations(page))[0]!.quantity!.value).toBeCloseTo(144, 1);
  });
});

test.describe("text selection", () => {
  test("builds a highlight from selected glyphs, one quad per line", async ({ page }) => {
    // Page 3 is the CSI spec section, which has real paragraph text to select.
    await page.evaluate(() => window.viewer.goToPage(3));
    await page.evaluate(() => window.viewer.setTool("highlight"));
    await expect
      .poll(() => page.locator('.mpdf-textlayer[data-page="3"] span').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    const ok = await page.evaluate(() => {
      const layer = window.viewer.textLayer(3)!;
      const spans = Array.from(layer.el.querySelectorAll("span"));
      const start = spans.findIndex((s) => /Product Data/i.test(s.textContent ?? ""));
      if (start < 0 || !spans[start + 2]) return false;
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      const range = document.createRange();
      range.setStart(spans[start]!.firstChild!, 0);
      range.setEnd(spans[start + 2]!.firstChild!, (spans[start + 2]!.textContent ?? "").length);
      sel.addRange(range);
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      return true;
    });
    expect(ok).toBe(true);

    await expect.poll(async () => (await annotations(page)).length, { timeout: 10_000 }).toBe(1);
    const [a] = await annotations(page);
    expect(a?.kind).toBe("highlight");

    const quads = await page.evaluate(() => window.viewer.store.all()[0]!.ext?.["quads"] as unknown[]);
    expect(quads.length).toBe(3);
  });
});

test.describe("prompted tools", () => {
  test("stores the text a text markup was given", async ({ page }) => {
    await stubPrompt(page, "Verify header size");
    await page.evaluate(() => window.viewer.setTool("text"));
    await clickAt(page, { x: 350, y: 350 });

    const [a] = await annotations(page);
    expect(a?.kind).toBe("text");
    expect(await page.evaluate(() => window.viewer.store.all()[0]!.text)).toBe("Verify header size");
  });

  test("creates nothing when the prompt is cancelled", async ({ page }) => {
    await stubPrompt(page, null);
    await page.evaluate(() => window.viewer.setTool("text"));
    await clickAt(page, { x: 350, y: 350 });
    expect(await annotations(page)).toHaveLength(0);
  });
});
