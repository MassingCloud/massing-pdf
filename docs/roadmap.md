# Roadmap

Two halves. **What is planned**, sequenced and argued, and **where it stands** against
`massing_pdf_viewer_spec.md` — the second being honest about the gap rather than implying the spec
is met.

Ordering principle: unblock consumers, then close gaps this repo already documents, then close gaps
the market expects, then speculate. Anything that needs a decision rather than an implementation is
marked as such, because those are not mine to make.

## Now — blocking other people

Neither is code, and both are blocking two consumers.

**Publish to npm.** The `@massingcloud` scope is unclaimed, so `npm i` does not resolve.
MassingViewer lists this as an M0 prerequisite and Massing needs it to drop the local
`pdfTakeoff.ts`. Sequence in [publishing.md](publishing.md).

**Decide the pdf.js line.** Held at `~6.1.200`. Version 6.2 drops Node 20 and lifts the browser
floor to Chrome 122+, Firefox 131+, Safari 18.4+. That is a support-matrix decision affecting both
consumers, not a dependency bump — see [browser-support.md](browser-support.md).

## Next — small, certain, already documented as gaps

Each closes something this repo already admits to, and none is speculative.

**1. Workflow fields into the typed model.** `assignee` and `dueDate` exist only inside `ext` as
untyped strings, fished back out with `typeof x === "string"` guards in `io/bcf.ts`. They round-trip,
so nothing is broken, but the type system cannot see the two fields any issue workflow depends on.
Promote them to `Annotation` alongside `priority`, which is already typed. Small, and a prerequisite
for the next item.

**2. BCF 3.0 output.** The archive currently declares `VersionId="2.1"` while comments in
`io/bcf.ts` claim 2.1/3.0. BCF 3.0 is what adds workflow — priorities, deadlines, assignment — which
is precisely what item 1 makes representable. Emitting 3.0 while still *reading* 2.1 is the
compatible move.

**3. A conflict-resolution reference.** The client detects a 409, carries both sides of every
conflicted markup, and resolves by policy. Nothing presents the two versions to a human. It is
genuinely a host concern, but with two consumers about to build the same panel twice, one reference
implementation in the demo is cheaper than two divergent ones.

**4. Spec-parser correction path.** Parsing is heuristic and will mis-read an unconventional
specification with no way for a user to fix it. A correction that persists — "this line is a clause
heading, that one is not" — turns a wrong parse from a dead end into a nuisance.

## Then — what the category expects and we lack

Larger, and worth arguing before starting.

**5. Real-time co-markup sessions.** Live sync today is a signal that triggers a reload: coarse, no
presence, no session. Simultaneous multi-user markup on one sheet is table stakes in this category —
it is the feature plan-review meetings actually run on. This is the biggest functional gap against
the market, and also the largest piece of work here, because presence and per-markup locking touch
the store, the adapters and the overlay at once.

**6. Canvas keyboard navigation.** The accessibility statement is *partially* conformant precisely
because you cannot Tab between markups on the sheet or draw one without a pointing device. The
markup list is a genuine equivalent for reaching and reading, not for authoring. Closing this is
what would let the conformance claim lose its qualifier — and it is a procurement gate for public
sector buyers.

## Speculative — needs a decision, not an implementation

**Automated takeoff.** Quantity takeoff assisted by a model is now its own product category rather
than a feature. It would fit this library the way OCR does — a provider interface, no bundled engine,
nothing shipped by default — and the tiling, calibration and quantity machinery it would need
already exists. But it is a bet on a direction rather than a gap to close, and it should be taken
deliberately or not at all.

**openCDE / BCF REST API.** The API half of openBIM collaboration, and what an ISO 19650 common data
environment increasingly expects. Whether this belongs in a *viewer* is genuinely unclear: it is a
server contract, and `RestAdapter` may be the more honest place for it to surface.

## Where it stands

## Built

| Spec area | State |
|---|---|
| §3 Navigation and viewing | Continuous scroll, tiled zoom, rotation, fit modes, thumbnails, sheet index, saved views, split pane, pinch-zoom and touch drawing. **No** multi-tab review sessions. |
| §4 Markup system | 22 kinds including revision clouds, stamps, measurements, glyph-anchored text markup, photo/file attachments, and voice notes. |
| §5 Structured markup data | Complete — every field in the spec's list, plus provenance. |
| §6 Revision survival | Overlay compare, alignment (translation and uniform scale), diff clustering, auto-clouding, slip-sheet migration with a review queue and audit trail. |
| §7 Specifications workspace | CSI section/clause parsing, clause tree, citation, requirement extraction, and drawing→spec callout detection with nearest-callout auto-citation. |
| §8 Issues and tasks | Pins, status, promote-to-issue, BCF topics and `.bcfzip`. Assignee and due date round-trip but live in `ext` rather than the typed model — see planned item 1. **No** forms or daily reports. |
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
title-block extraction, and the *recogniser* is supplied by the host. There is **no default engine**,
and none is named in `peerDependencies`: adapters for Tesseract, PaddleOCR, Azure and Google Vision
are provided as reference implementations, each loaded through a dynamic import behind an optional
dependency. `dist/massing-pdf.js` is 273 KB whether or not any of them is used. A custom provider is
four lines.

Choosing for the host would be choosing on their behalf whether drawings may leave the building —
which is not knowable from here. `e2e/ocr-bench.spec.ts` exists to inform that choice with numbers
instead.

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

**381 unit tests** (`npm test`) cover the pure logic: geometry and measurement, unit parsing and
formatting, store mutation/undo/merge semantics, every interchange round trip, spec parsing and
reference matching, text splitting, search matching, migration planning, OCR coordinate mapping,
OCR tile planning and overlap de-duplication, optimistic-concurrency wiring, permission enforcement and the audit trail, URL vetting, and the
ZIP writer — the last verified by reading
its own central directory back rather than by trusting the bytes.

**137 browser tests** (`npm run test:e2e`) cover what unit tests structurally
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
| `a11y.spec.ts` | keyboard reachability of every list, arrow/Home/End navigation, Enter and Space activation, landmarks, `aria-pressed`/`aria-selected`, live-region announcements, and a visible focus ring |
| `ocr-bench.spec.ts` | rasterise → recognise → score, against generated ground truth. Opt-in (`--project=ocr-bench`): it fetches ~12 MB of weights, so it informs a decision rather than gating a build |
| `csp.spec.ts` | the built demo behind a strict Content-Security-Policy with no `unsafe-eval` and no inline script — a drawing must rasterise with zero violations |
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

- **Tilt and barrel-rotation.** Pressure is captured and palm rejection works; tilt is read from the
  pointer event but nothing consumes it yet, and no renderer varies stroke width along a stroke.
- **Conflict-resolution UI.** The client detects a 409, carries both sides of every conflicted
  markup and resolves by policy (`theirs` by default). Presenting the two versions and letting a
  reviewer choose is a host concern this library only supplies the data for.
