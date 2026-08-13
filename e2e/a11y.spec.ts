import { expect, test } from "@playwright/test";
import { openSample, waitForRender } from "./helpers";

/**
 * Keyboard operation and assistive-technology semantics.
 *
 * Asserting that an `aria-label` attribute exists proves nothing about whether the interface can be
 * used without a mouse. These drive the real keyboard: Tab to reach a list, arrows to move inside
 * it, Enter to act, and check that the thing that should have happened did.
 *
 * A review tool produces contract documents. "You need a mouse" excludes someone from the record,
 * not just from a convenience — and WCAG 2.1 AA conformance is usually a procurement gate too.
 */

test.describe("keyboard operation", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
  });

  test("every markup row is reachable and actionable without a mouse", async ({ page }) => {
    await page.evaluate(() => {
      for (const y of [200, 400, 600]) {
        window.viewer.addAnnotation({
          kind: "rect", page: 1, points: [{ x: 100, y }, { x: 300, y: y + 80 }], subject: `Row ${y}`,
        });
      }
    });

    const rows = page.locator('[role="listbox"][aria-label="Markups"] [role="option"]');
    await expect(rows).toHaveCount(3);

    // One tab stop for the whole list, which is the point of a roving tabindex — otherwise a
    // two-hundred-markup review is two hundred presses of Tab to get past.
    const tabbable = await rows.evaluateAll((els) => els.filter((e) => e.tabIndex === 0).length);
    expect(tabbable).toBe(1);

    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    const second = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label") ?? "");
    expect(second).toContain("Row 400");

    // Enter selects, exactly as a click would.
    await page.keyboard.press("Enter");
    await expect.poll(async () => page.evaluate(() => window.viewer.store.selectedIds().length)).toBe(1);
  });

  test("Space activates a row without scrolling the drawing away underneath", async ({ page }) => {
    await page.evaluate(() => {
      window.viewer.addAnnotation({ kind: "rect", page: 1, points: [{ x: 50, y: 900 }, { x: 90, y: 940 }] });
    });
    const row = page.locator('[role="listbox"][aria-label="Markups"] [role="option"]').first();
    await row.focus();
    const before = await page.evaluate(() => window.viewer.el.scroll.scrollTop);
    await page.keyboard.press("Space");
    // Default Space behaviour is page-down; in a viewer that drags the sheet out from under you.
    const after = await page.evaluate(() => window.viewer.el.scroll.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(400);
    await expect.poll(async () => page.evaluate(() => window.viewer.store.selectedIds().length)).toBe(1);
  });

  test("a sheet card can be opened from the keyboard", async ({ page }) => {
    const cards = page.locator('[role="listbox"][aria-label="Sheets"] [role="option"]');
    await expect(cards).toHaveCount(3);
    await cards.first().focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(async () => page.evaluate(() => window.viewer.page)).toBe(2);
  });

  test("Home and End jump to the ends of a list", async ({ page }) => {
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) {
        window.viewer.addAnnotation({
          kind: "rect", page: 1, points: [{ x: 10, y: 100 * i + 100 }, { x: 40, y: 100 * i + 140 }],
          subject: `Item ${i}`,
        });
      }
    });
    const rows = page.locator('[role="listbox"][aria-label="Markups"] [role="option"]');
    await rows.first().focus();
    await page.keyboard.press("End");
    const last = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
    await page.keyboard.press("Home");
    const first = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
    expect(last).not.toBe(first);
  });
});

