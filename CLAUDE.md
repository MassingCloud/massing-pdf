# Project: massing-pdf

## What this is
A standalone construction drawing review engine — PDF viewing, AEC markup, calibrated takeoff, issue
pins, revision compare, XFDF/BCF interchange — behind a small plugin kernel. Extracted from
[ibuilder/massing](https://github.com/ibuilder/massing)'s `pdfTakeoff.ts` and rebuilt to be consumed
back by it as `@massingcloud/pdf-viewer`.

Framework-agnostic, vanilla DOM + TypeScript. No React/Vue — Massing's web app is vanilla TS, and a
framework here would force one on every consumer.

## Non-negotiables
- **A markup is a record, not ink.** Rendering is one projection; XFDF, BCF, CSV and a flattened PDF
  are others. Never store presentation-only state that can't round-trip.
- **All geometry in page space**: PDF points, top-left origin, unrotated. Zoom and rotation are view
  concerns and never rewrite a stored point.
- **The viewer runs fully offline.** The pdf.js worker is bundled by the host, never a CDN.
- **Reference model elements by IFC GlobalId**, never by transient viewer ids.
- **Pins follow the BCF model** so issues round-trip with other BIM tools.
- **Permissive licences only** — Apache-2.0/MIT. No AGPL (this is why there's no PyMuPDF equivalent).
- **Plugins never import each other.** They meet at the event bus and the registries.
- **Never await rasterisation.** pdf.js drives its render loop from `requestAnimationFrame`, which
  stops in a background tab; awaiting pixels makes `load()` hang until the tab is foregrounded.

## Stack
- TypeScript 6 (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Vite 8, Vitest 4.
- Peers: `pdfjs-dist` ^6 (rendering, text), `pdf-lib` ^1.17 (flatten export, optional).
- Versions deliberately match Massing's `apps/web` so reintegration doesn't duplicate deps.

## Layout
```
src/core/      viewer (kernel) · document · renderer · textLayer · store · events · plugin
               coords · geometry · units · filter · types · policy · a11y · url
src/render/    svg.ts — Annotation → SVG, page space
src/plugins/   markup · measure · stamps · pins · markupList · search · specs · compare
               migration · sheets · historical · attachments · ocr · views · toolbar
               persistence · exporters
src/adapters/  memory · indexeddb · rest · offline
src/io/        xfdf · bcf · csv · flatten · zip
demo/          standalone app; generates its own 3-page sample (plan, details, CSI spec section)
scripts/       check-package.mjs — manifest entry points resolve to built files
               check-licences.mjs — no copyleft anywhere in the installed tree
test/          381 unit tests (vitest)
e2e/           browser tests (playwright) — rendering, gestures, touch, pen, compare, adapters,
               keyboard/ARIA (a11y.spec.ts), strict-CSP (csp.spec.ts, against the *built* demo)
               runs on chromium, chromium-touch, webkit, firefox, csp
```

## Commands
```
npm run dev        demo at :5173
npm test           vitest
npm run check      typecheck + lint + unit tests
npm run test:e2e   playwright (needs Node 20.6+; this machine's 20.3.1 is too old)
npm run check:all  check + e2e
npm run check:package  manifest entry points resolve (run after build)
npm run check:licences no copyleft in the tree (--list for the breakdown)
npm run build      library → dist/
npm run demo:build standalone demo → dist-demo/
```

## Watch out for
- **Adding a markup kind touches five places**: `AnnotKind`, a tool, `render/svg.ts`,
  `io/flatten.ts`, `io/xfdf.ts`. Miss the last two and the markup looks right on screen and vanishes
  on export.
- **`Quantity.raw`** is the pre-calibration magnitude in page units. It's what lets a re-calibration
  re-derive every measurement on the page. Don't drop it.
- **XFDF is bottom-left origin and 0-based pages.** The flip needs the page height.
- **DOM implementations disagree on namespace prefixes.** `localName` may be `record` or
  `massing:record`; the XFDF importer takes the segment after the last colon. `happy-dom` also wraps
  parsed XML in an implicit `<html>`, so don't validate by `documentElement`.
- **Editing source while the demo is open triggers Vite HMR**, which resets viewer state mid-test.
  Reload before browser-driven verification, and don't edit files during a run.
- **The browser pane must be visible for rasterisation to work.** Hidden ⇒ no `requestAnimationFrame`
  ⇒ pdf.js renders never settle. Everything else (markup, measurement, text selection, spec parsing,
  search, export) is testable in a hidden pane, because none of it needs pixels.
- **Spec-language regexes must match stems, not whole words.** `\bqualif\b` matches nothing;
  "Qualifications" needs `\bqualif\w*`. This silently empties the requirements checklist.
- **A point markup has zero area.** Any code computing an overlap *ratio* against one divides by
  zero-ish and waves it through — check containment instead (see `changeOverlap` in migration).
- **There is no default OCR engine, deliberately.** The library ships no recognition code and names
  no engine in `peerDependencies`; adapters load through a dynamic import behind an optional
  dependency, so `dist/massing-pdf.js` is the same size either way. Adding a blessed default — or a
  convenience like `localOcrProvider()` that hardcodes one — puts the choice back in the library,
  which is the thing the host is supposed to own. `e2e/ocr-bench.spec.ts` exists to inform that
  choice with measurements rather than replace it with an opinion.
- **All text reads through `viewer.pageText(page)`**, never `doc.textItems` directly. That seam is
  what lets OCR serve a scanned page to search, specs and title-block extraction at once.
- **A test that samples "did it render" must sample where the drawing is.** The sample sheet is
  mostly white; the plan sits around page-space y 684–1548. Sampling the first few tiles at high
  zoom reads pure margin, which looks exactly like a renderer that failed — it cost a wrong
  "WebKit is broken" diagnosis. `e2e/helpers.ts` exports `INKED_POINT` for this.
- **Restore lands after `doc:loaded`, not with it.** `persistence` replaces the whole store when the
  adapter resolves, so anything writing markups on open must wait for `markups:restored` or watch
  its work vanish.
- **Firefox will not launch on this machine** (`spawn UNKNOWN`, a Windows environment issue, not a
  code one). It runs in CI on Linux. Locally, verify with
  `--project=chromium --project=chromium-touch --project=webkit`.
- **A markup is untrusted input.** Records arrive from the server, from XFDF/BCF imports and from
  other users. Text goes in with `textContent`, never `innerHTML`; any URL reaching `window.open`
  or a `src` goes through `core/url.ts` first. A record carrying `javascript:` in an attachment URL
  was a live stored-XSS until that was added.
- **Permissions live in the store, not the toolbar.** `core/policy.ts` gates `add`/`update`/
  `remove`/`setCalibration`/`setSheet`, because a check in the UI is bypassed by a host script, an
  import or an adapter. `store.add()` returns `undefined` when refused — callers must handle it;
  `viewer.addAnnotation()` throws instead, being the host-facing entry point.
- **Any clickable element must go through `activate()`** from `core/a11y.ts`. A `div` with an
  `onclick` is unreachable by keyboard and silent to a screen reader, and it is the default thing to
  write. `e2e/a11y.spec.ts` drives real keys and will catch it.
- **A killed Playwright run leaves its dev server behind, and the next run reuses it.**
  `reuseExistingServer: !CI` means whatever is listening on 5173 wins — so after a run is
  interrupted, the next one silently tests the *previous* dependency set. It presents as ~130
  `waitForFunction` timeouts on `window.viewer?.bus`, which looks exactly like a broken upgrade and
  is not. It produced two wrong verdicts here, one of them nearly recorded as fact about Vite 8.
  Kill port 5173 and 4173 before re-running after any dependency change, and prefer running the
  suite detached so it is never killed part-way.
- **`tsconfig.json` has no `baseUrl`, deliberately.** TypeScript 6 deprecates it, and `paths` has
  resolved relative to the config file since TS 5 — the `/src/*` and `/e2e/*` mappings that let the
  e2e suite typecheck its `page.evaluate` imports work without it.
- **Bash heredocs here collapse doubled backslashes**, so a scripted edit meant to write a regex
  word-boundary or a newline escape into source lands a literal control character instead — and the
  regex then silently matches nothing. Prefer the Edit tool for anything containing backslashes; if
  scripting, build them with `chr(92)`. Two such characters reached a commit before this was caught;
  a tree scan for the C0 control range finds them.

## Local environment notes (this machine)
- Repo root: `C:\Server\massingpdf` (Windows / PowerShell).
- node v18.8.0 locally; `engines` allows ≥18.18 and CI runs 20 and 22. Some transitive deps warn
  EBADENGINE on 18 but install and run fine.
- `_src/` is a throwaway clone of `ibuilder/massing` used as an extraction reference. Gitignored.
