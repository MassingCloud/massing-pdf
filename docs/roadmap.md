# Roadmap

Two halves. **What is planned**, sequenced and argued, and **where it stands** against
`massing_pdf_viewer_spec.md` — the second being honest about the gap rather than implying the spec
is met.

Ordering principle: unblock consumers, then close gaps this repo already documents, then close gaps
the market expects, then speculate. Anything that needs a decision rather than an implementation is
marked as such, because those are not mine to make.

## Now — decisions, not blockers

**Publish to npm.** *Not blocking anyone, and it was wrong to say it was.*

The `@massingcloud` scope is unclaimed, so `npm i @massingcloud/pdf-viewer` does not resolve. Both
consumers can install today from a packed tarball, a pinned git ref, or GitHub Packages — all three
verified and written up in [publishing.md](publishing.md).

Calling it a blocker cost something real. The one part nobody in this repo can fix was named as the
thing in the way, so the part that *was* broken and fixable went unexamined: a git install produced
a package that could not be imported at all, because `dist/` is gitignored and npm runs `prepare`
for a git dependency rather than `prepublishOnly` — and there was no `prepare`. Anyone who had
actually tried the documented fallback would have found it in a minute. Nobody tried, because the
docs said the blocker was elsewhere.

Claiming the scope buys a clean `npm i`, semver ranges and provenance. Worth doing, and worth doing
before someone else takes the name — but it is a convenience, not a prerequisite.

**Decide the pdf.js line.** Held at `~6.1.200`. Version 6.2 drops Node 20 and lifts the browser
floor to Chrome 122+, Firefox 131+, Safari 18.4+. That is a support-matrix decision affecting both
consumers, not a dependency bump — see [browser-support.md](browser-support.md).

## Next — empty

All four items that stood here are done. What they were, and what building them taught, is kept
below rather than deleted: the reasoning is the part worth keeping, and two of the four turned out
to be different problems than the entry described.

The next real work is in **Then**, and both items there want an argument before a branch.

### Done — what "Next" held

**1. Workflow fields into the typed model.** *Done.* `assignee` and `dueDate` were untyped strings
inside `ext`, fished back out with `typeof x === "string"` guards in `io/bcf.ts`. They are now on
`Annotation` beside `priority`.

The near-miss worth recording: promoting a field out of `ext` touches **four** places, and the
importer is the one you forget. `io/xfdf.ts` has a write side (`structuredPayload`) *and* a read side
that enumerates payload keys by hand — adding to the first alone means the field is written and then
silently dropped on import.

**2. ~~BCF 3.0 output~~ — dropped, and replaced by schema conformance.** *Done.*

The premise was wrong twice over. BCF **2.1 already models** assignment and deadlines
(`AssignedTo`, `DueDate`), so item 1 delivered that workflow value without a version bump — the
claim that 3.0 is where workflow lives came from a secondary source and does not survive contact
with the schema. And 3.0 adoption is still thin: as of August 2026 the BCF managers plugged into
Revit, Navisworks, Solibri and Tekla read 2.x, and BIMcollab lists 3.0 as roadmap rather than
shipped. Emitting 3.0 would have *reduced* interoperability, which is the only thing BCF is for.

Checking our 2.1 output against the actual schema instead found a real defect. `Topic` is an
`xs:sequence`, so element order is normative, and ours was wrong in three places — `ReferenceLink`
last when it must be first, `Labels` after `Description`, `AssignedTo` before `DueDate`. A validating
reader rejects the file outright, and `ReferenceLink` is what carries the sheet anchor. `ModifiedAuthor`
was declared on the interface and never written. Both fixed, with the order pinned by a test.

Revisit 3.0 when the tools that have to read our files support it.

**3. A conflict-resolution reference.** *Done.* `conflictsPlugin()` supplies the panel the 409 path
had no answer for: it exposes `viewer.conflicts.ask(conflict)`, which is exactly the shape
`persistencePlugin`'s `onConflict` hook takes, so wiring it is one line. It remains a host concern —
not installing the plugin and supplying your own `onConflict` is the supported alternative — but with
two consumers about to build the same panel twice, one they can replace beats two that drift.

Building it settled two questions the policy modes had let us avoid. **Escape and the timeout both
resolve to *theirs*, and "Keep theirs" holds initial focus**, because every ambiguous exit should
land on the answer that destroys nothing; a dialog dismissed unread must not be how a colleague's
edit gets overwritten. And a **bodyless 409 shows no comparison table at all** — diffing a record
against one the server never sent renders their column as em dashes, which asserts their version has
no subject and no status, a claim we do not have. That was a real defect, caught by a test written
to check the opposite.

This is also the first use of `trapFocus`, which had been exported from `core/a11y.ts` and used
nowhere.

**4. Spec-parser correction path.** *Done.* The specs panel has a third tab, "Fix parsing", listing
every line the parser read on the current page with what it made of each — `§ 07 84 00`, `1.2.B`, or
`—` for prose — and a dropdown to overrule it. `parseSpecLines(lines, corrections)` takes them, so
the heuristics stay exercisable against plain text.

A correction is addressed by **page and line text**, not by index or coordinates. Text is what the
person pointed at, and it survives re-parsing, a different zoom, and OCR re-running with different
boxes. It does not survive the text itself changing, which is the honest limit.

