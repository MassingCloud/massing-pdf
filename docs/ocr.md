# Choosing an OCR engine

Drawings and specifications are two different recognition problems, and the mistake that costs the
most is treating them as one. This page covers what to configure for each, and why the resolution
settings matter more than the engine choice.

## Resolution first — it dominates everything

Recognition needs roughly **18–20 pixels of character height**. Below that, accuracy collapses
regardless of which engine you use.

The smallest lettering on a construction drawing is 3/32"–1/8" plotted. Run the numbers on a sheet:

| Sheet | Whole sheet in one 2600px raster | @ 300 DPI |
|---|---|---|
| US Letter (spec) | 236 DPI → **30 px** ✓ | 8 MP |
| ARCH D 36×24 | 72 DPI → **9 px** ✗ | 78 MP |
| ARCH E 42×30 | 62 DPI → **8 px** ✗ | 113 MP |

A spec page is fine rasterised whole. **A drawing is not** — and the fix creates a raster that
exceeds mobile Safari's canvas limit (~16.7 MP) and every cloud OCR service's per-image cap.

So `ocrPlugin` cuts sheets into overlapping tiles at the target DPI, recognises each, and stitches
the results back into page space. That is why the options are expressed in DPI rather than pixels:

```ts
ocr: {
  provider,
  dpi: 300,              // the floor; 400–600 for faint scans or 3/32" lettering
  maxTileMegapixels: 12, // clears mobile canvas limits and cloud per-image caps
  overlapPoints: 72,     // 1" — a word on a seam must be whole in at least one tile
}
```

Overlap costs recognition time but prevents words being cut in half at a seam; duplicates from the
overlap are merged afterwards, preferring the copy that was less clipped.

## The viewer does not pick an engine

**There is no default OCR engine, and nothing recognition-related ships in the package.** The built
library is 273 KB with or without OCR — every engine below is loaded through a dynamic import behind
an optional dependency, so a consumer who never calls one downloads none of it.

What the viewer does own is the part that is genuinely its problem, and the part that is annoying to
get right:

- tiling a sheet at a resolution the lettering survives, within per-canvas size budgets
- de-duplicating words across tile overlaps
- mapping results back into page space, so search, spec parsing and title-block extraction all read
  one text layer through `viewer.pageText(page)`

Recognition itself is a host decision. You know whether drawings may leave the building, what the
budget is, which languages matter, and whether this runs on a workstation or a site tablet. Those
answers change the right engine, and none of them are knowable from here.

The rest of this page is evidence for making that choice, not a recommendation.

### The floor nobody escapes

Anything that can read 6pt lettering off a scan needs trained weights and something to run them.
Realistically that is ~25 MB of inference runtime plus ~12 MB of model weights, whichever engine you
pick. Writing an engine from scratch is training data and years, not a sprint. If OCR is not worth
that to you, the honest answer is to leave it unconfigured — scanned sheets simply have no text
layer, which is the state the viewer already handles.

### What we measured

Chromium, WASM backend, the sample sheet's title block at 300 DPI — a 958 × 500 tile carrying text
from 6pt to 22pt. Reproduce with `npx playwright test --project=ocr-bench`:

| | PaddleOCR | Tesseract |
|---|---|---|
| Strings recovered | **8 / 8** | 3 / 8 |
| Words | 10 | 9 |
| First tile | 62 s (model download) | 2.8 s |
| Each tile after | 553 ms | 108 ms |

Tesseract found the large text — the date, `A-201`, `SECOND FLOOR PLAN` — and missed every 6pt
label: `SCALE`, `DATE`, `DRAWING TITLE`, `SHEET NUMBER`, `REV`. That is the specific failure that
matters on a drawing, where the small lettering carries the sheet metadata. Being 5× faster per tile
is no consolation when it cannot read the title block.

Read the timings carefully. The 62 s first tile is model download over the network; bundle the
weights and it becomes a local read plus graph compilation. The 553 ms is the number that scales: an
ARCH D sheet is ~8 tiles, so ~4.5 s a sheet — fine when a reviewer opens one, and about 30 minutes
for a 400-sheet set. That arithmetic is why bulk ingestion belongs on a server rather than in a tab.

This is one tile of one synthetic sheet. Enough to inform a choice; not enough to promise a number
on your drawings. Point the benchmark at yours.

