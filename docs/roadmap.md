# Roadmap

Measured against `massing_pdf_viewer_spec.md`. The point of this page is to be honest about the gap
between what the spec asks for and what exists, rather than to imply the spec is met.

## Built

| Spec area | State |
|---|---|
| §3 Navigation and viewing | Continuous scroll, tiled zoom for large sheets, rotation, fit modes, thumbnails, sheet index, page/sheet search. **No** split view or multi-tab sessions. |
| §4 Markup system | 22 kinds including real revision clouds, stamps, measurements, symbols. **No** photo/voice attachments (the schema carries them; no capture UI). |
| §5 Structured markup data | Complete — every field in the spec's list, plus provenance. |
| §6 Revision survival | Overlay compare, auto-alignment, diff clustering, auto-clouding. **No** markup migration or acceptance queue. |
| §8 Issues and tasks | Pins, status, assignee, due date, promote-to-issue, BCF mapping. **No** forms or daily reports. |
| §9 Offline-first | IndexedDB working copy, durable outbound queue, version-based merge. **No** conflict-resolution UI. |
| §10 Search | Filters and faceting over markups; text extraction per page. **No** cross-document index, no OCR. |
| Data model / interchange | JSON, XFDF, BCF topics, CSV, flattened PDF. **No** BCF `.bcfzip` packaging or ICDD. |
| Plugin architecture | Kernel + 10 plugins, stable extension points. |

## Not built

### Specifications workspace (spec §7)

The largest gap, and the spec's own strongest differentiator. Needs a spec-book viewer with section
hierarchy, clause-level anchors, markup on paragraphs, and drawing↔clause cross-links.

`AnnotLinks.spec` already models the link. What's missing is the spec-side half: a parser that
turns a CSI-numbered spec PDF into addressable clauses, and a panel to browse and cite them.

Roughly: a `specsPlugin` plus a clause extractor. The extractor is the hard part — spec formatting
varies enough between offices that heuristics will need a manual-correction path.

### Markup migration across a slip-sheet (spec §6)

`RevisionContext.migration` models the states (`ok` / `shifted` / `orphan` / `obsolete`) and compare
already computes the alignment offset. What's missing is applying it: translating markups by the
offset, flagging those whose underlying content changed, and a review queue for accepting or
re-placing them.

This is the highest-value next piece, because the alignment maths already exists.

### OCR and scanned-sheet support (spec §11)

`Provenance` is complete and `sheetsPlugin` degrades gracefully on sheets with no text layer, but
there is no OCR, no contrast inversion, no tracing overlay, and no transcription panel.

OCR needs a decision: server-side (a service call) or in-browser (Tesseract WASM, several MB). The
offline requirement argues for bundled WASM; the bundle size argues against it. Worth deciding
before building either.

### Attachments and field capture (spec §4, §9)

`AnnotAttachment` is in the schema; nothing captures or displays photos, video or voice notes. Needs
a media service contract on the adapter side and a capture UI on the field side.

### 4D/5D, digital twin, ICDD (spec Phase 3)

`AnnotLinks.ifcGuids` is the hook. Everything above it is unbuilt and depends on Massing's own
coordination surfaces.

## Known limitations

- **Text-layer markups** (highlight, strikeout, underline) are geometric boxes, not glyph-anchored
  selections. Marking up a specification properly needs the latter.
- **Compare handles translation only** — not rotation or scale. Sheets re-issued at a different
  size, or scans with a slight skew, will not align. A similarity transform is the fix; the search
  cost grows with the extra parameters, so it likely needs a proper phase-correlation approach
  rather than the current pyramid brute force.
- **The toolbar rebuilds wholesale** on selection change. Fine at this scale; would need
  finer-grained updates if the tool count grew a lot.
- **No virtualisation in the markup list.** A sheet with thousands of markups will render thousands
  of rows.
- **Prompts default to `window.prompt`.** Every plugin taking user text accepts a `promptText`
  override, and a host should pass one — the default exists so the library works standalone, not
  because it is good.

## Testing gaps

120 unit tests cover geometry, units, the store and interchange. Not covered:

- The pointer gesture loop (drag, poly, vertex edit) — needs a browser-driven test, since
  `happy-dom` has no layout and pdf.js needs `requestAnimationFrame`.
- Tiled rasterisation at high zoom.
- The compare pipeline end to end.
- `IndexedDbAdapter` and `OfflineAdapter` queue drain / retry behaviour.

A Playwright suite driving the demo would close most of this, and the demo's generated sample sheet
already provides a deterministic fixture with known dimensions to assert against.
