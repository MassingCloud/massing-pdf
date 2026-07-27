# Architecture

## The shape

```
┌─ Viewer (kernel) ────────────────────────────────────────────┐
│                                                              │
│  PdfDocument ──── the only file that knows pdf.js exists     │
│      │            pages, page boxes, text items, outline     │
│      ▼                                                       │
│  PageView ─────── tiled rasterisation, one per page          │
│                                                              │
│  AnnotationStore  records · selection · calibration · undo   │
│  EventBus ─────── typed; the only cross-plugin channel       │
│  coords/geometry  page ⇄ display ⇄ client, measurement maths │
│                                                              │
│  registries ───── tools · actions · panels · renderers       │
└──────────────────────────────────────────────────────────────┘
        ▲                    ▲                    ▲
    plugins              adapters              io
  markup, measure,   memory, indexeddb,   xfdf, bcf, csv,
  stamps, pins,      rest, offline        flatten
  compare, sheets,
  list, toolbar
```

The kernel owns mechanism. Plugins own policy. The kernel does not know what a revision cloud
*means* — only that a tool asked for a `cloud` with four points.

## Why a plugin kernel

The spec calls for a base viewer plus layers for markup, specs, issues, revisions, takeoff, BIM
links, historical mode, field capture, workflow and reporting. Those have wildly different
lifespans: the rendering and coordinate code should change roughly never, while the domain layers
will churn continuously as the platform grows.

Putting them in one class means every domain change risks the rendering core. Putting them behind
registries means a plugin can be added, replaced or deleted without touching the kernel — and a host
that wants its own UI drops `toolbarPlugin` and drives `setTool`/`runAction` directly.

The constraint that makes this real: **plugins never import each other**. Everything crosses at the
event bus or a registry. That is what keeps the extension points honest rather than decorative.

## Coordinate spaces

| Space | Units | Origin | Used for |
|---|---|---|---|
| page | PDF points (1/72") | top-left, y down | **all stored geometry** |
| display | PDF points | top-left, rotated | the overlay's `viewBox` |
| client | CSS pixels | element box | pointer events |

Storing in page space makes geometry independent of zoom, rotation and viewport. The overlay's
`viewBox` *is* the page box, so the SVG renderer emits page-space numbers directly and zoom is free:
a 2pt cloud stays 2pt on the sheet at 50% and at 800%, exactly as it would if it had been drawn into
the PDF.

The only things that compensate for zoom are affordances — selection handles, pin badges, hit-test
padding — which must stay a constant *screen* size to be usable. They divide by zoom explicitly.

View rotation is a `transform` on the overlay's content group (`translate(h,0) rotate(90)` and
friends), so rotating the view never rewrites a single stored point.

### Round-tripping to PDF user space

PDF user space is bottom-left origin, and the mapping also depends on the page's CropBox and
`/Rotate`. `flattenToPdf` delegates to pdf.js's `viewport.convertToPdfPoint` rather than doing its
own flip. A hand-rolled `y = height - y` is correct only when CropBox equals MediaBox and `/Rotate`
is 0 — common but not universal, and the failure mode is markups landing in the wrong place on
precisely the scanned and re-plotted sheets that most need reviewing.

## Rasterisation

`PageView` renders one page. Below a size threshold that is one canvas; above it, the *visible*
region becomes a grid of ~1024px tiles, each replaying the same operator list through a translated
`transform`, with tiles evicted as they scroll away.

This is not premature optimisation. Browsers cap a canvas at roughly 4–16k pixels per side and
~256MP total. A D-size sheet at 800% is about 27k × 17k device pixels. The single-canvas approach
does not error — it silently yields a blank sheet, at exactly the zoom level where someone is trying
to read a dimension.

### Rasterisation is never awaited

pdf.js drives its canvas render loop from `requestAnimationFrame`, which browsers stop firing in a
background tab. So `updateVisible()` schedules rasterisation and returns; it does not await pixels.
Layout is settled synchronously; painting catches up and announces itself via `page:rendered`.

Awaiting it would mean `viewer.load()` hangs until a backgrounded tab is foregrounded again — which
presents to the host as a load that never resolves. (This was a real bug, caught by driving the
demo in a hidden browser pane.)

## The store

Every mutation goes through `AnnotationStore` so that:

1. each change emits exactly one event,
2. derived fields (`nx`/`ny`, `version`, `updatedAt`) are always consistent,
3. undo is a property of the store rather than something each tool must remember to implement.

Undo entries are coarse: a drag is one entry, not sixty. The pointer handler applies intermediate
frames with `{ bump: false, undoable: false }`, then on pointer-up restores the pre-drag geometry
silently and re-applies it as a single undoable update.

`merge()` is the sync path: incoming records win only if their `version` is genuinely newer, so a
colleague's save never clobbers an edit in progress locally.

## Filtering

One predicate, `matchesFilter`, shared by the overlay, the markup list, the reports and every
export. That sharing is deliberate — "export what I'm looking at" is only trustworthy if the thing
drawing the sheet and the thing writing the CSV agree on what passes.

## Persistence

```
Viewer ──► persistencePlugin ──► StorageAdapter
                                 ├── MemoryAdapter
                                 ├── IndexedDbAdapter
                                 ├── RestAdapter
                                 └── OfflineAdapter (IndexedDB + remote + queue)
```

The adapter interface is four methods (`load`, `save`, optional `subscribe`, optional `online`).
Saves are debounced and coalesced per annotation id.

`OfflineAdapter` writes local → durable queue → network, never network-first. A field user should
never see a spinner or lose a markup because the connection dropped mid-save; they should see their
markup immediately and a pending count until it drains.

## Interchange

| Format | Fidelity | For |
|---|---|---|
| JSON markup set | lossless | this tool, session save/load |
| XFDF | geometry + comments, plus a namespaced payload for the rest | Bluebeam, Acrobat, Foxit |
| BCF topics | issues, with a decodable sheet anchor | coordination models |
| CSV | flat report, formatted + raw + unit columns | estimating, PM reporting |
| flattened PDF | pixels + a markup schedule | issuing a reviewed set |

XFDF cannot express status, discipline, quantity or revision context. Rather than lose them, each
annotation carries a `<massing:record>` child holding the structured half. Other readers ignore it;
this one round-trips losslessly. When the payload is absent (a file from Bluebeam), the importer
falls back to inferring kind and geometry from the XFDF element itself.

## Testing

120 unit tests over the parts where correctness is load-bearing and cheap to verify: geometry and
measurement maths, unit parsing and formatting, the store's mutation/undo/merge semantics, and every
interchange round trip.

Rendering is verified by driving the real demo in a browser rather than by asserting on SVG strings
— the end-to-end check being that calibrating the generated sample sheet to the scale printed in its
title block measures the dimension printed on its face.
