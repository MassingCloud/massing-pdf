# Roadmap

Measured against `massing_pdf_viewer_spec.md`. The point of this page is to be honest about the gap
between what the spec asks for and what exists, rather than to imply the spec is met.

## Built

| Spec area | State |
|---|---|
| §3 Navigation and viewing | Continuous scroll, tiled zoom, rotation, fit modes, thumbnails, sheet index, saved views, split pane, pinch-zoom and touch drawing. **No** multi-tab review sessions. |
| §4 Markup system | 22 kinds including revision clouds, stamps, measurements, glyph-anchored text markup, photo/file attachments, and voice notes. |
| §5 Structured markup data | Complete — every field in the spec's list, plus provenance. |
| §6 Revision survival | Overlay compare, alignment (translation and uniform scale), diff clustering, auto-clouding, slip-sheet migration with a review queue and audit trail. |
| §7 Specifications workspace | CSI section/clause parsing, clause tree, citation, requirement extraction, and drawing→spec callout detection with nearest-callout auto-citation. |
| §8 Issues and tasks | Pins, status, assignee, due date, promote-to-issue, BCF topics and `.bcfzip`. **No** forms or daily reports. |
| §9 Offline-first | IndexedDB working copy, durable outbound queue, optimistic concurrency — every write carries the version it was based on, and a 409 surfaces both sides. **No** conflict-resolution UI. |
| §10 Search | Document-wide search over sheet text, markups and the sheet register, faceted and spatially located. OCR-backed on scans when a provider is configured. |
| §11 Historical mode | Provenance, confidence tags that visibly change how a markup reads, transcription, contrast/invert, tracing overlay. |
| Data model / interchange | JSON, XFDF, BCF topics, `.bcfzip`, CSV, flattened PDF. **No** ICDD packaging. |
| Plugin architecture | Kernel + 17 plugins, stable extension points. |

## Deliberate design decisions

### OCR ships as an interface, not an engine

Two constraints pull opposite ways: the viewer must run fully offline, and it must stay a library
you can drop into an app. Bundling several megabytes of WASM would break the second; requiring a
server would break the first. Picking either would be wrong for half of all consumers.

So `ocrPlugin` owns the rasterisation, the coordinate mapping and the wiring into search, specs and
title-block extraction, and the *recogniser* is supplied by the host. `tesseractProvider()` covers
the offline case via a dynamic import of `tesseract.js` (not a dependency here — install it in the
host); `restOcrProvider()` covers a service. A custom provider is four lines.

The seam is `viewer.pageText(page)`, which returns the PDF's own text layer or recognised text when
there isn't one. Every text consumer goes through it, which is why OCR lights all three up at once.

Sheets are tiled before recognition. This is not an optimisation: recognition needs ~18–20 pixels of
character height, 1/8" lettering rasterised as a whole ARCH D sheet gets 9, and the 300 DPI that
gets it to 37 makes a 78 MP image that exceeds mobile canvas limits and every cloud per-image cap.
See [ocr.md](ocr.md) for engine selection — drawings and specs want different ones.

### Compare searches translation and scale, not rotation

Plot origins drift between issues, and a sheet is sometimes re-plotted to another paper size — both
are handled. Rotation is not searched: re-issues are essentially never rotated, and a third
parameter costs more in a brute-force search than it returns. A *skewed scan* is a different problem
that wants phase correlation rather than a wider grid.

### `.bcfzip` carries no viewpoints

A BCF viewpoint requires a 3D camera. A markup on a sheet has a 2D anchor instead, which rides in a
reference link and round-trips. Inventing a camera to satisfy the schema would put a wrong number
in a file other people's software trusts.

## Not built

### ICDD / ISO 21597 packaging (spec Phase 3)

The container standard for linking heterogeneous AEC documents. Wanted eventually; needs the
relationship model settled across Massing first, so building it here in isolation would be guessing.

### 4D/5D and digital twin bridges (spec Phase 3)

`AnnotLinks.ifcGuids` is the hook. Everything above it depends on Massing's coordination surfaces.

### Forms, daily reports, constraint logs (spec §8)

Pins and issues are done; the wider field-reporting surfaces are a host concern with their own data
model, and would be a plugin rather than core work.

### Multi-tab review sessions (spec §3)

Split view covers side-by-side comparison. Independent tabbed sessions are a host-shell concern —
the viewer is already instantiable more than once on a page.

