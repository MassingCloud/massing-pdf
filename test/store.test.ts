import { describe, expect, it, vi } from "vitest";
import { AnnotationStore, makeId } from "../src/core/store";
import { EventBus } from "../src/core/events";
import type { Annotation, AnnotationDraft } from "../src/core/types";

const PAGE = { width: 612, height: 792 };

function build() {
  const bus = new EventBus();
  const store = new AnnotationStore({
    bus,
    author: () => "A. Reviewer",
    org: () => "Massing",
    pageSize: () => PAGE,
  });
  return { bus, store };
}

const rect = (over: Partial<AnnotationDraft> = {}): AnnotationDraft => ({
  kind: "rect",
  page: 1,
  points: [{ x: 100, y: 200 }, { x: 300, y: 400 }],
  ...over,
});

describe("materialisation", () => {
  it("fills identity, authorship and defaults", () => {
    const { store } = build();
    const a = store.add(rect())!;
    expect(a.id).toMatch(/^an_/);
    expect(a.author).toBe("A. Reviewer");
    expect(a.org).toBe("Massing");
    expect(a.status).toBe("open");
    expect(a.version).toBe(1);
    expect(a.createdAt).toBeTruthy();
  });

  it("derives the page-normalised anchor from the first point", () => {
    const { store } = build();
    const a = store.add(rect())!;
    expect(a.nx).toBeCloseTo(100 / PAGE.width, 9);
    expect(a.ny).toBeCloseTo(200 / PAGE.height, 9);
  });

  it("copies the caller's points rather than aliasing them", () => {
    const { store } = build();
    const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
    const a = store.add({ kind: "rect", page: 1, points })!;
    points[0]!.x = 999;
    expect(a.points[0]!.x).toBe(1);
    expect(store.get(a.id)!.points[0]!.x).toBe(1);
  });

  it("does not let an explicit undefined punch through a default", () => {
    const { store } = build();
    const a = store.add({ ...rect(), status: undefined, author: undefined })!;
    expect(a.status).toBe("open");
    expect(a.author).toBe("A. Reviewer");
  });

  it("honours an explicit id and status", () => {
    const { store } = build();
    const a = store.add(rect({ id: "fixed-1", status: "resolved" }))!;
    expect(a.id).toBe("fixed-1");
    expect(a.status).toBe("resolved");
  });
});

