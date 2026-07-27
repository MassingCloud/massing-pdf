import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the real demo in real Chromium.
 *
 * These exist to cover what unit tests structurally cannot: `happy-dom` has no layout, and pdf.js
 * drives its canvas render loop from `requestAnimationFrame`, which never fires in a headless DOM.
 * So rasterisation, the pointer gesture loop, the compare pipeline and the IndexedDB adapters are
 * only verifiable in a browser that actually composites.
 *
 * The demo's generated sample sheet is the fixture: an ARCH D plan drawn at a known scale with its
 * overall dimension printed on it, a details sheet, and a real CSI spec section that the plan's
 * keyed notes call out by number. That makes the assertions checkable against the drawing rather
 * than against the implementation.
 *
 * Plain JS rather than TypeScript on purpose — Playwright loads its config before installing the
 * TS loader, so a `.ts` config fails on Node 20 in an ESM package. The specs themselves are
 * TypeScript and are typechecked by `npm run typecheck`.
 */
export default defineConfig({
  testDir: "./e2e",
  // Rasterising D-size sheets is genuinely slow; the default 30s trips on a cold cache.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Big enough that a D sheet at fit-width still has room for both side panels.
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173/demo/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
