import { expect, test, type Page } from "@playwright/test";
import { openSample, waitForRender } from "./helpers";

/**
 * Presence and advisory locking, in a browser.
 *
 * `test/collab.test.ts` covers the rules. What it cannot cover is the half that only exists in the
 * DOM: the overlay is torn down and rebuilt on every repaint, so a lock badge painted onto it is
 * destroyed each time and has to be re-applied. That is the failure this is for — decoration that
 * works once and vanishes the next time anyone scrolls.
 */

/** Join the demo's room as a second person and take a lock, as a colleague's tab would. */
async function colleagueTakes(page: Page, annotId: string, name = "Ben"): Promise<void> {
  await page.evaluate(async ({ annotId, name }) => {
    const { MemoryPresenceChannel } = await import("/src/index.ts");
    const session = await new MemoryPresenceChannel().join(
      { documentId: window.viewer.doc!.fingerprint },
      { id: "u-other", name },
    );
    (window as unknown as { colleague: unknown }).colleague = session;
    await session.acquire(annotId);
  }, { annotId, name });
}

const addMarkup = (page: Page) => page.evaluate(() => window.viewer.addAnnotation({
  kind: "rect", page: 1, points: [{ x: 100, y: 900 }, { x: 300, y: 980 }], subject: "Header detail",
})!.id);

test.describe("live co-markup", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
  });

  test("lists who is in the document", async ({ page }) => {
    await expect(page.locator(".mpdf-collab-person")).toHaveCount(1);
    await expect(page.locator(".mpdf-collab-person")).toContainText("(you)");

    await page.evaluate(async () => {
      const { MemoryPresenceChannel } = await import("/src/index.ts");
      await new MemoryPresenceChannel().join(
        { documentId: window.viewer.doc!.fingerprint },
        { id: "u-other", name: "Ben" },
      );
    });
    await expect(page.locator(".mpdf-collab-person")).toHaveCount(2);
    await expect(page.locator(".mpdf-collab")).toContainText("Ben");
  });

  test("marks a markup a colleague is holding, and keeps it marked across repaints", async ({ page }) => {
    const id = await addMarkup(page);
    await colleagueTakes(page, id);

    const marked = page.locator(`.mpdf-overlay [data-annot="${id}"].is-locked-by-other`);
    await expect(marked).toHaveCount(1);
    await expect(marked).toHaveAttribute("aria-label", /Being edited by Ben/);

    // The overlay is rebuilt from scratch on every repaint. Decoration applied once and never
    // re-applied would disappear here, which is the whole reason `overlay:painted` exists.
    await page.evaluate(() => window.viewer.redraw());
    await expect(marked).toHaveCount(1);
    await page.evaluate(() => window.viewer.setZoom(window.viewer.zoom * 1.3));
    await expect(marked).toHaveCount(1);
  });

  test("selecting a markup takes a lease, deselecting gives it back", async ({ page }) => {
    const id = await addMarkup(page);

    await page.evaluate((annotId) => window.viewer.store.select(annotId), id);
    await expect.poll(() => page.evaluate(() => window.viewer.collab!.held()), { timeout: 5_000 })
      .toEqual([id]);

    await page.evaluate(() => window.viewer.store.select(null));
    await expect.poll(() => page.evaluate(() => window.viewer.collab!.held())).toEqual([]);
  });

  test("a lock never reaches the annotation record", async ({ page }) => {
    const id = await addMarkup(page);
    await colleagueTakes(page, id);
    await expect(page.locator(`[data-annot="${id}"].is-locked-by-other`)).toHaveCount(1);

    // Anything on the record takes a version and rides the persistence queue to storage and to
    // every other client. A lock is session state and must not.
    const record = await page.evaluate((annotId) => {
      const a = window.viewer.store.get(annotId)!;
      return { locked: a.locked ?? null, version: a.version };
    }, id);
    expect(record.locked).toBeNull();
    expect(record.version).toBe(1);
  });

  test("a colleague's lock is advisory — the markup is still editable", async ({ page }) => {
    const id = await addMarkup(page);
    await colleagueTakes(page, id);
    await expect(page.locator(`[data-annot="${id}"].is-locked-by-other`)).toHaveCount(1);

    // A stale lease must never strand a markup. The version check remains the authority, and a
    // real collision still lands in the conflict dialog.
    const edited = await page.evaluate((annotId) =>
      Boolean(window.viewer.store.update(annotId, { subject: "edited anyway" })), id);
    expect(edited).toBe(true);
  });

  test("the mark clears when the colleague lets go", async ({ page }) => {
    const id = await addMarkup(page);
    await colleagueTakes(page, id);
    await expect(page.locator(`[data-annot="${id}"].is-locked-by-other`)).toHaveCount(1);

    await page.evaluate((annotId) => {
      (window as unknown as { colleague: { release(id: string): void } }).colleague.release(annotId);
    }, id);
    await expect(page.locator(`[data-annot="${id}"].is-locked-by-other`)).toHaveCount(0);
  });
});
