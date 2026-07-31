import { expect, test } from "@playwright/test";
import type * as MassingPdf from "../src/index";

/**
 * Content-Security-Policy compatibility.
 *
 * Enterprise deployments serve their applications under a strict CSP, and a library that needs
 * `unsafe-eval` or `unsafe-inline` is either excluded outright or forces the host to weaken the
 * policy for its whole application. Grepping the source for `eval` proves nothing about what
 * pdf.js does at runtime with a real font, so this loads the *built* demo under a policy with no
 * escape hatches and watches for violations.
 *
 * Against the built output rather than the dev server: Vite injects an inline HMR script, which
 * would report violations that exist in nothing anyone ships.
 */

/**
 * The policy a host should be able to run this under.
 *
 * No `unsafe-eval`, no `unsafe-inline` for scripts. `blob:` is needed for the pdf.js worker and for
 * object URLs; `data:` for inline attachment previews and generated sample bytes.
 */
const STRICT_CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

test.describe("strict Content-Security-Policy", () => {
  test("renders a drawing with no policy violations", async ({ page }) => {
    const violations: string[] = [];
    const errors: string[] = [];

    // Applied as a real response header, which is how a host would deploy it — a <meta> tag is
    // parsed later and misses violations during initial script evaluation.
    await page.route("**/*", async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers(), "content-security-policy": STRICT_CSP };
      await route.fulfill({ response, headers });
    });

    await page.addInitScript(() => {
      window.addEventListener("securitypolicyviolation", (e) => {
        const violation = e as SecurityPolicyViolationEvent;
        (window as unknown as { __csp: string[] }).__csp ??= [];
        (window as unknown as { __csp: string[] }).__csp.push(
          `${violation.violatedDirective} blocked ${violation.blockedURI}`,
        );
      });
      (window as unknown as { __csp: string[] }).__csp = [];
    });

    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await page.goto("/index.html");
    await page.waitForFunction(() => Boolean(window.viewer?.bus), null, { timeout: 30_000 });
    await page.locator("#sample").click();
    await page.waitForFunction(() => Boolean(window.viewer.doc), null, { timeout: 60_000 });

    // The worker is the part most likely to be blocked, and nothing rasterises without it.
    await expect
      .poll(async () => page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.mpdf-page-wrap[data-page="1"] canvas.mpdf-tile');
        if (!c?.width) return 0;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        const w = Math.min(256, c.width), h = Math.min(256, c.height);
        const data = ctx!.getImageData(Math.floor((c.width - w) / 2), Math.floor((c.height - h) / 2), w, h).data;
        let ink = 0;
        for (let i = 0; i < data.length; i += 28) {
          if (data[i]! < 240 || data[i + 1]! < 240 || data[i + 2]! < 240) ink++;
        }
        return ink;
      }), { timeout: 60_000, message: "nothing rasterised under CSP" })
      .toBeGreaterThan(0);

    violations.push(...await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []));
    expect(violations, `CSP violations:\n${violations.join("\n")}`).toEqual([]);
    // An eval blocked by policy surfaces as a page error rather than a violation event in some
    // engines, so the error channel is checked too.
    expect(errors.filter((e) => /unsafe-eval|Content Security Policy|CSP/i.test(e))).toEqual([]);
  });

  test("markup, measurement and export work under the policy", async ({ page }) => {
    // Rendering surviving is not the whole claim: the interchange path builds blobs and object
    // URLs, which is exactly where a `blob:`-hostile policy would bite.
    await page.route("**/*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": STRICT_CSP } });
    });
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      window.addEventListener("securitypolicyviolation", (e) => {
        (window as unknown as { __csp: string[] }).__csp.push((e as SecurityPolicyViolationEvent).violatedDirective);
      });
    });

    await page.goto("/index.html");
    await page.waitForFunction(() => Boolean(window.viewer?.bus), null, { timeout: 30_000 });
    await page.locator("#sample").click();
    await page.waitForFunction(() => Boolean(window.viewer.doc), null, { timeout: 60_000 });

    const result = await page.evaluate(async () => {
      const v = window.viewer;
      v.addAnnotation({ kind: "rect", page: 1, points: [{ x: 100, y: 100 }, { x: 300, y: 200 }] });
      // From the bundle, not a dynamic source import — this suite runs against the built demo.
      const { toXfdf } = (window as unknown as { massingPdf: typeof MassingPdf }).massingPdf;
      const xml = toXfdf(v.store.all(), { pages: (p: number) => v.doc!.pageInfoSync(p) });
      // The exporters build a Blob and an object URL, which is where a blob:-hostile policy bites.
      const url = URL.createObjectURL(new Blob([xml], { type: "application/vnd.adobe.xfdf" }));
      URL.revokeObjectURL(url);
      return { markups: v.store.size, xfdfLength: xml.length, madeObjectUrl: url.startsWith("blob:") };
    });

    expect(result.markups).toBe(1);
    expect(result.xfdfLength).toBeGreaterThan(100);
    expect(result.madeObjectUrl).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  });
});
