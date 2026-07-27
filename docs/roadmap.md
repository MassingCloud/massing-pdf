# Roadmap

Measured against `massing_pdf_viewer_spec.md`. The point of this page is to be honest about the gap
between what the spec asks for and what exists, rather than to imply the spec is met.

## Built

| Spec area | State |
|---|---|
| §3 Navigation and viewing | Continuous scroll, tiled zoom for large sheets, rotation, fit modes, thumbnails, sheet index. **No** split view or multi-tab sessions. |
| §4 Markup system | 22 kinds including real revision clouds, stamps, measurements, glyph-anchored text markup, and photo/file attachments. **No** voice capture UI. |
| §5 Structured markup data | Complete — every field in the spec's list, plus provenance. |
| §6 Revision survival | Overlay compare, auto-alignment, diff clustering, auto-clouding, **and slip-sheet migration with a review queue**. |
| §7 Specifications workspace | CSI section/clause parsing, clause tree, clause citation from a markup, requirement extraction. **No** cross-document spec↔drawing auto-linking. |
| §8 Issues and tasks | Pins, status, assignee, due date, promote-to-issue, BCF mapping. **No** forms or daily reports. |
| §9 Offline-first | IndexedDB working copy, durable outbound queue, version-based merge. **No** conflict-resolution UI. |
| §10 Search | Document-wide search over sheet text, markups and the sheet register, with per-scope facets and spatial hit locations. **No** OCR, so scans are unsearchable. |
| §11 Historical mode | Provenance fields, confidence tags that visibly change how a markup reads, transcription, contrast/invert legibility adjustments. **No** tracing overlay. |
| Data model / interchange | JSON, XFDF, BCF topics, CSV, flattened PDF. **No** BCF `.bcfzip` packaging or ICDD. |
| Plugin architecture | Kernel + 15 plugins, stable extension points. |

## Not built

### OCR (spec §10, §11)

The single largest remaining gap, and the one that gates the others for scanned sets. Without it,
search, spec parsing and title-block extraction all return nothing on a scan — they degrade
gracefully, but they degrade to empty.

Needs a decision before any code: server-side (a service call, no bundle cost, needs connectivity)
or in-browser (Tesseract WASM, several MB, works offline). The offline requirement argues for the
latter and the bundle size argues against it. Worth deciding deliberately rather than by default.

### Spec ↔ drawing auto-linking (spec §7)

Citation works, but it is manual: select a markup, click a clause. The spec asks for cross-links
from drawing callouts to spec clauses — meaning a keynote reading "FIRESTOP PER 07 84 00" should
offer the link itself. The pieces exist (the clause index, the sheet text index); what's missing is
the matcher and a confidence threshold below which it should stay quiet.

### Voice notes and field capture (spec §4, §9)

Attachments handle photos, video and files. Voice specifically needs `MediaRecorder` wiring and a
playback control, plus a decision about where a 2-minute recording lives when there's no upload
handler configured.

### Tracing overlay (spec §11)

Comparative mode overlays a historical scan against a redrawn CAD sheet — compare already does the
raster overlay, but the preservation workflow wants an adjustable-opacity tracing layer that stays
put while you draw on top of it, which is a different interaction.

### 4D/5D, digital twin, ICDD (spec Phase 3)

`AnnotLinks.ifcGuids` is the hook. Everything above it depends on Massing's own coordination
surfaces and isn't buildable here in isolation.

## Known limitations

- **Compare handles translation only** — not rotation or scale. Sheets re-issued at a different
  size, or scans with a slight skew, will not align, and migration inherits that. A similarity
  transform is the fix; the brute-force pyramid search doesn't extend cleanly to more parameters, so
  it likely wants proper phase correlation instead.
- **The text layer is disabled when the view is rotated.** Its spans are positioned in unrotated
  page space, so a rotated view would offer selections that land in the wrong place. Hiding it is
  the honest failure; making it follow the rotation is the fix.
- **Spec parsing is heuristic.** It handles the common CSI three-part format well and will mis-parse
  offices that deviate. There is no manual-correction path yet — a section it misses is invisible
  rather than editable.
- **Word boxes are apportioned by character count**, so a search hit's highlight in a proportional
  font can be off by a character's width. Fine for finding things; not precise enough to derive
  geometry from.
- **The toolbar rebuilds wholesale** on selection change. Fine at this scale.
- **No virtualisation in the markup list or the search results.** Both cap at a few hundred rows.
- **Prompts default to `window.prompt`.** Every plugin taking user text accepts a `promptText`
  override, and a host should pass one — the default exists so the library works standalone, not
  because it is good.

## Testing gaps

164 unit tests cover geometry, units, the store, interchange, spec parsing, text splitting, search
matching and migration planning. Not covered by unit tests:

- The pointer gesture loop (drag, poly, vertex edit).
- Tiled rasterisation at high zoom.
- The compare/diff pipeline end to end.
- `IndexedDbAdapter` and `OfflineAdapter` queue drain and retry.

These need a browser: `happy-dom` has no layout, and pdf.js drives its render loop from
`requestAnimationFrame`, which does not fire in a headless or hidden page. They are currently
verified by driving the demo manually — the generated sample sheet is a deterministic fixture with
known dimensions and a real CSI spec page. A Playwright suite over that same fixture would close
this properly.
