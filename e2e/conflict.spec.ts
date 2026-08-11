import { expect, test, type Page } from "@playwright/test";
import { openSample, waitForRender } from "./helpers";

/**
 * The conflict dialog, in a real engine.
 *
 * `test/conflict-dialog.test.ts` covers the decisions — which fields show, what every ambiguous exit
 * resolves to. What happy-dom cannot answer is whether it is *operable*: it has no layout, no native
 * tab order, and `offsetParent` is `undefined` there, so the visibility filter `trapFocus` uses is
 * never actually exercised. A modal that keeps focus in a fake DOM and leaks it in Chromium is the
 * exact failure this is for.
 *
 * Driven through `conflictsPlugin`, which the demo installs and wires into its persistence options —
 * so this also checks that the documented wiring is the wiring that runs.
 */

/** Open the dialog on a synthetic conflict and return once it is on screen. */
async function openDialog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const base = {
      id: "an_conflict", kind: "cloud" as const, sheetId: "A-201", page: 1,
      points: [{ x: 100, y: 900 }, { x: 300, y: 900 }, { x: 300, y: 1000 }],
      author: "A. Reviewer", createdAt: "2026-07-20T09:00:00.000Z",
      version: 3, status: "open" as const, subject: "Verify header",
    };
    // Kept on the window so the test can assert what the reviewer's answer resolved to.
    (window as unknown as { conflictAnswer?: Promise<unknown> }).conflictAnswer =
      window.viewer.conflicts!.ask({
        id: "an_conflict",
        mine: { ...base, note: "Check bearing" },
        theirs: { ...base, note: "Bearing confirmed", status: "resolved", author: "B. Engineer" },
      });
  });
  await expect(page.locator(".mpdf-conflict")).toBeVisible();
}

const answer = (page: Page) => page.evaluate(async () => {
  const kept = await (window as unknown as { conflictAnswer: Promise<{ note?: string } | null> }).conflictAnswer;
  return kept ? kept.note ?? null : "KEPT_THEIRS";
});

test.describe("conflict dialog", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
  });

  test("shows both versions and only the fields that differ", async ({ page }) => {
    await openDialog(page);
    const dialog = page.locator(".mpdf-conflict");

    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toContainText("Check bearing");
    await expect(dialog).toContainText("Bearing confirmed");
    // Subject matches on both sides, so it is not a decision and does not belong in the table.
    await expect(dialog).not.toContainText("Verify header");
    // No directory configured, so the author falls back to the name on the record.
    await expect(dialog).toContainText("B. Engineer");

    await page.keyboard.press("Escape");
  });

  test("opens focused on the choice that destroys nothing", async ({ page }) => {
    await openDialog(page);

    // Kept as its own test: bundled with the focus-trap assertions, a failure here is
    // indistinguishable from the trap leaking, and they have different causes and different fixes.
    await expect(page.getByRole("button", { name: /keep their version/i })).toBeFocused();

    await page.keyboard.press("Escape");
  });

  test("Tab cannot reach the sheet behind the dialog", async ({ page }) => {
    await openDialog(page);

    // Assert the invariant, not the arithmetic. `trapFocus` redirects only at the two boundaries and
    // lets the browser handle the middle, so with two buttons the cycle has period two and "focus is
    // back on the first after N presses" tests whether N is even. What `aria-modal` actually
    // promises is that nothing behind the modal is reachable.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() =>
        Boolean(document.activeElement?.closest(".mpdf-conflict")));
      expect(inside, `focus escaped the dialog after ${i + 1} Tab press(es)`).toBe(true);
    }

    // The boundaries specifically: forward off the last control wraps to the first, and back off
    // the first wraps to the last. Those are the two branches the trap actually implements.
    await page.getByRole("button", { name: /keep my change/i }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /keep their version/i })).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: /keep my change/i })).toBeFocused();

    await page.keyboard.press("Escape");
  });

  test("Enter on the default answer keeps theirs", async ({ page }) => {
    await openDialog(page);
    await page.keyboard.press("Enter");
    await expect(page.locator(".mpdf-conflict")).toHaveCount(0);
    expect(await answer(page)).toBe("KEPT_THEIRS");
  });

  test("Escape dismisses without overwriting a colleague", async ({ page }) => {
    await openDialog(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".mpdf-conflict")).toHaveCount(0);
    expect(await answer(page)).toBe("KEPT_THEIRS");
  });

  test("choosing mine returns the local record", async ({ page }) => {
    await openDialog(page);
    await page.getByRole("button", { name: /keep my change/i }).click();
    await expect(page.locator(".mpdf-conflict")).toHaveCount(0);
    expect(await answer(page)).toBe("Check bearing");
  });

  test("covers the sheet rather than the whole page", async ({ page }) => {
    await openDialog(page);

    // Scoped to `.mpdf-root`, so a host embedding the viewer in a panel gets the dialog over the
    // drawing and not over their own application chrome.
    const inside = await page.evaluate(() => {
      const backdrop = document.querySelector(".mpdf-conflict-backdrop")!;
      const root = document.querySelector(".mpdf-root")!;
      const b = backdrop.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      return b.width > 0 && b.height > 0
        && b.left >= r.left - 1 && b.right <= r.right + 1
        && b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
    });
    expect(inside).toBe(true);

    await page.keyboard.press("Escape");
  });
});