describe("events", () => {
  it("emits exactly one add event per markup", () => {
    const { bus, store } = build();
    const spy = vi.fn();
    bus.on("annot:added", spy);
    store.add(rect())!;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("emits an update carrying both the before and after records", () => {
    const { bus, store } = build();
    const a = store.add(rect())!;
    const spy = vi.fn();
    bus.on("annot:updated", spy);
    store.update(a.id, { subject: "Check dimension" });
    expect(spy).toHaveBeenCalledTimes(1);
    const { annot, before } = spy.mock.calls[0]![0] as { annot: Annotation; before: Annotation };
    expect(before.subject).toBeUndefined();
    expect(annot.subject).toBe("Check dimension");
  });

  it("survives a handler that throws, and still notifies the rest", () => {
    const { bus, store } = build();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    bus.on("annot:added", () => { throw new Error("boom"); });
    bus.on("annot:added", good);
    store.add(rect())!;
    expect(good).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("lets a handler unsubscribe during dispatch without skipping others", () => {
    const { bus, store } = build();
    const later = vi.fn();
    const off = bus.on("annot:added", () => off());
    bus.on("annot:added", later);
    store.add(rect())!;
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe("updates", () => {
  it("bumps the version and updatedAt by default", async () => {
    const { store } = build();
    const a = store.add(rect())!;
    await new Promise((r) => setTimeout(r, 2));
    const b = store.update(a.id, { note: "hi" })!;
    expect(b.version).toBe(2);
    expect(b.updatedAt! >= a.updatedAt!).toBe(true);
  });

  it("can suppress the version bump for intermediate drag frames", () => {
    const { store } = build();
    const a = store.add(rect())!;
    const b = store.update(a.id, { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }, { bump: false })!;
    expect(b.version).toBe(1);
  });

  it("recomputes the normalised anchor when geometry moves", () => {
    const { store } = build();
    const a = store.add(rect())!;
    const b = store.update(a.id, { points: [{ x: 306, y: 396 }, { x: 400, y: 500 }] })!;
    expect(b.nx).toBeCloseTo(0.5, 6);
    expect(b.ny).toBeCloseTo(0.5, 6);
  });

  it("refuses to edit a locked markup", () => {
    const { store } = build();
    const a = store.add(rect({ locked: true }))!;
    store.update(a.id, { subject: "nope" });
    expect(store.get(a.id)!.subject).toBeUndefined();
  });

  it("refuses to delete a locked markup", () => {
    const { store } = build();
    const a = store.add(rect({ locked: true }))!;
    expect(store.remove(a.id)).toHaveLength(0);
    expect(store.size).toBe(1);
  });

  it("still allows unlocking a locked markup", () => {
    const { store } = build();
    const a = store.add(rect({ locked: true }))!;
    store.update(a.id, { locked: false });
    expect(store.get(a.id)!.locked).toBe(false);
  });
});

describe("selection", () => {
  it("replaces the selection by default and extends when additive", () => {
    const { store } = build();
    const a = store.add(rect())!;
    const b = store.add(rect())!;
    store.select(a.id);
    expect(store.selectedIds()).toEqual([a.id]);
    store.select(b.id, true);
    expect(store.selectedIds().sort()).toEqual([a.id, b.id].sort());
    store.select(b.id, true);                       // additive on an already-selected id toggles it off
    expect(store.selectedIds()).toEqual([a.id]);
  });

  it("drops a deleted markup from the selection", () => {
    const { store } = build();
    const a = store.add(rect())!;
    store.select(a.id);
    store.remove(a.id);
    expect(store.selectedIds()).toEqual([]);
  });

  it("ignores ids that are not in the store", () => {
    const { store } = build();
    store.select("nonexistent");
    expect(store.selectedIds()).toEqual([]);
  });
});

describe("undo and redo", () => {
  it("reverses an add", () => {
    const { store } = build();
    store.add(rect())!;
    expect(store.size).toBe(1);
    store.undo();
    expect(store.size).toBe(0);
    store.redo();
    expect(store.size).toBe(1);
  });

  it("reverses a delete", () => {
    const { store } = build();
    const a = store.add(rect())!;
    store.remove(a.id);
    store.undo();
    expect(store.get(a.id)).toBeDefined();
  });

  it("reverses an update to the prior field values", () => {
    const { store } = build();
    const a = store.add(rect({ subject: "first" }))!;
    store.update(a.id, { subject: "second" });
    store.undo();
    expect(store.get(a.id)!.subject).toBe("first");
  });

  it("treats a bulk add as one step", () => {
    const { store } = build();
    store.addMany([rect(), rect(), rect()]);
    expect(store.size).toBe(3);
    store.undo();
    expect(store.size).toBe(0);
  });

  it("forks the timeline: a new edit clears the redo stack", () => {
    const { store } = build();
    store.add(rect())!;
    store.undo();
    expect(store.canRedo).toBe(true);
    store.add(rect())!;
    expect(store.canRedo).toBe(false);
  });

  it("does not record undo steps for changes made while replaying", () => {
    const { store } = build();
    store.add(rect())!;
    store.undo();
    store.redo();
    store.undo();
    expect(store.size).toBe(0);
    expect(store.canUndo).toBe(false);
  });

  it("caps the history at the configured limit", () => {
    const bus = new EventBus();
    const store = new AnnotationStore({
      bus, author: () => "x", pageSize: () => PAGE, undoLimit: 3,
    });
    for (let i = 0; i < 6; i++) store.add(rect())!;
    let undone = 0;
    while (store.canUndo) { store.undo(); undone++; }
    expect(undone).toBe(3);
  });
});

describe("merge", () => {
  const remote = (id: string, version: number, subject: string): Annotation => ({
    id, kind: "rect", sheetId: "1", page: 1,
    points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    author: "Someone Else", createdAt: new Date().toISOString(), version, status: "open", subject,
  });

  it("adds records it has never seen", () => {
    const { store } = build();
    const result = store.merge([remote("r1", 1, "theirs")]);
    expect(result).toEqual({ added: 1, updated: 0 });
    expect(store.get("r1")!.subject).toBe("theirs");
  });

  it("lets a newer remote version win", () => {
    const { store } = build();
    store.merge([remote("r1", 1, "v1")]);
    store.merge([remote("r1", 2, "v2")]);
    expect(store.get("r1")!.subject).toBe("v2");
  });

  it("keeps the local record when the remote version is older or equal", () => {
    const { store } = build();
    store.merge([remote("r1", 3, "local-newer")]);
    const result = store.merge([remote("r1", 2, "stale")]);
    expect(result).toEqual({ added: 0, updated: 0 });
    expect(store.get("r1")!.subject).toBe("local-newer");
  });
});

describe("calibration and sheets", () => {
  it("falls back from a page calibration to the document default", () => {
    const { store } = build();
    store.setCalibration({ unitsPerPoint: 0.1, unit: "m", source: "preset", page: 0 }, 0);
    expect(store.calibration(7)!.unitsPerPoint).toBe(0.1);
    store.setCalibration({ unitsPerPoint: 0.5, unit: "m", source: "measured", page: 7 }, 7);
    expect(store.calibration(7)!.unitsPerPoint).toBe(0.5);
    expect(store.calibration(8)!.unitsPerPoint).toBe(0.1);
  });

  it("keeps the sheet register sorted by page", () => {
    const { store } = build();
    store.setSheet({ sheetId: "A-202", page: 2 });
    store.setSheet({ sheetId: "A-201", page: 1 });
    expect(store.allSheets().map((s) => s.page)).toEqual([1, 2]);
  });
});

describe("makeId", () => {
  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => makeId()));
    expect(ids.size).toBe(500);
  });
});