Three things worth recording:

- **The dead end is a missed *section heading*, not a missed clause.** You cannot navigate to a
  section that was never found, and clause-level accuracy does not make up for it. `SECTION_HEADING`
  caps a title at 80 characters, so a long descriptive title takes the whole heading down with it —
  that is the case the first test covers, and it is real.
- **Correcting re-parses; it does not re-read.** Reading pulls text for every page and is the
  expensive half; parsing is pure and instant. `readSpecLines` was split out of `parseSpecs` so the
  lines can be held and re-parsed on each change. A test counts `pageText` calls to pin it.
- **Persistence is the host's.** `corrections` loads them and `onCorrect` receives the whole set
  after any change, so storing is one write of one array rather than a diff to apply.

## Then — what the category expects

Both were larger, and both were argued before a branch. Item 5's argument is
[realtime.md](realtime.md), and writing it shrank the item by finding a claim here that was simply
untrue. That is the case for arguing first, made once rather than asserted.

**5. Real-time co-markup sessions.** *Stages 1 and 2 built — see [realtime.md](realtime.md).*

`PresenceChannel` is the contract, `MemoryPresenceChannel` an in-process implementation for the demo
and tests, and `collabPlugin` the participants panel, advisory leases taken on selection, and the
mark on markups held by others. Stage 3 (where on a sheet someone is looking) is deliberately not
built: highest traffic, lowest value, and worth doing only once the first two are in use.

This entry used to say live sync was "a signal that triggers a reload: coarse". **That was wrong.**
`subscribe` delivers a `LoadResult` and `persistencePlugin` folds it in with `store.merge`, a
per-record merge that accepts a remote record only when its version is genuinely newer, then
advances `baseVersions` and redraws. Nothing reloads. Writing the design note is what caught it, and
it shrinks the item: the substrate is already record-level and correct.

What is actually missing is **intent** — knowing someone else is in the document, and that they are
editing *this* markup, before you both do the work and meet at a 409. That is a smaller thing than
"real-time editing" implies, and it stages into three shippable pieces.

The three decisions the note settles, because each is cheap to get wrong and expensive to unpick:
a lock must live *beside* the record and not on it (`Annotation.locked` already means "signed off",
and anything on the record takes a version, so a lock could itself conflict); releases must be
**leased with the server owning time**, since `beforeunload` fails exactly when it matters; and
presence must **not** go through `StorageAdapter`, or `OfflineAdapter` will persist cursor positions
and replay them stale on reconnect.

Throughout, a lock stays advisory and the version check stays the authority — locking makes
collisions rare and visible, it does not prevent them, and a host with no realtime backend must be
no worse off than today.

**6. Canvas keyboard navigation.** *Done.* `Alt`+arrow steps through the markups on the sheet in
reading order and announces the position among them; arrows nudge a selection, aim a drawing cursor
when a tool is armed, and pan when there is nothing else to do; `Space` places a point and `Enter`
finishes. Documented in [accessibility.md](accessibility.md), driven with real keys in
`e2e/a11y.spec.ts`.

Three things worth recording:

- **`Space` and `Enter` have to be different keys.** With one doing both there is no way to say
  "another vertex" rather than "done", and a polygon becomes impossible without a pointer.
- **Arrows are claimed only when there is something to do with them**, because they are also how
  you pan a drawing — taking them unconditionally would trade one keyboard gap for another. Writing
  that fallback found that arrows did not pan *at all* with the canvas focused: the browser scrolls
  the focused element's scrollable **ancestor**, and the scroller here is a descendant of the
  focused root. The e2e test asserting it caught an assumption that had never been checked.
- **The aim has to be drawn.** A pointer carries its own cursor; a keyboard has none, so without
  a rendered crosshair the person aiming is the only one who cannot see where they are aiming.

The conformance claim loses its *partial* qualifier, but gains an honest one — conformant and
**unaudited**. Nobody has run a screen reader against it in anger, and spatial accuracy on a drawing
remains a visual task whatever the key bindings are.

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
| §7 Specifications workspace | CSI section/clause parsing, clause tree, citation, requirement extraction, drawing→spec callout detection with nearest-callout auto-citation, and a per-line correction path for what the heuristics misread. |
| §8 Issues and tasks | Pins, status, promote-to-issue, typed assignee and due date, BCF topics and `.bcfzip`. **No** forms or daily reports. |
| Live collaboration | Presence, advisory per-markup leases with server-side expiry, and a mark on what someone else is editing. Transport is the host's — no bundled socket. **No** live stroke replay, and no OT/CRDT on geometry, both deliberately. |
| §9 Offline-first | IndexedDB working copy, durable outbound queue, optimistic concurrency — every write carries the version it was based on, a 409 surfaces both sides, and `conflictsPlugin` presents them for a human to choose between. |
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
| `conflict-dialog` (unit) | what the 409 dialog does when nobody makes a deliberate choice — Escape, timeout, initial focus — plus a bodyless 409 rendering no comparison, hostile server text staying text, and the whole path wired through the save queue |
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
- **Conflict resolution beyond choosing a side.** `conflictsPlugin` presents both versions and takes
  a whole-record answer. It does not offer a per-field merge — "their status, my comment" — which is
  the next thing a reviewer asks for once they can see the two side by side.