## Known limitations

- **The text layer is disabled when the view is rotated.** Its spans are positioned in unrotated
  page space, so a rotated view would offer selections that land in the wrong place. Hiding it is
  the honest failure; making it follow the rotation is the fix.
- **Spec parsing is heuristic.** It handles the common CSI three-part format well and will mis-parse
  offices that deviate. There is no manual-correction path yet — a section it misses is invisible
  rather than editable.
- **Word boxes are apportioned by character count**, so a search hit's highlight in a proportional
  font can be off by a character's width. Fine for finding things; not precise enough to derive
  geometry from.
- **The ZIP writer stores, it does not deflate.** Correct and universally readable, and BCF payloads
  are small XML plus already-compressed PNGs — but it is not a general-purpose archiver, and it has
  no ZIP64, so it is capped at 4 GB and 65 535 entries.
- **The split pane is read-only.** Two editable panes over one store raises questions about which
  pane owns a gesture that aren't worth answering for a comparison surface.
- **No virtualisation in the markup list or search results.** Both cap at a few hundred rows.
- **Prompts default to `window.prompt`.** Every plugin taking user text accepts a `promptText`
  override, and a host should pass one — the default exists so the library works standalone.

## Testing

Two suites, split by what each can actually reach.

**226 unit tests** (`npm test`) cover the pure logic: geometry and measurement, unit parsing and
formatting, store mutation/undo/merge semantics, every interchange round trip, spec parsing and
reference matching, text splitting, search matching, migration planning, OCR coordinate mapping,
OCR tile planning and overlap de-duplication, optimistic-concurrency wiring, and the ZIP writer — the last verified by reading
its own central directory back rather than by trusting the bytes.

**113 browser tests** (`npm run test:e2e`) cover what unit tests structurally
cannot. `happy-dom` has no layout, and pdf.js schedules its render continuation on
`requestAnimationFrame`, which never fires without a compositor — so in a headless DOM every render
simply hangs. These assert on real pixels and real pointer events:

| Suite | Covers |
|---|---|
| `render.spec.ts` | rasterisation, tiling above the per-canvas budget, tile eviction, thumbnails, fit modes, rotation, zoom-about-cursor |
| `gestures.spec.ts` | drag / poly / freehand / click tools, selection, move, vertex editing, undo coarseness, shortcuts, measurement, text selection |
| `compare.spec.ts` | rasterise → align → difference → cluster → cloud, and migration planning over a real diff |
| `persistence.spec.ts` | IndexedDB round-trip and isolation, survival across a reload, and the offline queue holding a markup through a network failure and draining on retry |
| `touch.spec.ts` | pinch-zoom and its clamps, anchor stability, two-finger pan not drawing, one-finger drawing, and a gesture the browser cancels mid-way |
| `persistence` (unit) | the save queue, and what a rejected batch does to it: requeue on failure, conflict settling by policy, and a bodyless 409 |
| `pen.spec.ts` | stylus drawing, pressure samples reaching the record, a palm rejected mid-stroke, touch recovering after the pen is put down, and a pen landing mid-pinch |

Each runs on Chromium, WebKit and Firefox — canvas size limits, pointer and touch dispatch and
IndexedDB semantics are exactly where engines disagree. Touch and pen run under a separate Chromium
project with `hasTouch` enabled, since CDP touch state is per-session.

The fixture is the demo's generated sample, which makes assertions checkable against the drawing
rather than against the implementation: the plan is drawn at `1/8" = 1'-0"` with a `144'-0"` overall
dimension printed on it, so the measurement test drags that span with real mouse events and expects
the number on the sheet.

Both suites run in CI. The browser job pins Node 22 — Playwright registers an ESM loader that needs
Node 20.6+, and 22 avoids the edge entirely.

### Still uncovered

- **OCR rasterisation end to end.** The coordinate mapping and the kernel fallback are tested; the
  rasterise-and-recognise round trip needs a provider, and bundling one purely for tests would
  contradict the reason it is an interface.
- **Tilt and barrel-rotation.** Pressure is captured and palm rejection works; tilt is read from the
  pointer event but nothing consumes it yet, and no renderer varies stroke width along a stroke.
- **Conflict-resolution UI.** The client detects a 409, carries both sides of every conflicted
  markup and resolves by policy (`theirs` by default). Presenting the two versions and letting a
  reviewer choose is a host concern this library only supplies the data for.
