# Data model

The premise: **a markup is a record, not ink.** Rendering is one projection of it; XFDF, BCF, CSV
and a flattened PDF are others. Nothing in the viewer stores presentation-only state that cannot
round-trip.

## `Annotation`

```ts
interface Annotation {
  // identity
  id: string;
  kind: AnnotKind;
  sheetId: string;        // sheet number where known — markups follow the sheet across re-issues
  page: number;           // 1-based

  // geometry — page space: PDF points, top-left origin, unrotated
  points: Pt[];
  rotation?: number;
  nx?: number; ny?: number;   // 0..1 anchor within the page box (derived)

  // authorship
  author: string;
  org?: string;
  createdAt: string;      // ISO 8601
  updatedAt?: string;
  version: number;        // optimistic-concurrency token for sync

  // classification
  subject?: string;       // short title, shows in the markup list
  note?: string;          // the comment
  text?: string;          // text rendered *on the sheet* (text/stamp/callout)
  status: AnnotStatus;
  priority?: AnnotPriority;
  discipline?: Discipline;
  trade?: string;
  labels?: string[];
  locked?: boolean;

  // payload
  quantity?: Quantity;
  style?: AnnotStyle;
  replies?: AnnotReply[];
  attachments?: AnnotAttachment[];
  links?: AnnotLinks;
  revision?: RevisionContext;
  provenance?: Provenance;
  ext?: Record<string, unknown>;   // host-specific; round-trips through every adapter untouched
}
```

### Why `sheetId` is separate from `page`

A plan set gets re-issued as a new PDF with pages inserted and removed. Keying markups to a page
number means they land on the wrong drawing after the next issue. Keying to the sheet number (`A-201`)
means they follow the sheet. `sheetIdFor` on `ViewerOptions` supplies the mapping; without it,
`sheetId` falls back to the page number.

### Why `nx`/`ny`

A page-normalised anchor lets a completely different renderer place the same markup: Massing's SVG
sheet viewer, a mobile canvas, or the same sheet re-plotted at ARCH D instead of ARCH C. It is
derived by the store from `points[0]` and kept consistent on every geometry change.

### Why `version`

Sync merges by version, not by timestamp. Clocks disagree between a field tablet and a server; a
monotonic per-record counter does not. `merge()` accepts a remote record only when its version is
genuinely newer, so a colleague's save cannot clobber a local edit in progress.

## Kinds

```
shapes        rect ellipse polygon polyline line arrow cloud ink
text          text callout highlight strikeout underline
construction  stamp pin symbol
measurement   distance perimeter area count angle radius volume
```

`POINT_KINDS` (text, stamp, pin, count, symbol) are anchored by a single point and get a larger hit
target. `MEASURE_KINDS` carry a calibrated `Quantity`.

## `Quantity`

```ts
interface Quantity {
  value: number;
  unit: string;        // "m", "ft", "m²", "ea", "°"
  raw?: number;        // geometric magnitude in page units, BEFORE calibration
  depth?: number;      // for volume
  assembly?: string;   // takeoff bucket — assembly, cost code, trade package
}
```

`raw` is the important one. Keeping the pre-calibration magnitude means **re-calibrating a page
re-derives every measurement on it** rather than forcing the estimator to re-draw them. Areas scale
by the square of the factor, volumes by the cube times depth; `recalculate()` handles it.

## `Calibration`

```ts
interface Calibration {
  unitsPerPoint: number;                  // real-world units per PDF point
  unit: string;
  label?: string;                         // `1/4" = 1'-0"` when it matches a standard scale
  source: "preset" | "measured" | "imported" | "declared";
  page: number;                           // 0 = document default
}
```

Per page, because a plan sheet and its enlarged detail are different scales. `store.calibration(n)`
falls back from the page to the document default.

`source` matters for trust: a named preset is exact; a hand-drawn line is as accurate as the hand
that drew it. A measured calibration landing within 1.5% of a standard scale is labelled with that
scale, so a reviewer sees `≈ 1/8" = 1'-0"` rather than a raw ratio.

