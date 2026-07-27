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

### Specifications — dense body text

This is ordinary document OCR and every engine does it well. Pick on deployment constraints, not
accuracy:

| | |
|---|---|
| **Offline required** | `tesseractProvider()`. Genuinely good on clean printed body text; install `tesseract.js` in the host. |
| **Best accuracy** | Azure AI Document Intelligence (Read). Consistently at or near the top for printed text, and it returns paragraph and reading-order structure the spec parser can use. |
| **Layout traceability** | Google Cloud Vision `DOCUMENT_TEXT_DETECTION`, which returns a page → block → paragraph → line hierarchy. |

### Drawings — sparse, rotated, tiny text over dense linework

A different problem, and the one where engines actually diverge. Drawing text is sparse rather than
paragraphed, appears at arbitrary angles (labels along walls, section markers, north arrows), varies
from 6pt room tags to 24pt sheet numbers on the same sheet, and sits on top of hatching and
linework that looks like glyphs.

**Recommendation: Azure AI Document Intelligence (Read), or Google Cloud Vision `TEXT_DETECTION`.**

- **Azure Read** handles rotated text lines and returns a per-line angle, which is what you need for
  vertical wall labels. It is also tuned for higher-resolution input than the general Vision Read
  API, which suits tiles at 300–600 DPI.
- **Google Cloud Vision** — use `TEXT_DETECTION`, *not* `DOCUMENT_TEXT_DETECTION`. The document mode
  assumes paragraph structure and reading order; on a drawing that assumption actively hurts, since
  there is no reading order to find. `TEXT_DETECTION` is built for sparse text of exactly this kind.

**Tesseract is a poor fit here** and it is worth being direct about why: it assumes document text
with consistent baselines and paragraph structure. On a drawing it needs per-orientation passes,
deskewing and aggressive preprocessing, and still under-performs. Use it for specs, not for sheets.

**AWS Textract** is strong on forms and tables and returns the best structured table output of the
three — genuinely useful if you are extracting door or finish *schedules* — but is the weakest of
the three on sparse rotated text.

### A reasonable default

Route by what the page is, since the sheet register already knows:

```ts
const azure = restOcrProvider({ url: "/api/ocr/azure" });
const local = tesseractProvider();

ocr: {
  dpi: 300,
  provider: {
    id: "by-sheet-kind",
    recognise: (input) =>
      viewer.store.sheet(input.page)?.kind === "spec"
        ? local.recognise(input)
        : azure.recognise(input),
  },
}
```

## Cost and privacy

At 300 DPI an ARCH D sheet is ~8 tiles. A 400-sheet set is ~3,200 API calls — at roughly $1.50 per
1,000 pages that is real money, and it is worth recognising **on demand** (the default) rather than
eagerly with `auto: true`.

Cloud OCR also means sending drawings to a third party. On defence, healthcare or otherwise
restricted projects that may be disqualifying on its own, which is the other reason
`tesseractProvider()` exists.

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
