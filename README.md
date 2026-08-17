# @massingcloud/pdf-viewer

A construction drawing review engine for the browser: PDF viewing, AEC markup, calibrated takeoff,
issue pinning, revision compare, and XFDF/BCF interchange — behind a small plugin kernel.

Extracted from [ibuilder/massing](https://github.com/ibuilder/massing)'s `pdfTakeoff` module and
rebuilt as a standalone, framework-agnostic library that Massing (or anything else) can consume.

**[Try the live demo →](https://massingcloud.github.io/massing-pdf/demo/)** — it generates its own
sample drawing set in the browser, stores markups in IndexedDB, uploads nothing, and keeps working
with the network off.

```bash
npm install @massingcloud/pdf-viewer pdfjs-dist pdf-lib
```

The `@massingcloud` scope is not claimed yet, so that command does not resolve. It blocks nobody —
a pinned git ref or a packed tarball both work today, and
[docs/publishing.md](docs/publishing.md) has all three routes.

## The idea

Most PDF annotators treat a markup as ink: a coloured shape with a comment attached. This one treats
it as a **record** — who drew it, against which sheet revision, in which discipline, what it
measures, which spec clause it cites, which IFC object it refers to, and what its review status is.
Rendering is one projection of that record; XFDF, BCF, CSV and a flattened PDF are others.

That single decision is what makes the difference between a document annotator and a review desk:
you can filter to "open structural comments on Level 4", roll those up into a takeoff, export them
as BCF topics for the coordination model, and have them survive a slip-sheet.

## Quick start

```ts
import { createViewer } from "@massingcloud/pdf-viewer";
import "@massingcloud/pdf-viewer/style.css";
// Bundle the worker — never load it from a CDN, the viewer must work offline.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const viewer = await createViewer({
  container: document.getElementById("app")!,
  workerUrl,
  author: "A. Reviewer",
  org: "Massing",
  initialZoom: "fit-width",
});

await viewer.load({ url: "/sheets/A-201.pdf", name: "A-201.pdf" });
```

Or take the kernel and only the plugins you want:

```ts
import { Viewer, configureWorker, markupPlugin, measurePlugin } from "@massingcloud/pdf-viewer";

configureWorker(workerUrl);
const viewer = new Viewer({
  container,
  plugins: [markupPlugin({ discipline: "structural" }), measurePlugin()],
});
```

## Try it

```bash
npm install
npm run dev
```

Open the demo, hit **Load a sample sheet** — it generates a three-page set: an ARCH D drawing at
`1/8" = 1'-0"` (title block, column grid, rooms, graphic scale), a details sheet, and a real
CSI-formatted spec section.

Two things worth trying, because they are the checks that the engine is honest rather than
plausible-looking:

- Pick the `1/8" = 1'-0"` scale preset and measure the overall dimension string. You get `144'-0"` —
  the dimension printed on the sheet.
- Open **Specifications** → *Read specification sections*. It finds `07 84 00 FIRESTOPPING`, its 23
  clauses in full hierarchy, and the submittal/quality/warranty requirements inside them.

Markups persist in IndexedDB, so they survive a reload with no server involved.

## What's in it

### Markup

The redline vocabulary a drawing reviewer actually uses, not a generic comment set:

| | |
|---|---|
| **Shapes** | rectangle, ellipse, line, arrow, polyline, polygon, freehand ink |
| **Revision cloud** | real scalloped arcs, density adapting to path length |
| **Text** | text, leader callout, highlight, strikeout, underline |
| **Construction** | dynamic stamps, issue pins, symbols |
| **Measurement** | distance, polyline length, area, perimeter, count, angle, radius, volume |

Markups carry a discipline, and the discipline drives the colour — the redline convention, rather
than a colour picker nobody standardises on.

Highlight, strikeout and underline select **real glyphs**, not a dragged box. A selection spanning
three lines records three quads and draws three bands — on screen and in the exported PDF — instead
of one block swallowing the margins. That is also what gives a spec citation something to anchor to.

### Measurement and takeoff

- **Named scale presets** (`1/4" = 1'-0"`, `1:100`, …) as well as draw-a-line calibration. A
  hand-drawn calibration that lands within 1.5% of a standard scale is labelled as that scale.
- **Per-page calibration**, because a plan sheet and its enlarged detail are different scales and a
  document-wide factor quietly produces wrong numbers on half the set.
- **Feet-and-inches**: `12'-6 1/2"`, not `12.54 ft`. Parsing accepts `12'-6"`, `6 1/2"`, `3/4"`,
  `300mm`, `4 meters`.
- Every quantity keeps its raw page-unit magnitude, so **re-calibrating a page re-derives every
  measurement on it** instead of forcing the estimator to draw them again.

### Revision intelligence and slip-sheeting

Two issues of a sheet are rasterised at a common resolution, **aligned** (plot origins drift between
issues, and without correction a naive pixel diff reports the whole drawing as changed), differenced,
and the changed regions clustered — then turned into real revision clouds in the markup store, with
authorship and status, not a throwaway picture.

The same alignment drives **markup migration**. When a sheet is re-issued, carrying its markups
forward blindly is worse than losing them: a comment reading "verify this dimension" sitting over a
dimension that has since changed is actively misleading. So each markup gets a verdict — unchanged,
relocated, or *needs a human* — and lands in a review queue with an audit trail, rather than being
silently reapplied.

### Specifications

A CSI spec book is parsed into addressable sections and clauses, so `07 84 00 §1.2.A` is a **link**
rather than a string somebody typed. Cite a clause on a markup, browse the clause tree, and pull the
submittal, quality, warranty and closeout requirements out of Part 1 into a checklist.

Field coordination lives in the specs: a drawing note saying "firestop per spec" is only actionable
if you can get to the section and read what it actually requires.

Callouts are detected too: a keyed note reading "FIRESTOP PER SPEC 07 84 00" is matched against the
parsed sections, so the panel shows which sheets reference a section, and a markup dropped beside
that note can cite it without anyone typing a section number.

### Touch and pen

Pinch to zoom, two fingers to reposition mid-markup, one finger to draw when a tool is armed and to
scroll when one isn't. The browser competes for these gestures, so ownership is switched explicitly
rather than left to `touch-action` defaults — and a gesture the browser claims mid-way arrives as
`pointercancel` with no `pointerup`, which is handled rather than leaving the viewer mid-drag.

A stylus suppresses touch for a short window afterwards, so the hand resting on a tablet neither
draws nor starts a pinch under the pen. Pressure samples are kept on the record even though the
renderer draws one width — discarding them at capture time would make variable-width rendering
unrecoverable later.

### Search

One query across sheet text, markup content and the sheet register, kept distinguishable in the
results and spatially located on the page. Phrase matching runs over the joined word stream, so a
phrase split across separate PDF text runs — the normal case — still matches.

### OCR, as an interface

Scans carry no text layer, so search, spec parsing and title-block extraction all return nothing on
them. Two constraints pull opposite ways here: the viewer must run offline, and it must stay a
library you can drop into an app — so bundling megabytes of WASM and requiring a server are both
wrong for half of all consumers.

The plugin therefore owns the rasterisation, the coordinate mapping and the wiring, and you supply
the recogniser:

```ts
import { createViewer, tesseractProvider, restOcrProvider } from "@massingcloud/pdf-viewer";

await createViewer({
  container, workerUrl,
  ocr: { provider: tesseractProvider() },        // needs `tesseract.js` in your app
  // ocr: { provider: restOcrProvider({ url: "/api/ocr" }) },
});
```

Everything reads text through one kernel seam — `viewer.pageText(page)`, which returns the PDF's own
layer or recognised text when there isn't one — which is why one provider lights up search, specs and
the sheet register at once.

**There is no default engine and none ships in the package.** The built library is 273 KB with or
without OCR; every adapter loads through a dynamic import behind an optional dependency. Adapters for
Tesseract, PaddleOCR, Azure and Google Vision are provided as reference implementations — the choice
is the host's, because whether drawings may leave the building is not knowable from here.

To inform that choice rather than assert it, `e2e/ocr-bench.spec.ts` measures engines against the
sample sheet's title block, whose contents are generated and therefore known exactly. On a 300 DPI
tile carrying 6–22pt text, PaddleOCR recovered 8 of 8 expected strings and Tesseract 3 of 8 —
Tesseract read the large text and missed every 6pt label, which is where a title block keeps its
metadata. It is also ~5× slower per tile, which is the trade. Run it against your own sheets: `npx playwright test --project=ocr-bench`. Details and
timings in [docs/ocr.md](docs/ocr.md).

Sheets are **tiled** before recognition, because resolution dominates the outcome: OCR needs ~18–20
pixels of character height, and the 1/8" lettering on an ARCH D sheet is 9px if you rasterise the
whole thing at once, versus 37px at 300 DPI — where the sheet becomes 78 MP and exceeds both mobile
canvas limits and every cloud API's per-image cap.

**Which engine to pick is a real decision, and it differs for drawings and specs** — see
[docs/ocr.md](docs/ocr.md).

### Access control and audit

A capability check enforced in the *store* — the seam every mutation crosses, so a host script, an
import or a storage adapter is gated the same as a toolbar click. Editing your own markup and
editing a colleague's are separate permissions, because on a review they are separate acts. Refusals
carry a reason, which is shown to the user and written to the audit trail along with every allowed
act. Client-side checks are advisory and the server stays the authority; this makes the interface
agree with it and records every attempt either way. See [docs/security.md](docs/security.md).

### Accessible, and tested that way

Every list is a single tab stop with arrow-key navigation, Enter and Space activation, and an
accessible name carrying what the colour swatch conveys visually. Landmarks, `aria-pressed` on armed
tools, live-region announcements for page and status changes, `prefers-reduced-motion`, and Windows
High Contrast support. Verified by driving real keys in a real browser, not by asserting attributes
exist.

The drawing canvas too, not only the panels: `Alt`+arrow steps through the markups on a sheet and
says where you are among them, arrows nudge a selection or aim a drawing cursor, `Space` places a
point and `Enter` finishes. What is *not* covered —  no screen-reader testing, no third-party audit,
and spatial accuracy on a drawing being a visual task regardless — is stated plainly in
[docs/accessibility.md](docs/accessibility.md).

### Runs under a strict CSP

No `unsafe-eval`, no inline script. Checked on every CI run by loading the built demo behind a real
policy header and asserting a drawing still rasterises with zero violations.

### Preservation mode

Provenance, a tracing overlay for checking a redraw against its source, and — more importantly —
**uncertainty**.
A dimension read off a medium-resolution scan of a century-old drawing is not the same claim as one
read off a CAD export, and a system that records both identically is quietly lying. Confidence tags
change how a markup *looks* — the less certain, the more broken up the line — alongside contrast and
invert adjustments for faint dyelines, and a transcription panel for handwriting.

### Issues and interchange

Pins map to **BCF topics** with a decodable sheet anchor, so an issue round-trips to the coordination
model and comes back able to re-place itself on a sheet plotted at a different size. Markups export
to **XFDF**, which every major PDF review and annotation tool reads, with a namespaced payload
carrying the structured fields XFDF has no vocabulary for — lossless back into this tool, and
silently ignored elsewhere.

### Offline-first

`OfflineAdapter` composes IndexedDB with your backend: writes go local → durable queue → network,
never network-first. A superintendent in a basement marks up a sheet, closes the tab, comes back up,
and the queue drains.

### Large sheets

Above a size threshold the renderer **tiles** the visible region into modest canvases. A D-size sheet
at 800% is roughly 27k × 17k device pixels — an order of magnitude past the per-canvas limits
browsers enforce — and the naive one-canvas-per-page approach silently produces a blank sheet exactly
when someone zooms in to read a dimension.

## Architecture

The kernel owns rendering, coordinates, selection, the store and the event bus. Everything with a
domain opinion is a plugin. Plugins never import each other; they meet at the bus and the registries.

```
Viewer (kernel)
├── PdfDocument      pdf.js boundary — pages, text, outline, metadata
├── PageView         tiled rasterisation
├── AnnotationStore  records, selection, calibration, undo/redo
├── EventBus         typed, the only cross-plugin channel
└── registries       tools · actions · panels · renderers
```

| Plugin | Does |
|---|---|
| `markupPlugin` | the shape/text/cloud toolset |
| `measurePlugin` | calibration, measurement tools, takeoff roll-up |
| `stampsPlugin` | dynamic stamps and tool chests |
| `pinsPlugin` | issue pins, promote-to-RFI, status board |
| `markupListPlugin` | the faceted markup list |
| `comparePlugin` | overlay, auto-align, diff, cloud-the-changes |
| `migrationPlugin` | slip-sheet: plan, verdict per markup, review queue |
| `ocrPlugin` | recognise scanned pages via a provider you supply |
| `viewsPlugin` | saved views and the split pane |
| `specsPlugin` | CSI parsing, clause tree, citation, requirement extraction |
| `searchPlugin` | document-wide search over text, markups and sheets |
| `historicalPlugin` | provenance, confidence, legibility adjustments |
| `attachmentsPlugin` | photos and files pinned to a markup |
| `sheetsPlugin` | title-block extraction, sheet register, thumbnails |
| `persistencePlugin` | adapter wiring, debounced saves, live merge |
| `conflictsPlugin` | the 409 dialog: both versions, side by side, reviewer chooses |
| `collabPlugin` | who else is here, and what they are editing — advisory leases, host's transport |
| `exportersPlugin` | PDF / XFDF / BCF / CSV in and out |
| `toolbarPlugin` | the default chrome — drop it and build your own |

Writing one:

```ts
import { definePlugin } from "@massingcloud/pdf-viewer";

export const keynotes = definePlugin({
  id: "keynotes",
  setup(ctx) {
    ctx.registerTool({
      id: "keynote", label: "Keynote", icon: "①", kind: "callout",
      input: "poly", minPoints: 2, group: "markup",
      create: ({ points, page }) => ({ kind: "callout", points, page, labels: ["keynote"] }),
    });
  },
});
```

See [docs/architecture.md](docs/architecture.md), [docs/plugin-api.md](docs/plugin-api.md) and
[docs/data-model.md](docs/data-model.md).

## Coordinates

Three spaces, and confusing them is the richest source of bugs in a markup tool:

- **page space** — PDF user units (1/72"), top-left origin, unrotated. All geometry stored here.
- **display space** — page space with the view rotation applied.
- **client space** — CSS pixels.

Every annotation also carries `nx`/`ny`, a 0..1 anchor within the page box, so a different renderer
(an SVG sheet, a mobile canvas, a re-plotted sheet at another size) can place the same markup.

PDF export delegates the conversion to pdf.js's own `viewport.convertToPdfPoint` rather than
hand-rolling a y-flip — a hand-rolled flip is correct only when CropBox equals MediaBox and
`/Rotate` is 0, and it fails silently on exactly the scanned and re-plotted sheets that most need
reviewing.

## Persistence

Implement `StorageAdapter` (four methods) or use one of the built-ins:

| Adapter | For |
|---|---|
| `MemoryAdapter` | tests, ephemeral sessions |
| `IndexedDbAdapter` | offline-only / no backend |
| `RestAdapter` | shaped for Massing's existing `/projects/{pid}/drawings/markup` endpoints |
| `OfflineAdapter` | IndexedDB + remote, with a durable outbound queue |

```ts
const viewer = await createViewer({
  container, workerUrl,
  persistence: {
    adapter: new OfflineAdapter({ remote: new RestAdapter({ baseUrl: "/api" }) }),
    key: (v) => ({ projectId, documentId: v.doc!.fingerprint }),
  },
});
```

## Reintegrating into Massing

`RestAdapter` targets Massing's existing markup endpoints and row shape, so no server change is
needed to adopt it — see [docs/integration-massing.md](docs/integration-massing.md) for the
drop-in replacement of `openPdfTakeoff`, and for what the richer model needs from the API later.

## Development

```bash
npm install
npm run dev        # demo at :5173
npm test           # 381 unit tests
npm run test:e2e   # browser tests (Playwright: Chromium, WebKit, Firefox, touch/pen, strict-CSP)
npm run check      # typecheck + lint + unit tests
npm run check:all  # the above, plus the browser suite
npm run build      # library → dist/
npm run demo:build # standalone demo → dist-demo/
npm run check:package  # entry points in package.json resolve to built files
npm run check:licences # no copyleft anywhere in the installed tree
```

Requires Node 18.18+. `pdfjs-dist` and `pdf-lib` are peer dependencies and stay external in the
library build, so the host bundles exactly one copy of each — which matters most for the pdf.js
worker, since two versions in one page fail in confusing ways.

## Status

Every functional area of the product spec is implemented, and both halves of the test pyramid are in
place: **381 unit tests** for the pure logic, and a Playwright suite for everything that needs a
real browser — rasterisation, the pointer gesture loop, touch and pinch, pen pressure and palm
rejection, keyboard operation, the compare pipeline, and the IndexedDB adapters, none of which a
headless DOM can reach.

The browser suite runs on Chromium, WebKit and Firefox, because the things it covers — per-canvas
size limits, pointer and touch dispatch, IndexedDB semantics — are precisely where engines differ.
Two claims that are easy to assert and hard to keep are verified rather than stated: the interface
is driven by real key presses, and the strict-CSP suite loads the built bundle behind a real policy
header. Dependency licences and the manifest's own entry points are checked on every run for the
same reason.

Not yet published to npm: the package is built and validated on every release run, but the
`@massingcloud` scope has to be claimed by hand first. See
[docs/publishing.md](docs/publishing.md).

The fixture makes the assertions checkable against the drawing rather than the implementation: the
sample plan is drawn at `1/8" = 1'-0"` with a `144'-0"` dimension printed on it, so the measurement
test drags that span with real mouse events and expects the number on the sheet.

[docs/roadmap.md](docs/roadmap.md) records what is deliberately *not* built and why: ICDD packaging
and the 4D/5D bridges wait on Massing's own coordination model, and BCF viewpoints are omitted
because a sheet markup has no 3D camera and inventing one would put a wrong number in a file other
tools trust. Known limitations are listed there too — the text layer switches off under view
rotation, spec parsing is heuristic with no manual-correction path, and the ZIP writer stores rather
than deflates.

## Documentation

| | |
|---|---|
| [architecture.md](docs/architecture.md) | the kernel, the plugin seam, and why it is shaped this way |
| [plugin-api.md](docs/plugin-api.md) | writing a tool, action, panel or renderer |
| [data-model.md](docs/data-model.md) | the annotation record, and what each field is for |
| [integration-massing.md](docs/integration-massing.md) | dropping this in for `openPdfTakeoff` |
| [consuming.md](docs/consuming.md) | what the surface guarantees: identity, PDF coupling, CSP, licences |
| [security.md](docs/security.md) | CSP, the permission model, the audit trail, credentials |
| [accessibility.md](docs/accessibility.md) | conformance, verified and unverified, stated plainly |
| [browser-support.md](docs/browser-support.md) | what is supported, and what each claim rests on |
| [versioning.md](docs/versioning.md) | what semver covers here, and what it does not |
| [publishing.md](docs/publishing.md) | releasing to npm, and the three ways to consume it before the scope exists |
| [realtime.md](docs/realtime.md) | co-markup: what already works, and the three decisions before building the rest |
| [licences.md](docs/licences.md) | the dependency licence audit |
| [ocr.md](docs/ocr.md) | choosing and wiring an OCR provider |
| [roadmap.md](docs/roadmap.md) | what is deliberately not built, and known limitations |
| [CHANGELOG.md](CHANGELOG.md) | what changed between versions |

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md), which also sets out what the
library treats as untrusted (PDF bytes, markup records from any source, OCR responses) and what it
explicitly does not defend against.

## Licence

MIT — see [LICENSE](LICENSE). Every dependency is Apache-2.0 or MIT-family, enforced on each CI run
rather than asserted: see [docs/licences.md](docs/licences.md).
