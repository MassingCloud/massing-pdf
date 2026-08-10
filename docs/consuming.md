# Consuming this library

What the published surface actually guarantees, for a host deciding whether to build against it.
Written because two products now consume it and the same five questions arrived from both.

For the Massing web app specifically, see [integration-massing.md](integration-massing.md).

## Identity: how a markup points at a model element

`AnnotLinks.ifcGuids` on the annotation record:

```ts
/** IFC GlobalIds this markup refers to. Massing addresses model elements by GUID, never by
 *  transient viewer ids — so do the same here. */
ifcGuids?: string[];
```

**It is an IFC GlobalId, and it is a plain `string[]`.** The semantics are what you want; the type
is unbranded. If your side uses a branded `Guid`, writing is a straight join — a branded string
assigns to `string` freely. Reading back gives you `string`, so validate at your boundary. That is
one `asGuid()` call, not an adapter layer.

Two things worth knowing:

- It is an **array**. One markup may cite several elements — a cloud over an assembly, a dimension
  between two objects.
- It **round-trips**. The GUIDs ride in the `<massing:record>` payload inside XFDF, and through BCF,
  so a markup exported and reimported keeps its model references.

We deliberately do not brand the type, because the library has no way to validate a GlobalId that a
host has not already validated, and a branded type here would imply a guarantee it cannot make.

## Does it need a PDF?

**The viewer does. The record model does not.** That split is the useful part of the answer.

| | Needs a PDF |
|---|---|
| `Viewer` — rendering, tiling, the gesture loop | **yes**, pdf.js is the renderer |
| `AnnotationStore` — the record model, selection, undo, calibration | no |
| `io/xfdf`, `io/bcf`, `io/csv` | no — verified pdfjs-free |
| `io/flatten` | yes, it writes into a PDF |

`AnnotationStore` takes a `pageSize: (page: number) => { width, height } | undefined` callback, not
a document. So if your sheets are live SVG in model space, you can hold the markup records, run
calibrated measurement over them, and export XFDF or BCF **without a PDF anywhere** — supplying your
own rendering and your own page boxes.

What you cannot do today is get the *viewer's* rasterisation, tiling, text layer and gesture loop
over a non-PDF substrate. Those are built on pdf.js. If you want the review desk, the sheet has to be
a PDF page at that moment; if you want the record model and interchange, it does not.

## Title blocks

**There is no authoring template, and you should own that.** What exists is the reading direction:

```ts
extractSheetMeta(viewer, page): Promise<SheetMeta | null>
```

It heuristically reads a title block out of page text — the right 22% or bottom 18% of the sheet,
the two conventional placements — and returns `SheetMeta`:

```ts
interface SheetMeta {
  sheetId: string;
  page: number;
  number?: string;        // "A-201"
  title?: string;         // "SECOND FLOOR PLAN"
  discipline?: Discipline;
  kind?: SheetKind;
  revision?: string;
  issueDate?: string;
  scaleLabel?: string;
  package?: string;
  provenance?: Provenance;
}
```

Consume `SheetMeta` as the shared vocabulary for the *fields* so there is one definition of what a
sheet is. But the layout, the revision table, the frame geometry — that belongs with whoever
generates sheets, which is not this library. We only ever read them.

Useful consequence: if your generated title blocks put their fields in the conventional strips,
`extractSheetMeta` reads them back without configuration, and the sheet register populates itself.

## Offline and Content-Security-Policy

Verified rather than asserted — `e2e/csp.spec.ts` serves the built demo behind a real policy header
on every CI run and requires a drawing to rasterise with zero violations.

**Nothing in the shipped bundle reaches a third-party origin.** No `@font-face`, no `url()`, no
`@import` in the CSS; no inline script. Every `fetch` in shipped source goes to a URL the host
supplied: the PDF itself (`core/document.ts`), the markup API (`adapters/rest.ts`), and your own OCR
endpoint if you configure `restOcrProvider`.

Two things to check on your side:

**`blob:` in `script-src` and `worker-src`.** [security.md](security.md) documents the policy we
verify against, and it includes `blob:` because most bundlers emit the pdf.js worker as a blob URL.
If yours emits it as a same-origin asset — which Vite's `?url` does — you can drop `blob:`. **Verify
this first**, because a blocked worker means nothing renders at all, and it fails loudly rather than
subtly.

**`wasm-unsafe-eval` is not needed** unless you configure OCR. The library ships no WASM.

**OCR weights are the one thing that will fetch.** `paddleOcrProvider()` pulls its default models
over the network if you do not supply them, which will trip a "no third-party origin" build check.
Pass `models` as ArrayBuffers you have bundled, or leave OCR unconfigured — there is no default
engine and nothing is loaded until you ask for one.

## Licences

The published package has **no runtime dependencies**. The whole runtime closure a consumer takes on
is:

| | Licence |
|---|---|
| `@massingcloud/pdf-viewer` | MIT |
| `pdfjs-dist` (peer) | Apache-2.0 |
| `pdf-lib` (peer, optional — only for PDF flattening) | MIT |

Nothing MPL-2.0, BSL, or copyleft reaches a consumer, so a gate restricted to
MIT / MIT-0 / BSD-2 / BSD-3 / 0BSD / Apache-2.0 / ISC passes.

`scripts/check-licences.mjs` does permit MPL-2.0, but only for **build tooling** — `lightningcss`,
which Vite 8 uses to transform CSS and which never ships. That allowance is guarded: the script
asserts the package has zero runtime dependencies and fails loudly if one is ever added, because the
allowance stops being sound the moment something can reach a consumer. See
[licences.md](licences.md).

## Not published yet

`@massingcloud/pdf-viewer` is built, validated and packaged on every release run, but the
`@massingcloud` npm scope has not been claimed. Until it is, `npm i` will not resolve it — see
[publishing.md](publishing.md) for the sequence and the three ways to consume it in the meantime.