test.describe("assistive-technology semantics", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
  });

  test("the shell carries landmarks a screen reader can jump between", async ({ page }) => {
    const labels = await page.evaluate(() => ({
      root: document.querySelector(".mpdf-root")?.getAttribute("aria-label"),
      toolbar: document.querySelector(".mpdf-toolbar")?.getAttribute("role"),
      drawing: document.querySelector(".mpdf-scroll")?.getAttribute("aria-label"),
      status: document.querySelector(".mpdf-status")?.getAttribute("role"),
    }));
    expect(labels.root).toBeTruthy();
    expect(labels.toolbar).toBe("toolbar");
    expect(labels.drawing).toBe("Drawing");
    expect(labels.status).toBe("status");
  });

  test("a tool button says which tool it is and whether it is armed", async ({ page }) => {
    // The visible label is one glyph, which reads as an emoji name or as nothing at all.
    const button = page.locator('.mpdf-tb-btn[data-id="rect"]');
    await expect(button).toHaveAttribute("aria-label", /rect/i);
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await page.evaluate(() => window.viewer.setTool("rect"));
    await expect(page.locator('.mpdf-tb-btn[data-id="rect"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("status changes are announced, not only coloured", async ({ page }) => {
    const live = page.locator('[aria-live="polite"]');
    await expect(live).toHaveCount(1);
    await page.evaluate(() => window.viewer.goToPage(2));
    await expect.poll(async () => live.textContent(), { timeout: 5_000 }).toContain("Page 2");
  });

  test("an error interrupts rather than queueing behind other announcements", async ({ page }) => {
    await page.evaluate(() =>
      window.viewer.bus.emit("notice", { level: "error", message: "Couldn't save markups" }));
    await expect.poll(async () => page.locator('[aria-live="assertive"]').textContent(), { timeout: 5_000 })
      .toContain("Couldn't save");
  });

  test("a selected row says it is selected, not just shows it", async ({ page }) => {
    await page.evaluate(() => {
      const a = window.viewer.addAnnotation({
        kind: "rect", page: 1, points: [{ x: 10, y: 10 }, { x: 40, y: 40 }],
      });
      window.viewer.store.select(a.id);
    });
    const row = page.locator('[role="listbox"][aria-label="Markups"] [role="option"]').first();
    await expect(row).toHaveAttribute("aria-selected", "true");
  });

  test("a markup row's label carries the status the colour swatch conveys visually", async ({ page }) => {
    await page.evaluate(() => window.viewer.addAnnotation({
      kind: "cloud", page: 2, points: [{ x: 10, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }],
      subject: "Check header height",
    }));
    const row = page.locator('[role="listbox"][aria-label="Markups"] [role="option"]').first();
    const label = await row.getAttribute("aria-label");
    expect(label).toContain("cloud");
    expect(label).toContain("page 2");
    expect(label).toContain("open");
    expect(label).toContain("Check header height");
  });

  test("keyboard focus is visible", async ({ page }) => {
    // Removing the focus ring is the single most common way an interface becomes unusable without
    // a mouse, and it usually happens because :focus was styled instead of :focus-visible.
    await page.evaluate(() => window.viewer.addAnnotation({
      kind: "rect", page: 1, points: [{ x: 10, y: 10 }, { x: 40, y: 40 }],
    }));
    const row = page.locator('[role="listbox"][aria-label="Markups"] [role="option"]').first();
    await row.focus();
    await page.keyboard.press("ArrowDown");
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return { width: s.outlineWidth, style: s.outlineStyle };
    });
    expect(outline.style).not.toBe("none");
    expect(parseFloat(outline.width)).toBeGreaterThan(0);
  });
});

/**
 * The side rails must not overlap themselves.
 *
 * `.mpdf-side` is a flex column with `overflow-y: auto`, but flex children default to
 * `flex-shrink: 1`. Once the panels together exceed the rail, flexbox squeezes each one *below its
 * content* instead of letting the rail scroll — and a panel body has no overflow of its own, so the
 * remainder paints straight over the next panel's title.
 *
 * It survived a long time because it does not look like a layout fault. It looks like garbled text:
 * "SPECIFICATIONS" sitting on top of the tool chest's chips. A person found it in a screenshot; the
 * geometry says it plainly, so assert the geometry.
 */
test.describe("side rail layout", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
    // Populate the panels that grow: the bug only appears once the rail is over-subscribed.
    await page.evaluate(async () => {
      await window.viewer.specs?.load();
      for (const y of [200, 400, 600, 800, 1000]) {
        window.viewer.addAnnotation({
          kind: "rect", page: 1, points: [{ x: 100, y }, { x: 300, y: y + 80 }], subject: `Row ${y}`,
        });
      }
    });
  });

  for (const side of ["left", "right"] as const) {
    test(`no panel spills over its neighbour on the ${side}`, async ({ page }) => {
      const report = await page.evaluate((which) => {
        const rail = document.querySelector(`.mpdf-side-${which}`);
        if (!rail) return null;
        const panels = [...rail.querySelectorAll(".mpdf-panel")].map((p) => {
          const body = p.querySelector(".mpdf-panel-body");
          const r = p.getBoundingClientRect();
          return {
            title: p.querySelector(".mpdf-panel-title")?.textContent ?? "?",
            // >0 means content is painting outside its box, over whatever is beneath it.
            spill: body ? body.scrollHeight - body.clientHeight : 0,
            top: r.top, bottom: r.bottom,
          };
        });
        return {
          spilling: panels.filter((p) => p.spill > 1).map((p) => `${p.title} by ${Math.round(p.spill)}px`),
          overlapping: panels.slice(1)
            .map((p, i) => (p.top < panels[i]!.bottom - 1 ? `${panels[i]!.title} / ${p.title}` : null))
            .filter(Boolean),
          count: panels.length,
        };
      }, side);

      expect(report, `no .mpdf-side-${side} rail`).not.toBeNull();
      expect(report!.count).toBeGreaterThan(0);
      expect(report!.spilling).toEqual([]);
      expect(report!.overlapping).toEqual([]);
    });
  }

  test("a long list scrolls inside its panel rather than stretching the rail", async ({ page }) => {
    // The cap is what lets panels stop shrinking without the last one ending up a scroll away.
    const lists = await page.evaluate(() =>
      [...document.querySelectorAll(".mpdf-list")].map((l) => ({
        capped: getComputedStyle(l).maxHeight !== "none",
        overflows: getComputedStyle(l).overflowY,
      })));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((l) => l.capped)).toBe(true);
    expect(lists.every((l) => l.overflows === "auto" || l.overflows === "scroll")).toBe(true);
  });
});