### Adapters provided

Reference implementations, not endorsements. Each is one function and loads nothing until called.

| Adapter | Needs | Notes |
|---|---|---|
| `tesseractProvider()` | `tesseract.js` | Fully local. Good on clean printed body text, weak on drawings — see above. |
| `paddleOcrProvider()` | `ppu-paddle-ocr`, `onnxruntime-web` | Fully local. Detects text at arbitrary angles, which is why it reads dimension strings and rotated section marks. Apache-2.0 code and weights. |
| `azureOcrProvider()` | a `proxy` endpoint | Azure AI Document Intelligence (Read). Returns a per-line angle. |
| `googleVisionOcrProvider()` | a `proxy` endpoint | Use `TEXT_DETECTION`, *not* `DOCUMENT_TEXT_DETECTION` — the document mode assumes a reading order a drawing does not have. |
| `restOcrProvider()` | your own endpoint | Point it at whatever you self-host. Not an external API. |

Compose whatever you want with `fallbackOcrProvider`:

```ts
ocr: {
  dpi: 300,
  provider: fallbackOcrProvider(
    [paddleOcrProvider({ models }), tesseractProvider()],
    { onGiveUp: (p, e) => log.warn(`dropped ${p.id}: ${e.message}`) },
  ),
}
```

### If you do run an engine locally, supply the weights

`paddleOcrProvider()` will fetch default weights over the network if given none. That breaks the
offline guarantee this viewer is built around and puts a third party in the path of your drawings —
the same reason the pdf.js worker is bundled rather than pulled from a CDN.

Take the **mobile** tier: detection ~5 MB, recognition ~7.5 MB, against 84 MB for the server
detection model. In a browser the weights are fetched per page load and lean on the HTTP cache, so
for a genuinely offline deployment pass ArrayBuffers you have bundled, or cache them in IndexedDB or
a service worker.

### Fallbacks

`fallbackOcrProvider` tries providers in order and moves on when one fails. Two behaviours worth
knowing:

- **A provider that keeps failing is dropped** for the rest of the run, after `giveUpAfter`
  consecutive failures (default 3). The failure that matters is not a bad tile, it is an engine that
  cannot work at all — a missing model file, a rejected key, no network. Without this, one
  misconfiguration puts the same doomed attempt through every tile of the set, each waiting for its
  own timeout. A success clears the record, so an intermittent failure never retires a working
  engine.
- **`onGiveUp` and `onFallback` fire when the chain degrades.** Falling from a local engine to a
  cloud one changes where the drawing goes and who is billed. That should not be discovered on an
  invoice.

## Cost and privacy

Running locally, both are moot.

If you use a cloud provider: at 300 DPI an ARCH D sheet is ~8 tiles, so a 400-sheet set is ~3,200
API calls. At roughly $1.50 per 1,000 pages that is real money, and it is worth recognising **on
demand** (the default) rather than eagerly with `auto: true`. Cloud OCR also means sending drawings
to a third party, which on defence, healthcare or otherwise restricted projects may be disqualifying
on its own.

## Writing your own provider

Four methods' worth of surface. Coordinates are **raster pixels within the tile**; the plugin maps
them back to page space and merges across tiles:

```ts
const provider: OcrProvider = {
  id: "my-engine",
  async recognise({ canvas, page }) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    const res = await fetch("/api/ocr", { method: "POST", body: blob! });
    const { words } = await res.json();
    return { words };  // [{ text, x, y, w, h, confidence? }]
  },
};
```

Everything downstream reads through `viewer.pageText(page)`, so one provider lights up search, spec
parsing and title-block extraction together.

## Sources

- [Image quality and resolution for OCR](https://knowledge.broadcom.com/external/article/254861/image-quality-and-resolution-for-ocr-res.html) — the 18-pixel character-height floor.
- [Azure Document Intelligence Read](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/read?view=doc-intel-4.0.0) — minimum text height, resolution behaviour.
- [Google Vision text detection limits](https://sparkco.ai/blog/mastering-google-vision-api-text-detection-limits) — `TEXT_DETECTION` vs `DOCUMENT_TEXT_DETECTION`, 20 MB image cap.
- [Cloud OCR comparison 2026](https://imagetotable.ai/blog/google-vs-aws-vs-azure-ocr-2026) — relative accuracy and per-service strengths.
