import { expect, test, type Page } from "@playwright/test";
import { openSample, waitForRender } from "./helpers";

/**
 * What assistive technology actually receives.
 *
 * The rest of `a11y.spec.ts` drives keys and checks that the right thing happened — that focus
 * moved, that Enter acted. It cannot tell you what a screen reader would *say*, and the repo's
 * accessibility statement says so.
 *
 * This closes part of that gap without pretending to be a screen reader. Playwright's ARIA snapshot
 * is the computed accessibility tree — the same role-and-name pairs an AT consumes — so a control
 * that is operable but announces as "button" or as "▭" shows up here and nowhere else. It is still
 * not a substitute for someone listening to it; see docs/accessibility.md.
 */

/** Roles a person navigates by, and which are useless without a name. */
const NEEDS_NAME = new Set([
  "button", "link", "checkbox", "radio", "combobox", "textbox", "searchbox",
  "option", "tab", "menuitem", "slider", "spinbutton", "switch",
]);

interface Node { role: string; name: string | null; line: string }

/** Parse the snapshot's `- role "name": content` lines into role/name pairs. */
function parse(snapshot: string): Node[] {
  const out: Node[] = [];
  for (const line of snapshot.split("\n")) {
    // The optional leading quote is load-bearing: when an accessible name contains a colon, the
    // snapshot wraps the whole node in single quotes — `- 'option "a, b: c" [ref=e1]':`. Without
    // allowing for it, every well-named row silently fails to parse and the test reports zero rows
    // rather than a violation, which reads as a broken list instead of a broken regex.
    const m = /^\s*-\s+'?([a-z][a-z-]*)(?:\s+"([^"]*)")?/.exec(line);
    if (m) out.push({ role: m[1]!, name: m[2] ?? null, line: line.trim() });
  }
  return out;
}

/** Populate the panels so the tree contains rows, not just chrome. */
async function withContent(page: Page): Promise<void> {
  await page.evaluate(() => {
    const subjects = ["Header height", "Slab edge", "Firestop detail"];
    for (const [i, y] of [300, 700, 1100].entries()) {
      window.viewer.addAnnotation({
        kind: "rect", page: 1, points: [{ x: 100, y }, { x: 300, y: y + 80 }],
        subject: subjects[i], status: i === 1 ? "resolved" : "open",
      });
    }
  });
}

test.describe("the accessibility tree", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await waitForRender(page, 1);
    await withContent(page);
  });

  test("every interactive control has an accessible name", async ({ page }) => {
    const nodes = parse(await page.locator(".mpdf-root").ariaSnapshot());
    expect(nodes.length).toBeGreaterThan(40);

    const unnamed = nodes.filter((n) => NEEDS_NAME.has(n.role) && !n.name?.trim());
    // Reported with the offending lines: "some control is unnamed" is not actionable, and the
    // whole point is that the failure names itself.
    expect(unnamed.map((n) => n.line)).toEqual([]);
  });

  test("no control announces as a glyph", async ({ page }) => {
    const nodes = parse(await page.locator(".mpdf-root").ariaSnapshot());

    // The toolbar is font-only by design — every label is a single glyph or emoji. Without an
    // `aria-label` the computed name *is* that glyph, and a screen reader reads it as its Unicode
    // name or as nothing at all. This is the failure that produces a toolbar of "black rectangle".
    const glyphOnly = nodes.filter((n) => {
      const name = n.name?.trim() ?? "";
      if (!NEEDS_NAME.has(n.role) || !name) return false;
      return !/[a-z]{2}/i.test(name);
    });
    expect(glyphOnly.map((n) => n.line)).toEqual([]);
  });

  test("markup rows are told apart by name, not only by position", async ({ page }) => {
    const list = page.locator('[role="listbox"][aria-label="Markups"]');
    const nodes = parse(await list.ariaSnapshot()).filter((n) => n.role === "option");
    expect(nodes).toHaveLength(3);

    const names = nodes.map((n) => n.name ?? "");
    // `aria-label` *overrides* content rather than adding to it, so a constant label silently hides
    // every row's text and leaves three rows announcing identically. That regression happened here.
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name.length).toBeGreaterThan(12);

    // Status is conveyed by a colour swatch visually; it has to be in the name too (WCAG 1.4.1).
    expect(names.some((n) => /resolved/i.test(n))).toBe(true);
  });

  test("the shell exposes named landmarks to navigate by", async ({ page }) => {
    const nodes = parse(await page.locator(".mpdf-root").ariaSnapshot());
    const app = nodes.find((n) => n.role === "application");
    expect(app?.name).toBeTruthy();
    const toolbar = nodes.find((n) => n.role === "toolbar");
    expect(toolbar?.name).toBeTruthy();
  });

  test("the conflict dialog announces as a named dialog", async ({ page }) => {
    await page.evaluate(() => {
      const base = {
        id: "an_c", kind: "cloud" as const, sheetId: "A-201", page: 1,
        points: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 70 }],
        author: "A. Reviewer", createdAt: "2026-07-20T09:00:00.000Z",
        version: 3, status: "open" as const, subject: "Verify header",
      };
      void window.viewer.conflicts!.ask({
        id: "an_c",
        mine: { ...base, note: "Check bearing" },
        theirs: { ...base, note: "Bearing confirmed", author: "B. Engineer" },
      });
    });

    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveCount(1);
    const nodes = parse(await dialog.ariaSnapshot());
    // A modal that reaches the tree as an unnamed group is one a screen-reader user cannot tell
    // they are inside.
    const self = nodes.find((n) => n.role === "dialog");
    expect(self?.name ?? "").toMatch(/changed while you were editing/i);

    await page.keyboard.press("Escape");
  });

  test("live regions are present and exactly one of each urgency", async ({ page }) => {
    // Two polite regions means announcements race and one is lost; none means nothing is announced
    // at all, and both look identical from the outside.
    await expect(page.locator('[aria-live="polite"]')).toHaveCount(1);
    await expect(page.locator('[aria-live="assertive"]')).toHaveCount(1);

    await page.evaluate(() => window.viewer.announce("Page 2 of 3"));
    await expect.poll(() => page.locator('[aria-live="polite"]').textContent(), { timeout: 5_000 })
      .toContain("Page 2 of 3");
  });
});