### Scale arithmetic

A PDF point is 1/72". At `1/4" = 1'-0"`, one plotted inch is 4 feet, so `unitsPerPoint = 4/72`. At
`1:100`, one plotted mm is 100mm, and a point is 25.4/72 mm, so `unitsPerPoint = (100 × 25.4/72)/1000` m.

## `AnnotLinks`

A markup is a join table between the sheet and the rest of the project.

```ts
interface AnnotLinks {
  issueId?: string;                                        // RFI / punch / BCF topic GUID
  spec?: { section: string; clause?: string; documentId?: string };
  ifcGuids?: string[];                                     // IFC GlobalIds, never viewer ids
  relatedAnnotIds?: string[];
  record?: { module: string; id: string };                 // any host record
}
```

`ifcGuids` follows Massing's non-negotiable: model elements are addressed by IFC GlobalId, never by
transient viewer ids.

## `RevisionContext`

```ts
interface RevisionContext {
  rev?: string;                                            // revision the markup was drawn against
  carriedFrom?: string;                                    // set when a slip-sheet migrates it
  migration?: "ok" | "shifted" | "orphan" | "obsolete";
  migratedBy?: string; migratedAt?: string;
}
```

`migration` is the acceptance queue's state: geometry still matches, it was relocated, it needs a
human to re-place it, or the content it referenced is gone. The compare plugin populates `rev` on
auto-generated change clouds; **the full migration workflow is designed for but not implemented** —
see [roadmap.md](roadmap.md).

## `Provenance`

Archival and scanned sheets, treated as first-class rather than an edge case.

```ts
interface Provenance {
  archive?: string; collection?: string; sourceRef?: string;
  scanDpi?: number; drawnDate?: string; architect?: string;
  confidence?: "certain" | "probable" | "uncertain" | "illegible";
  transcript?: string;                                     // verbatim handwritten note
}
```

`confidence` is the field that makes measured-drawing work honest: a dimension read off a
medium-resolution scan of a century-old drawing is not the same claim as one read off a CAD export,
and the record should say so.

## `SheetMeta`

```ts
interface SheetMeta {
  sheetId: string; page: number;
  number?: string;        // "A-201"
  title?: string;         // "SECOND FLOOR PLAN"
  discipline?: Discipline;
  kind?: SheetKind;       // plan | elevation | section | detail | schedule | spec | historic | …
  revision?: string; issueDate?: string; scaleLabel?: string; package?: string;
  provenance?: Provenance;
}
```

Populated by `sheetsPlugin` from the title block, or supplied by the host's drawing register — which
should win, since a project that already knows its drawing list should not have it guessed.

Discipline is inferred from the sheet-number prefix (US National CAD Standard: A architectural,
S structural, M mechanical, …); `kind` from words in the title.

## Filtering

```ts
interface AnnotFilter {
  kinds?; status?; discipline?; authors?; labels?; pages?;
  query?;                  // substring over subject / note / text / author / trade / labels
  since?; until?;          // ISO
  hasIssue?: boolean;
}
```

Facets AND together; values within a facet OR. One predicate serves the overlay, the list, the
reports and every export — "export what I'm looking at" is only trustworthy if they agree.

## Interchange fidelity

| Target | Carries | Loses |
|---|---|---|
| JSON markup set | everything, plus calibrations and the sheet register | — |
| XFDF | geometry, comments, replies, colour; the rest in a `<massing:record>` payload | the payload, if a third-party tool rewrites the file |
| BCF topic | title, status, priority, assignee, due date, labels, replies-as-comments, a decodable sheet anchor; quantity and IFC links folded into the description | geometry beyond the anchor point |
| CSV | every scalar field, quantity as formatted + raw + unit | geometry, replies (count only) |
| flattened PDF | pixels, plus an appended markup schedule | everything structured |

BCF GUIDs must be canonical UUIDs. Ids minted here are prefixed (`an_…`), so `normaliseGuid`
derives a stable, RFC-4122-shaped GUID by hashing when the id is not already a UUID — rather than
rejecting it.
