# Contributing

```bash
npm install
npm run dev      # demo at :5173
npm run check     # typecheck + lint + unit tests — run before opening a PR
npm run test:e2e  # browser suite; needs Node 20.6+ for Playwright's ESM loader
```

Node 18.18+ locally; CI runs 20 and 22.

## Where things go

The kernel (`src/core`) owns mechanism: rendering, coordinates, selection, the store, the event bus.
Anything with a domain opinion — what a revision cloud means, how a takeoff rolls up, what a punch
pin does — is a plugin.

If you're about to add a domain concept to `core/`, that's the signal it should be a plugin instead.

Plugins must not import each other. Cross-plugin communication goes through the event bus or a
registry; that constraint is what keeps the extension points real.

## Adding a markup kind

Five places, and the last two are the ones that get forgotten:

1. `core/types.ts` — add to `AnnotKind`.
2. A plugin — register a `ToolDef` producing it.
3. `render/svg.ts` — a branch in `drawAnnotation` (or register a `KindRenderer`).
4. `io/flatten.ts` — a branch, if it should survive being burned into a PDF.
5. `io/xfdf.ts` — `xfdfTag` and `kindFromTag`, if it should leave the tool.

Skip 4 and 5 and the markup looks right on screen and silently disappears on export.

## Tests

`npm test`. Unit tests live in `test/` and cover the parts where correctness is load-bearing and
cheap to verify: geometry and measurement maths, unit parsing and formatting, store semantics
(mutation, undo, merge), and interchange round trips.

Test the behaviour, not the implementation. A test that asserts an SVG attribute string will break
on every cosmetic change and catch nothing; a test that asserts a 1296pt line at `1/8" = 1'-0"`
measures `144'-0"` will catch a real regression.

If you're changing measurement, scale or coordinate code, add a case with a value you can verify by
hand — ideally one where symmetry or a printed dimension makes the expected answer checkable by
inspection rather than by trusting the implementation.

Rendering, gestures, compare and the IndexedDB adapters live in `e2e/` and run under Playwright,
because `happy-dom` has no layout and pdf.js schedules its renders on `requestAnimationFrame`, which
never fires without a compositor — in a headless DOM every render just hangs.

Those tests drive real mouse events and assert on real pixels. If you are adding a tool, add a
gesture test; `e2e/helpers.ts` converts page-space coordinates to client coordinates so a test reads
as "drag from here to there on the drawing".

## Style

Match the surrounding code. Some things that are deliberate rather than accidental:

- Comments explain *why*, especially where a simpler-looking approach is wrong. If you remove a
  guard, check whether a comment explains what it's guarding against.
- `!` is used where an index is provably in bounds; `noUncheckedIndexedAccess` forces the thought at
  each site.
- Geometry is emitted in page space. Only affordances that must stay a fixed size on screen
  (handles, pin badges, hit tolerance) divide by zoom.
- Prompts take a `promptText` override. The `window.prompt` default exists so the library works
  standalone, not because it's good.

## Commits and PRs

Explain what changed and why. If you fixed a bug, say what the symptom was — that's the part that
helps the next person recognise it.

Run `npm run check` first. CI runs the same thing on two Node versions plus both builds.
