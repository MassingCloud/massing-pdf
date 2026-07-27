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
- TypeScript 5.9 (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Vite 6, Vitest 3.
- Peers: `pdfjs-dist` ^6 (rendering, text), `pdf-lib` ^1.17 (flatten export, optional).
- Versions deliberately match Massing's `apps/web` so reintegration doesn't duplicate deps.

## Layout
```
src/core/      viewer (kernel) · document · renderer · textLayer · store · events · plugin
               coords · geometry · units · filter · types
src/render/    svg.ts — Annotation → SVG, page space
src/plugins/   markup · measure · stamps · pins · markupList · search · specs · compare
               migration · sheets · historical · attachments · ocr · views · toolbar
               persistence · exporters
src/adapters/  memory · indexeddb · rest · offline
src/io/        xfdf · bcf · csv · flatten · zip
demo/          standalone app; generates its own 3-page sample (plan, details, CSI spec section)
test/          206 unit tests (vitest)
e2e/           58 browser tests (playwright) — rendering, gestures, touch, compare, adapters
```

## Commands
```
npm run dev        demo at :5173
npm test           vitest
npm run check      typecheck + lint + unit tests
npm run test:e2e   playwright (needs Node 20.6+; this machine's 20.3.1 is too old)
npm run check:all  check + e2e
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
- **All text reads through `viewer.pageText(page)`**, never `doc.textItems` directly. That seam is
  what lets OCR serve a scanned page to search, specs and title-block extraction at once.
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
