# @massingcloud/pdf-viewer

A construction drawing review engine for the browser: PDF viewing, AEC markup, calibrated takeoff,
issue pinning, revision compare, and XFDF/BCF interchange — behind a small plugin kernel.

Extracted from [ibuilder/massing](https://github.com/ibuilder/massing)'s `pdfTakeoff` module and
rebuilt as a standalone, framework-agnostic library that Massing (or anything else) can consume.

```bash
npm install @massingcloud/pdf-viewer pdfjs-dist pdf-lib
```

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

Open the demo, hit **Load a sample sheet** — it generates an ARCH D drawing (title block, column
grid, rooms, graphic scale) at `1/8" = 1'-0"`. Pick that scale preset, measure the overall dimension
string, and you get `144'-0"` — the dimension printed on the sheet. Markups persist in IndexedDB, so
they survive a reload with no server involved.

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

### Measurement and takeoff

- **Named scale presets** (`1/4" = 1'-0"`, `1:100`, …) as well as draw-a-line calibration. A
  hand-drawn calibration that lands within 1.5% of a standard scale is labelled as that scale.
- **Per-page calibration**, because a plan sheet and its enlarged detail are different scales and a
  document-wide factor quietly produces wrong numbers on half the set.
- **Feet-and-inches**: `12'-6 1/2"`, not `12.54 ft`. Parsing accepts `12'-6"`, `6 1/2"`, `3/4"`,
  `300mm`, `4 meters`.
- Every quantity keeps its raw page-unit magnitude, so **re-calibrating a page re-derives every
  measurement on it** instead of forcing the estimator to draw them again.

### Revision intelligence

Two issues of a sheet are rasterised at a common resolution, **aligned** (plot origins drift between
issues, and without correction a naive pixel diff reports the whole drawing as changed), differenced,
and the changed regions clustered — then turned into real revision clouds in the markup store, with
authorship and status, not a throwaway picture.

### Issues and interchange

Pins map to **BCF topics** with a decodable sheet anchor, so an issue round-trips to the coordination
model and comes back able to re-place itself on a sheet plotted at a different size. Markups export
to **XFDF** (Bluebeam, Acrobat, Foxit, PDF-XChange) with a namespaced payload carrying the structured
fields XFDF has no vocabulary for — lossless back into this tool, and silently ignored elsewhere.

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
| `sheetsPlugin` | title-block extraction, sheet register, thumbnails |
| `persistencePlugin` | adapter wiring, debounced saves, live merge |
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
npm test           # 120 unit tests
npm run check      # typecheck + lint + test
npm run build      # library → dist/
npm run demo:build # standalone demo → dist-demo/
```

Requires Node 18.18+. `pdfjs-dist` and `pdf-lib` are peer dependencies and stay external in the
library build, so the host bundles exactly one copy of each — which matters most for the pdf.js
worker, since two versions in one page fail in confusing ways.

## Status

Working and tested: the markup engine, measurement, the store and undo, interchange, adapters, and
the plugin kernel. See [docs/roadmap.md](docs/roadmap.md) for what is deliberately not built yet —
notably the specifications workspace, OCR, and markup migration across a slip-sheet, which are
designed for in the data model but not implemented.

## Licence

MIT — see [LICENSE](LICENSE).
