# Plugin API

A plugin is an object with an `id` and a `setup(ctx)`. `setup` registers tools, actions, panels and
renderers, and subscribes to the bus. Nothing else is required.

```ts
import { definePlugin } from "@massingcloud/pdf-viewer";

export const myPlugin = definePlugin({
  id: "my-plugin",
  order: 50,            // lower sets up first; default 100
  setup(ctx) { /* … */ },
  teardown() { /* optional */ },
});
```

`ctx` gives you `viewer`, `bus`, `store`, the four `register*` functions, and `onCleanup`.

Install at construction (`new Viewer({ plugins: [...] })`), later (`await viewer.use(plugin)`), or
via `createViewer`, which installs the standard set in dependency order.

## Tools

A tool turns a pointer gesture into an annotation.

```ts
ctx.registerTool({
  id: "cloud",
  label: "Revision cloud",
  icon: "☁",
  group: "markup",       // toolbar grouping
  shortcut: "c",         // single key, no modifier
  kind: "cloud",         // the AnnotKind produced
  input: "poly",
  minPoints: 3,
  create: ({ points, page }) => ({ kind: "cloud", points, page, subject: "Revision" }),
});
```

### Input modes

| `input` | Gesture | Produces |
|---|---|---|
| `click` | one click | one point — pins, stamps, counts, text |
| `drag` | press, drag, release | two points — rects, lines, single measurements |
| `poly` | click per vertex; double-click or `Enter` to finish | n points — polygons, clouds, areas |
| `freehand` | pointer path while held | a simplified path — ink |

Shift during a `drag` or `poly` snaps to 15°.

### Other fields

- `maxPoints` — auto-commit once reached.
- `sticky` — stay active after committing (counts, stamps, pins). Default is to fall back to select.
- `needsCalibration` — the kernel refuses the commit and explains why if the page has no scale.
- `cursor`, `activate(viewer)`, `deactivate(viewer)`.

### `create`

Return an `AnnotationDraft`, or `null` to abort — which is how a tool that prompts for text handles
the user cancelling. It may be async. Omit it entirely and the kernel builds `{ kind, points, page }`.

The kernel computes `quantity` for measurement kinds after `create` returns, so tools do not each
re-implement measurement. Set `quantity` yourself only to override.

## Actions

A command, not a drawing mode.

```ts
ctx.registerAction({
  id: "review.approve",
  label: "Approve selected",
  icon: "✓",
  group: "review",
  enabled: (v) => v.store.selectedIds().length > 0,
  run(v) {
    v.store.updateMany(v.store.selected().map((a) => ({ id: a.id, patch: { status: "accepted" } })));
  },
});
```

`enabled` is re-evaluated whenever the toolbar rebuilds (selection, tool and store changes).

## Panels

```ts
ctx.registerPanel({
  id: "my-panel",
  title: "My panel",
  side: "right",      // or "left"
  order: 20,
  mount(host, viewer) {
    const el = document.createElement("div");
    host.appendChild(el);
    const off = viewer.on("annot:added", () => { /* re-render */ });
    return () => off();          // optional disposer
  },
});
```

Panels mount once per document load. Return a disposer to release subscriptions.

## Custom renderers

Only needed for a kind the default renderer doesn't cover.

```ts
ctx.registerRenderer({
  kinds: ["symbol"],
  render(annot, { el, zoom, selected }) {
    const r = 12 / zoom;                 // constant screen size
    return el("circle", {
      cx: annot.points[0]!.x, cy: annot.points[0]!.y, r,
      fill: selected ? "#4a8cff" : annot.style?.color ?? "#e2554a",
    });
  },
});
```

Emit **page-space** SVG. The overlay's `viewBox` handles zoom, so `width: 2` means 2 PDF points on
the sheet at every zoom level. Divide by `zoom` only for things that must stay a fixed size on
screen.

## Events

Subscribe with `ctx.bus.on(name, fn)` or `viewer.on(name, fn)`; both return an unsubscribe.

| Event | Payload | Fires when |
|---|---|---|
| `doc:loaded` | `{ name, pages, fingerprint }` | a document finished loading and laid out |
| `doc:closed` | — | the document was replaced or the viewer torn down |
| `page:changed` | `{ page }` | the most-visible page changed |
| `page:rendered` | `{ page, scale }` | a page finished painting |
| `view:changed` | `{ zoom, page, rotation }` | zoom, pan or rotation changed |
| `tool:changed` | `{ id }` | the active tool changed (`null` = select) |
| `annot:added` | `{ annot }` | a markup was created |
| `annot:updated` | `{ annot, before }` | a markup changed |
| `annot:removed` | `{ annot }` | a markup was deleted |
| `annot:reset` | `{ count }` | bulk replacement — re-read the whole store |
| `annot:selected` | `{ ids }` | the selection changed |
| `annot:activated` | `{ annot }` | double-clicked or opened from the list |
| `filter:changed` | `{ filter }` | the shared filter changed |
| `calibration:changed` | `{ calibration, page }` | a page's scale was set or cleared |
| `sheet:changed` | `{ meta }` | sheet metadata was set |
| `view:saved` | `{ view }` | a named view was saved |
| `sync:state` | `{ state, pending, message? }` | persistence state changed |
| `notice` | `{ level, message }` | anything worth telling the user |

Wire `notice` into your own toast system if you drop `toolbarPlugin`.

A handler that throws is logged and does not stop the others. Subscribing or unsubscribing during
dispatch is safe.

## Store

```ts
store.add(draft);                       // → Annotation
store.addMany(drafts);                  // one undo step
store.update(id, patch, { bump, undoable });
store.updateMany([{ id, patch }]);      // one undo step
store.remove(ids);
store.reset(annots, { undoable });
store.merge(incoming);                  // version-wins, the sync path

store.all(); store.onPage(n); store.visible(); store.visibleOnPage(n);
store.select(ids, additive); store.selected(); store.selectedIds();
store.setFilter(f); store.getFilter();
store.setCalibration(cal, page); store.calibration(page);
store.setSheet(meta); store.sheet(page); store.allSheets();
store.undo(); store.redo(); store.canUndo; store.canRedo; store.clearHistory();
```

`update` with `{ bump: false }` skips the version/`updatedAt` bump — use it for intermediate drag
frames so a gesture produces one logical revision rather than one per pointer move. `{ undoable:
false }` keeps a change out of the history entirely.

Locked annotations (`locked: true`) reject edits and deletes, but can still be unlocked.

## Adding a markup kind

1. Add it to `AnnotKind` in `core/types.ts`.
2. Register a tool that produces it.
3. Add a branch to `render/svg.ts` — or register a `KindRenderer`.
4. Add a branch to `io/flatten.ts` if it should survive a flatten.
5. Map it in `io/xfdf.ts` (`xfdfTag` and `kindFromTag`) if it should leave the tool.

Steps 4 and 5 are the ones that get forgotten, and the symptom is a markup that looks right on
screen and vanishes on export.

## Viewer surface

```ts
viewer.load(source, { keepMarkups });
viewer.setTool(id | null); viewer.runAction(id);
viewer.goToPage(n); viewer.goToAnnotation(annot, { zoom });
viewer.setZoom(z, anchor); viewer.zoomIn(); viewer.zoomOut();
viewer.fitWidth(); viewer.fitPage(); viewer.rotate(90);
viewer.hitTest(page, pt, tolerancePx);
viewer.clientToPage(clientX, clientY, page);
viewer.addAnnotation(draft);          // programmatic; also the scripting/test surface
viewer.recalculatePage(page);         // re-derive quantities after a calibration change
viewer.redraw(page?);
viewer.destroy();
```
