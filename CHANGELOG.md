# Changelog

Notable changes to `@massingcloud/pdf-viewer`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[docs/versioning.md](docs/versioning.md), which sets out what semver covers here and what it does
not.

## [Unreleased]

Nothing yet.

## [0.1.0] — unreleased

First release. Not yet published to npm — the `@massingcloud` scope has to be claimed first, see
[docs/publishing.md](docs/publishing.md).

Extracted from [ibuilder/massing](https://github.com/ibuilder/massing)'s `pdfTakeoff.ts` and rebuilt
behind a plugin kernel, to be consumed back by it.

### Viewing

- Tiled rasterisation with per-canvas size budgets, so an ARCH D sheet at high zoom does not exceed
  the limits at which a browser silently yields a blank canvas.
- Rasterisation is never awaited: pdf.js drives its render loop from `requestAnimationFrame`, which
  stops in a background tab, so awaiting pixels would hang `load()` until the tab was foregrounded.
- Zoom about the cursor, rotation, fit modes, a selectable text layer, and raster eviction for pages
  scrolled well out of view.
- Touch and pen: pinch-zoom, two-finger reposition mid-markup, stylus pressure captured onto the
  record, and palm rejection keyed to pointer identity rather than elapsed time.

### Markup and takeoff

- Structured annotation records — a markup is a record, not ink. Rendering is one projection; XFDF,
  BCF, CSV and a flattened PDF are others.
- All geometry in page space (PDF points, top-left origin, unrotated). Zoom and rotation are view
  concerns and never rewrite a stored point.
- Calibrated measurement with `Quantity.raw` preserved, so re-calibrating re-derives every
  measurement on the page rather than invalidating them.
- Issue pins following the BCF model, revision compare with slip-sheet migration, specification
  parsing with reference matching, stamps, attachments and saved views.
- Specification parsing is correctable per line. The "Fix parsing" tab lists what the parser made of
  every line on the page and lets a reviewer overrule it, which matters most for a missed *section
  heading* — a section that was never found cannot be navigated to at all. Corrections are addressed
  by page and line text so they survive a re-parse, and re-parse from held lines rather than
  re-reading the book. `corrections` / `onCorrect` hand persistence to the host.

### Interchange

- XFDF (bottom-left origin, 0-based pages, with a lossless `<massing:record>` payload), BCF topics
  and `.bcfzip`, CSV, and PDF flattening via an optional `pdf-lib` peer.

### Persistence

- Memory, IndexedDB, REST and offline-queue adapters. The REST adapter targets Massing's existing
  markup endpoints and row shape, so no server change is needed to adopt it.
- Optimistic concurrency: every write carries the version it was based on, and a 409 surfaces both
  sides of each conflicted markup rather than a generic failure.
- `conflictsPlugin` presents the two versions for a reviewer to choose between, showing only the
  fields that differ. Every ambiguous exit — Escape, an optional timeout, initial focus — resolves
  to *theirs*, so a dialog dismissed unread never overwrites a colleague's edit. Replaceable: supply
  your own `onConflict` and do not install it.
- `markups:restored` announces when a restore has landed. Restore replaces the whole store and
  arrives well after `doc:loaded`, so anything seeding markups on open needs this or its work is
  silently overwritten.

### Access control and audit

- A capability check enforced in the annotation store — the seam every mutation crosses, so a host
  script, an import or an adapter is gated the same as a toolbar click. A check that throws denies.
- A flat, serialisable audit record for every gated act, refusals included.

### Accessibility

- Every list is a single tab stop with arrow-key navigation, Enter and Space activation, and an
  accessible name carrying what a colour swatch conveys visually. Landmarks, `aria-pressed` on armed
  tools, live-region announcements, `prefers-reduced-motion` and forced-colors support.
- The drawing canvas too, not only the panels. `Alt`+arrow steps through the markups on a sheet in
  reading order and announces the position among them; arrows nudge a selection, aim a drawing
  cursor when a tool is armed, and pan when there is nothing else to do; `Space` places a point and
  `Enter` finishes. Space and Enter are separate keys deliberately — with one doing both, a polygon
  cannot be drawn without a pointer.
- Verified by driving real keys in a real browser. What is **not** covered is stated plainly in
  [docs/accessibility.md](docs/accessibility.md): nothing has been tested with a screen reader, no
  third party has audited it, and placing a markup accurately over linework remains a visual task.

### Security

- Attachment URLs are vetted by `core/url.ts` before reaching `window.open` or a `src`. Markup
  records arrive from the server, from imports and from other users, so a record carrying
  `javascript:` was stored XSS until this was added. Written as an allowlist, because rejecting
  known-bad schemes fails permissive.
- All text enters the DOM with `textContent`, never `innerHTML`.
- Runs under a strict Content-Security-Policy with no `unsafe-eval` and no inline script, verified
  on every CI run against the built demo behind a real policy header.

### OCR

- Provided as an interface, not an engine. The viewer owns tiling, overlap de-duplication and
  page-space mapping; recognition is a host decision. No engine ships, and none is named in
  `peerDependencies` — the built library is the same size either way.
- Reference adapters for Tesseract, PaddleOCR, Azure and Google Vision, plus a fallback chain that
  drops a provider which keeps failing rather than retrying it once per tile of a drawing set.
- `e2e/ocr-bench.spec.ts` measures engines against generated ground truth, to inform that choice
  rather than replace it with an opinion.

### Known limitations

Recorded in [docs/roadmap.md](docs/roadmap.md): the text layer switches off under view rotation,
specification parsing is heuristic (correctable per line, but still heuristic first), the ZIP writer
stores rather than deflates, and BCF viewpoints are omitted because a sheet markup has no 3D camera
and inventing one would put a wrong number into a file other tools trust.

`pdfjs-dist` is tested against the `6.1.x` line. From 6.2, pdf.js requires Node 22+ and raises the
browser floor to Chrome 122+, Firefox 131+ and Safari 18.4+ — see
[docs/browser-support.md](docs/browser-support.md).

[Unreleased]: https://github.com/MassingCloud/massing-pdf/compare/main...HEAD
[0.1.0]: https://github.com/MassingCloud/massing-pdf/releases/tag/v0.1.0
