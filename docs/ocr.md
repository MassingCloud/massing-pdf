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

## What to use

**Default: `localOcrProvider()` — PaddleOCR on the machine, Tesseract behind it.** The drawing never
leaves the browser, there is nothing to meter, and it works on a site laptop with no signal. Cloud
providers remain available and are covered below, but they are no longer the recommendation.

### Drawings — sparse, rotated, tiny text over dense linework

The hard case, and the one where engines actually diverge. Drawing text is sparse rather than
paragraphed, appears at arbitrary angles (labels along walls, section markers, north arrows), varies
from 6pt room tags to 24pt sheet numbers on the same sheet, and sits on top of hatching and linework
that looks like glyphs.

**PaddleOCR** is the local engine to use. Its detector finds text at arbitrary angles natively,
which is the single most relevant capability here: dimension strings run along dimension lines at
every angle and section marks are rotated. It is Apache-2.0 for both the code and the published
weights.

```ts
import { localOcrProvider } from "@massingcloud/pdf-viewer";

ocr: {
  dpi: 300,
  provider: localOcrProvider({
    // Bundle these. See "Staying offline" below — it is not optional if you mean it.
    models: {
      detection: await fetch("/models/PP-OCRv5_mobile_det.onnx").then((r) => r.arrayBuffer()),
      recognition: await fetch("/models/PP-OCRv5_rec.onnx").then((r) => r.arrayBuffer()),
      dictionary: await fetch("/models/en_dict.txt").then((r) => r.arrayBuffer()),
    },
  }),
}
```

**Tesseract is a poor fit for sheets** and it is worth being direct about why: it assumes document
text with consistent baselines and paragraph structure. On a drawing it needs per-orientation passes,
deskewing and aggressive preprocessing, and still under-performs. It sits behind PaddleOCR in the
chain as a second opinion, not as an equal.

### Specifications — dense body text

Ordinary document OCR; every engine does it well. `localOcrProvider()` covers it. If you already run
Tesseract and it is good enough on your spec sections, there is no reason to change.

### Staying offline actually requires supplying the models

`paddleOcrProvider()` will fetch default weights over the network if you do not give it any. That
breaks the offline guarantee this viewer is built around and puts a third party in the path of your
drawings — the same reason the pdf.js worker is bundled rather than pulled from a CDN.

Take the **mobile** tier: detection is about 5 MB and recognition about 7.5 MB, against 84 MB for the
server detection model, which is not viable in a browser. In the browser the weights are fetched per
page load and lean on the HTTP cache, so for a genuinely offline deployment either pass ArrayBuffers
you have bundled, or cache them in IndexedDB or a service worker.

### When to run it somewhere else

Browser inference suits **on-demand** recognition — a reviewer opens a scanned sheet and waits a few
seconds. It does not suit **bulk ingestion**. A 400-sheet set is roughly 3,200 tiles at 300 DPI, and
that is a server's job.

Self-hosting PaddleOCR behind your own endpoint is not an external API, and it keeps the same
guarantees. Point a provider at it and the rest of the pipeline is unchanged.

### Cloud engines, if you want them

Still supported, still behind a `proxy` so the credential stays server-side:

| | |
|---|---|
| **Azure AI Document Intelligence (Read)** | Handles rotated text lines and returns a per-line angle. Tuned for higher-resolution input, which suits 300–600 DPI tiles. |
| **Google Cloud Vision** | Use `TEXT_DETECTION`, *not* `DOCUMENT_TEXT_DETECTION`. The document mode assumes paragraph structure and reading order; on a drawing that assumption actively hurts. |
| **AWS Textract** | Strongest structured table output of the three — genuinely useful for door or finish *schedules* — but the weakest on sparse rotated text. |

Chain them explicitly if you want cloud cover behind the local engine:

```ts
fallbackOcrProvider(
  [paddleOcrProvider({ models }), azureOcrProvider({ proxy: "/api/ocr/azure" })],
  { onGiveUp: (p, e) => log.warn(`dropped ${p.id}: ${e.message}`) },
)
```

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

Running locally, both are moot — which is the point.

If you use a cloud provider: at 300 DPI an ARCH D sheet is ~8 tiles, so a 400-sheet set is ~3,200
API calls. At roughly $1.50 per 1,000 pages that is real money, and it is worth recognising **on
demand** (the default) rather than eagerly with `auto: true`. Cloud OCR also means sending drawings
to a third party, which on defence, healthcare or otherwise restricted projects may be disqualifying
on its own.

## Measuring it yourself

Every published OCR benchmark — OmniDocBench, receipt sets, scanned-page corpora — is measured on
document-shaped input. A construction sheet is not that, and those numbers should not be assumed to
transfer.

`e2e/ocr-bench.spec.ts` measures the engines against the demo's generated sample sheet, whose title
block is drawn by `demo/sample.ts` and is therefore known ground truth rather than an eyeballed
guess:

```bash
npx playwright test --project=ocr-bench
```

It is deliberately outside the normal suite: it downloads ~12 MB of weights and takes minutes. Point
it at your own sheets before committing to an engine — that is the only benchmark that answers your
question.

### What it measured here

Chromium, WASM backend, the sample sheet's title block at 300 DPI — a 958 × 500 tile carrying text
from 6pt to 22pt:

| | PaddleOCR | Tesseract |
|---|---|---|
| Strings recovered | **8 / 8** | 3 / 8 |
| Words | 10 | 9 |
| First tile | 62 s | 2.8 s |
| Each tile after | 553 ms | 108 ms |

Tesseract found the large text — the date, `A-201`, `SECOND FLOOR PLAN` — and missed every one of
the 6pt labels: `SCALE`, `DATE`, `DRAWING TITLE`, `SHEET NUMBER`, `REV`. That is the specific
failure that matters on a drawing, where the small lettering carries the sheet metadata.

Read the timings carefully:

- **The 62 s first tile is model download**, over the network from the wrapper's default host. Bundle
  the weights and it is a local read plus graph compilation.
- **553 ms per tile is the number that scales.** An ARCH D sheet is ~8 tiles, so roughly 4.5 s a
  sheet — fine when a reviewer opens one, and about 30 minutes for a 400-sheet set. That is the
  arithmetic behind "browser for on-demand, server for bulk".
- Tesseract being 5× faster per tile is no consolation when it cannot read the title block.

This is one tile of one synthetic sheet. It is enough to choose an engine and not enough to promise
a number on your drawings — run it on yours.

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
