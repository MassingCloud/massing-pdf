import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeMediaUrl, safeNavigableUrl } from "../src/core/url";

/**
 * Untrusted values that reach a browser API.
 *
 * An attachment URL is not authored by the person looking at it: markups arrive from the server,
 * from an imported file, or from a colleague's device. Anything that ends up in `window.open` or a
 * `src` has to be vetted rather than trusted.
 */

/** Splice a control character into the middle of a scheme, the way a filter-evasion payload does. */
const spliced = (code: number) => `java${String.fromCharCode(code)}script:alert(1)`;

const NAVIGATION_ATTACKS = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "  javascript:alert(1)",
  spliced(0x0a),            // newline
  spliced(0x09),            // tab
  spliced(0x0d),            // carriage return
  spliced(0x00),            // NUL
  "java script:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "data:image/svg+xml,<svg onload='alert(1)' xmlns='http://www.w3.org/2000/svg'/>",
  "file:///etc/passwd",
  "about:blank",
  "chrome://settings",
  "filesystem:https://evil.test/temporary/x",
];

describe("attachment URLs are vetted before they are opened", () => {
  it.each(NAVIGATION_ATTACKS)("refuses to navigate to %j", (url) => {
    expect(safeNavigableUrl(url)).toBeNull();
  });

  it.each(NAVIGATION_ATTACKS)("refuses to load %j as media", (url) => {
    expect(safeMediaUrl(url)).toBeNull();
  });

  it("still allows the schemes a real attachment uses", () => {
    expect(safeNavigableUrl("https://files.example.com/a.pdf")).toBe("https://files.example.com/a.pdf");
    expect(safeNavigableUrl("http://intranet/a.pdf")).toBe("http://intranet/a.pdf");
    expect(safeNavigableUrl("blob:https://app.example.com/1234")).toBe("blob:https://app.example.com/1234");
  });

  it("allows an inline photo, which is how an offline attachment is stored", () => {
    // With no upload handler configured the plugin falls back to a data URL, so refusing every
    // data: URL outright would break attaching a site photo on a tablet with no signal.
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(safeMediaUrl(png)).toBe(png);
    expect(safeMediaUrl("data:audio/webm;base64,GkXf")).toBe("data:audio/webm;base64,GkXf");
  });

  it("does not open a data URL as a document even when the type looks inert", () => {
    // A document context runs script; type sniffing is not a defence worth relying on there.
    expect(safeNavigableUrl("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
  });

  it("treats a missing URL as nothing to do", () => {
    expect(safeMediaUrl(undefined)).toBeNull();
    expect(safeNavigableUrl("")).toBeNull();
  });
});

/**
 * A tree scan for stray C0 control characters.
 *
 * Two of these have reached a commit: a scripted edit meant to write an escape sequence into a
 * regex wrote the raw byte instead, and the regex then silently matched nothing. It is invisible in
 * review and in a diff, so it needs a test rather than vigilance.
 */
describe("source contains no raw control characters", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|js|mjs)$/.test(entry)) files.push(path);
    }
  };
  for (const root of ["src", "test", "e2e", "demo", "scripts"]) walk(root);

  it("scans a plausible number of files", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files)("%s", (file) => {
    const text = readFileSync(file, "utf8");
    const offender = [...text].findIndex((c) => c.charCodeAt(0) < 32 && !"\n\r\t".includes(c));
    // Reported with its position, because the character is invisible in the editor.
    expect(offender === -1 ? "clean" : `control character at index ${offender}`).toBe("clean");
  });
});
