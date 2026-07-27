# Reintegrating into Massing

## What was extracted

`apps/web/src/drawings/pdfTakeoff.ts` (423 lines) — a single closure that opened a PDF, rendered one
page to a canvas, drew an SVG overlay, and supported pan / distance / area / count / rect /
calibrate / text / stamp, with JSON tool-set save-load, CSV export and a pdf-lib flatten.

Everything it did is here, plus the structure it didn't have. The parts worth naming:

| Was | Is now |
|---|---|
| one page at a time | continuous scroll, virtualised, tiled above ~4k px |
| click-only drawing | drag, poly with rubber-band, freehand, select, move, vertex edit |
| no undo | full undo/redo, one entry per gesture |
| markup = `{kind, pts, value, unit, label}` | a record with author, status, discipline, revision, links, provenance |
| document-wide calibration | per-page, plus named scale presets and feet-and-inches |
| 8 markup kinds | 22, including real revision clouds |
| CSV + flatten | CSV, takeoff roll-up, XFDF in/out, BCF topics, flatten with a markup schedule |
| callback-based persistence | adapter interface with an offline queue |
| one closure | kernel + 10 plugins |

## Drop-in replacement for `openPdfTakeoff`

The old entry point:

```ts
// apps/web/src/drawings/openPdf.ts
await openPdfTakeoff({ url, name, headers: api.authHeaders() }, opts);
```

The replacement keeps the same call shape:

```ts
import { createViewer, RestAdapter, OfflineAdapter } from "@massingcloud/pdf-viewer";
import "@massingcloud/pdf-viewer/style.css";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { toast } from "../ui/feedback";
import { askText } from "../ui/prompt";

export async function openPdfUrl(api: ApiClient, url: string, name: string, opts: TakeoffOpts = {}) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:250";
  document.body.appendChild(overlay);

  const viewer = await createViewer({
    container: overlay,
    workerUrl,
    author: api.currentUser?.name ?? "unknown",
    // Massing's own modal, not window.prompt.
    markup: { promptText: (title, initial) => askText(title, { label: title, value: initial ?? "" }) },
    measure: { promptText: (title, initial) => askText(title, { label: title, value: initial ?? "" }) },
    // MARKUP-2a: the project stamp library behind /stamps/library.
    stamps: { templates: () => api.stampLibrary().then((r) => r.templates) },
    pins: {
      promote: async (annot) => {
        const { topic } = await api.promoteDrawingMarkup(pid, annot.id);
        return { issueId: topic.id, ref: topic.title };
      },
    },
    persistence: {
      adapter: new OfflineAdapter({
        remote: new RestAdapter({ baseUrl: api.baseUrl, headers: () => api.authHeaders() }),
      }),
      key: () => ({ projectId: pid, documentId: sheetId }),
    },
  });

  // Massing's toast system rather than the built-in status line.
  viewer.on("notice", ({ level, message }) => toast(message, level === "error" ? "error" : "success"));

  await viewer.load({ url, name, headers: api.authHeaders() });
}
```

`opts.onSave` (save the flattened PDF back to its source) becomes `exporters.onFile`:

```ts
exporters: {
  onFile: async (blob, filename) => {
    if (filename.endsWith(".pdf") && opts.onSave) await opts.onSave(blob, filename);
    else download(blob, filename);
  },
},
```

## The REST adapter targets the existing API

`RestAdapter`'s defaults point at the endpoints Massing already has, so **no server change is needed
to adopt this**:

| Adapter call | Endpoint |
|---|---|
| `load` | `GET /projects/{pid}/drawings/markup?sheet={sheetId}` |
| `save` | `POST /projects/{pid}/drawings/markup/bulk` |
| `save` (deletes) | `DELETE /projects/{pid}/drawings/markup/{id}` |
| `subscribe` | `GET /projects/{pid}/drawings/markup/stream` (SSE) |

### Row mapping

`drawing_markups` has `id, project_id, sheet_id, x, y, note, author, topic_id, kind, data, created_at`.

- `x`/`y` get the markup's anchor, so the existing SVG sheet viewer keeps placing a pin for every
  markup without understanding the richer geometry.
- `data` keeps the field names the current readers expect (`pts`, `value`, `unit`, `page`, `text`,
  `nx`, `ny`, `rev`, `carried_from`) and adds `data.record` for everything else — status, discipline,
  priority, labels, style, links, provenance, replies, version.
- `fromWire` tolerates rows written before `data.record` existed: a legacy row's `value`/`unit`
  becomes a `Quantity`, and missing fields take defaults. **Existing markups load and render.**
- `topic_id` maps to `links.issueId`.

Calibrations and sheet metadata ride in the same table under reserved kinds (`__calibration`,
`__sheet`), so adopting per-page scales needs no migration either.

### Server-side follow-ups (optional, not blocking)

1. **Version column.** `merge()` resolves conflicts by `version`; it currently rides in
   `data.record.version`. A real column with an optimistic-concurrency check on write would make
   concurrent editing safe rather than last-writer-wins.
2. **Delta stream.** The SSE endpoint emits a change signature, so the client re-loads the whole
   sheet on any change. Fine for a sheet's worth of markups; emit the changed rows if sets get large.
3. **`data` indexing.** Filtering by status/discipline happens client-side. A GIN index on the JSON
   (or promoted columns) would let the server filter for the dashboard use case.

## Reusing the maths server-side

The measurement functions are pure and dependency-free, so the same logic can run in the API for
report generation without a browser:

```ts
import { measure, recalculate, polygonArea, formatQuantity } from "@massingcloud/pdf-viewer";
```

If the API stays Python, `docs/data-model.md` specifies the arithmetic precisely enough to port —
the load-bearing detail being that `Quantity.raw` is the pre-calibration magnitude in page units,
areas scale by the square of `unitsPerPoint`, and volumes by the cube times depth.

## Licence compatibility

Same as Massing's constraint: everything here is permissively licensed.

- `pdfjs-dist` — Apache 2.0
- `pdf-lib` — MIT
- this package — MIT

No PyMuPDF/AGPL equivalent is pulled in, and there is no runtime dependency beyond those two peers.
The pdf.js worker is bundled by the host, never fetched from a CDN, so the viewer keeps working in
an air-gapped field deployment.

## Where it does *not* yet meet the spec

The specifications workspace, OCR, slip-sheet markup migration, and the 4D/5D and digital-twin
bridges are designed for in the data model but not implemented. See [roadmap.md](roadmap.md) for
what each would take.
