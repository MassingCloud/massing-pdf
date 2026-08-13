import { expect, test, type Page } from "@playwright/test";
import { openSample, waitForRender } from "./helpers";

/**
 * Correcting the spec parser through the panel.
 *
 * `test/specs.test.ts` covers what a correction *means* — the pure parser, and the plugin's
 * bookkeeping around it. What it cannot cover is whether a person can actually reach the thing: the
 * panel builds its rows from the cached lines, matches them against the current parse by position,
 * and writes back through a `<select>`. All of that is DOM, and none of it is exercised by a unit
 * test.
 *
 * The sample's third page is a CSI spec section, so this drives the real parse of a real document.
 */

const SPEC_PAGE = 3;
const HEADING = "SECTION 07 84 00 - FIRESTOPPING";

/**
 * Open the specs panel on its "Fix parsing" tab, showing the spec page.
 *
 * Scrolls rather than calling `goToPage`. The current page is *derived* from scroll position —
 * `updateVisible` picks whichever page has the most viewport overlap and overrides `_page` — so
 * `goToPage(3)` sets it, the scroll settles, and it drifts straight back to whatever is actually on
 * screen. Putting page 3 in the viewport is the thing that makes page 3 current.
 */
async function openInspector(page: Page): Promise<void> {
  await page.evaluate(() => window.viewer.specs!.load());
  await page.getByRole("button", { name: "Fix parsing", exact: true }).click();
  // Zoom until the spec page is taller than the viewport before scrolling to it.
  //
  // The current page is whichever has the most viewport *overlap in pixels*, and the sample's spec
  // page is both the last page and much shorter than the drawing sheets (310px against 677px at
  // fit-width). Since scrollTop clamps at the end of the document, page 2 still occupies more of an
  // 899px viewport than page 3 can — so at fit-width page 3 can never become current, however you
  // scroll. That is a real defect in `updateVisible`, recorded in docs/roadmap.md; this works
  // around it so the test measures the panel rather than that bug.
  await page.evaluate(async (n) => {
    const s = window.viewer.el.scroll;
    for (let i = 0; i < 8; i++) {
      const wrap = document.querySelector<HTMLElement>(`.mpdf-page-wrap[data-page="${n}"]`);
      if (wrap && wrap.offsetHeight > s.clientHeight * 1.2) break;
      await window.viewer.setZoom(window.viewer.zoom * 1.5);
    }
    const wrap = document.querySelector<HTMLElement>(`.mpdf-page-wrap[data-page="${n}"]`);
    if (wrap) s.scrollTop = wrap.offsetTop + wrap.offsetHeight / 2 - s.clientHeight / 2;
  }, SPEC_PAGE);
  // Auto-retries, and the panel re-renders on `page:changed`, so this settles with the scroll.
  await expect(page.locator(".mpdf-spec-list .mpdf-empty")).toContainText(`Page ${SPEC_PAGE}:`);
}

/** The dropdown on the row whose text is exactly `text`. */
const rowSelect = (page: Page, text: string) =>
  page.locator(".mpdf-spec-line", { has: page.locator(`.mpdf-spec-line-text:text-is("${text}")`) })
    .locator("select");

const sectionCount = (page: Page) =>
  page.evaluate(() => window.viewer.specs!.sections().length);

test.describe("spec parser correction", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
  });

  test("shows what the parser made of every line on the page", async ({ page }) => {
    await openInspector(page);

    const rows = page.locator(".mpdf-spec-line");
    expect(await rows.count()).toBeGreaterThan(5);

    // The badge is the parse result, so the heading reads as a section and prose reads as nothing.
    const headingRow = page.locator(".mpdf-spec-line", {
      has: page.locator(`.mpdf-spec-line-text:text-is("${HEADING}")`),
    });
    await expect(headingRow.locator(".mpdf-spec-ref")).toHaveText("§ 07 84 00");
    await expect(page.locator(".mpdf-spec-line", {
      has: page.locator('.mpdf-spec-line-text:text-is("PART 1 - GENERAL")'),
    }).locator(".mpdf-spec-ref")).toHaveText("PART 1");
  });

  test("demoting the heading empties the register, and Auto brings it back", async ({ page }) => {
    await openInspector(page);
    expect(await sectionCount(page)).toBe(1);

    // This is the case that makes a wrong parse a dead end rather than a nuisance: no heading, no
    // way to navigate to the section at all.
    await rowSelect(page, HEADING).selectOption("none");
    await expect.poll(() => sectionCount(page)).toBe(0);

    const row = page.locator(".mpdf-spec-line", {
      has: page.locator(`.mpdf-spec-line-text:text-is("${HEADING}")`),
    });
    await expect(row.locator(".mpdf-spec-ref")).toHaveText("—");
    await expect(row).toHaveAttribute("data-corrected", "true");

    await rowSelect(page, HEADING).selectOption("");
    await expect.poll(() => sectionCount(page)).toBe(1);
    await expect(row.locator(".mpdf-spec-ref")).toHaveText("§ 07 84 00");
    await expect(row).not.toHaveAttribute("data-corrected", "true");
    expect(await page.evaluate(() => window.viewer.specs!.corrections().length)).toBe(0);
  });

  test("reclassifying a line changes its depth in the register", async ({ page }) => {
    await openInspector(page);
    const target = "1.3 QUALITY ASSURANCE";
    const depthOf = (t: string) => page.evaluate((text) =>
      window.viewer.specs!.sections()[0]?.clauses.find((c) => c.text.includes(text))?.depth ?? null,
      t);

    // The heuristics read it as an article. Say it is a paragraph instead.
    expect(await depthOf("QUALITY ASSURANCE")).toBe(1);
    await rowSelect(page, target).selectOption("clause:2");
    await expect.poll(() => depthOf("QUALITY ASSURANCE")).toBe(2);

    await rowSelect(page, target).selectOption("");
    await expect.poll(() => depthOf("QUALITY ASSURANCE")).toBe(1);
    expect(await page.evaluate(() => window.viewer.specs!.corrections().length)).toBe(0);
  });

  test("a section correction needs a CSI number, and says so when it has none", async ({ page }) => {
    await openInspector(page);
    // Read notices off the bus rather than the live region: the polite region also carries page
    // announcements, so asserting on its text is a race against whatever spoke last.
    await page.evaluate(() => {
      (window as unknown as { notices: string[] }).notices = [];
      window.viewer.on("notice", (n: { message: string }) =>
        (window as unknown as { notices: string[] }).notices.push(n.message));
      window.prompt = () => null;
    });

    const before = await sectionCount(page);
    // A line with no readable six-digit number: inventing one would put an entry in the register
    // that no drawing can ever cite, so it must refuse rather than guess.
    await rowSelect(page, "PART 1 - GENERAL").selectOption("section");

    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { notices: string[] }).notices.join(" | "))).toMatch(/CSI number/i);
    expect(await sectionCount(page)).toBe(before);
    expect(await page.evaluate(() => window.viewer.specs!.corrections().length)).toBe(0);
  });

  test("a supplied number is normalised and creates the section", async ({ page }) => {
    await openInspector(page);
    await page.evaluate(() => { window.prompt = () => "079999"; });

    await rowSelect(page, "PART 1 - GENERAL").selectOption("section");
    await expect.poll(() => page.evaluate(() =>
      window.viewer.specs!.sections().map((s) => s.number))).toContain("07 99 99");
  });
});
