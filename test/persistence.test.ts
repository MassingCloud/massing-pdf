import { describe, expect, it, vi } from "vitest";
import { persistencePlugin } from "../src/plugins/persistence";
import { ConflictError, type Mutation, type StorageAdapter } from "../src/adapters/types";
import { AnnotationStore } from "../src/core/store";
import { EventBus } from "../src/core/events";
import type { PluginContext } from "../src/core/plugin";
import type { Viewer } from "../src/core/viewer";
import type { Annotation } from "../src/core/types";

/**
 * The save queue, and what happens to it when a write is rejected.
 *
 * A rejected batch is where markups go missing quietly: the server stored nothing, but the local
 * store still shows every edit, so the only visible symptom is a colleague not seeing your work.
 * These drive the plugin through the bus, which is the whole of its input.
 */

const DEBOUNCE = 5;

/**
 * Everything the plugin touches: a real bus and store, and a viewer stub for `redraw`.
 *
 * Waits for `markups:restored` before handing the store back. Restore resolves on a microtask and
 * calls `store.reset`, so anything written before it lands is wiped — the same trap the event
 * exists to close for hosts.
 */
async function harness(adapter: StorageAdapter, opts: Partial<Parameters<typeof persistencePlugin>[0]> = {}) {
  const bus = new EventBus();
  const store = new AnnotationStore({
    bus,
    author: () => "A. Reviewer",
    pageSize: () => ({ width: 1000, height: 800 }),
  });
  const notices: string[] = [];
  const syncStates: { state: string; pending: number }[] = [];
  bus.on("notice", ({ message }) => notices.push(message));
  bus.on("sync:state", ({ state, pending }) => syncStates.push({ state, pending }));

  const ctx = {
    viewer: { redraw() { /* no canvas in a unit test */ } } as unknown as Viewer,
    bus,
    store,
    registerTool() {}, registerAction() {}, registerPanel() {}, registerRenderer() {},
    onCleanup() {},
  } as unknown as PluginContext;

  persistencePlugin({
    adapter,
    key: () => ({ documentId: "doc-1" }),
    debounceMs: DEBOUNCE,
    ...opts,
  }).setup(ctx);

  const restored = new Promise<void>((resolve) => { bus.on("markups:restored", () => resolve()); });
  bus.emit("doc:loaded", { name: "d", pages: 1, fingerprint: "fp" });
  await restored;
  return { bus, store, notices, syncStates };
}

/** Wait past the debounce window and let the save promise chain settle. */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, DEBOUNCE * 2));
};

/** Poll until `ready`, so a test never depends on how many timer rounds a retry happens to need. */
const until = async (ready: () => boolean, ms = 4000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, DEBOUNCE));
  }
};

/** An adapter that records every batch and can be told to reject the next one. */
function recordingAdapter(reject?: () => unknown) {
  const batches: Mutation[][] = [];
  let rejectOnce = Boolean(reject);
  const adapter: StorageAdapter = {
    id: "stub",
    async load() { return { annotations: [] }; },
    async save(_key, mutations) {
      batches.push([...mutations]);
      if (rejectOnce && reject) { rejectOnce = false; throw reject(); }
    },
  };
  return { adapter, batches };
}

const upserted = (batch: Mutation[] | undefined) =>
  (batch ?? []).filter((m): m is Extract<Mutation, { op: "upsert" }> => m.op === "upsert");

const rect = (subject: string) => ({
  kind: "rect" as const, page: 1, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], subject,
});

describe("the save queue", () => {
  it("coalesces edits and sends one batch", async () => {
    const { adapter, batches } = recordingAdapter();
    const { store } = await harness(adapter);
    const a = store.add(rect("one"))!;
    store.update(a.id, { subject: "two" });
    await settle();
    expect(batches).toHaveLength(1);
    expect(upserted(batches[0])).toHaveLength(1);
  });

  it("puts the batch back when the network fails, rather than dropping it", async () => {
    // Nothing reached the server, so a queue that clears itself loses the edit permanently — the
    // markup still renders locally, so nothing looks wrong until someone else opens the sheet.
    const { adapter, batches } = recordingAdapter(() => new Error("network down"));
    const { store } = await harness(adapter);
    store.add(rect("survives a failure"))!;
    await until(() => batches.length > 1);

    const resent = batches.slice(1).flatMap((b) => upserted(b)).map((m) => m.annot.subject);
    expect(resent).toContain("survives a failure");
  });
});

describe("a rejected write", () => {
  /** A 409 naming `id`, optionally carrying the server's copy. */
  const conflict = (id: string, theirs?: Annotation) =>
    new ConflictError([{ id, ...(theirs ? { theirs } : {}) }]);

  it("does not discard the other edits in the same batch", async () => {
    // The server rejects the whole request, so an unnamed markup was not stored either.
    let mine: Annotation | undefined;
    const { adapter, batches } = recordingAdapter(() => conflict(mine!.id, { ...mine!, version: 9, subject: "theirs" }));
    const { store } = await harness(adapter);

    mine = store.add(rect("conflicted"))!;
    store.update(mine.id, { subject: "my edit" });
    const other = store.add(rect("innocent bystander"))!;
    await settle();

    // The restored batch retries by itself; the bystander must reach the server on one of them.
    expect(batches.length).toBeGreaterThan(1);
    const everSent = batches.slice(1).flatMap((b) => upserted(b)).map((m) => m.annot.id);
    expect(everSent).toContain(other.id);
  });

  it("does not discard a calibration batched with it", async () => {
    let mine: Annotation | undefined;
    const { adapter, batches } = recordingAdapter(() => conflict(mine!.id));
    const { store } = await harness(adapter);

    mine = store.add(rect("conflicted"))!;
    store.setCalibration(
      { page: 1, unitsPerPoint: 1 / 6, unit: "ft", source: "preset", label: '1/8" = 1\'-0"' }, 1);
    await settle();

    expect(batches.length).toBeGreaterThan(1);
    const metas = batches.slice(1).flatMap((b) => b.filter((m) => m.op === "calibration"));
    expect(metas).toHaveLength(1);
  });

  it("keeps the server's copy by default, and stops resending the local edit", async () => {
    let mine: Annotation | undefined;
    const { adapter } = recordingAdapter(() => conflict(mine!.id, { ...mine!, version: 9, subject: "theirs" }));
    const { store } = await harness(adapter);

    mine = store.add(rect("conflicted"))!;
    store.update(mine.id, { subject: "my edit" });
    await settle();

    expect(store.get(mine.id)?.subject).toBe("theirs");
  });

  it("re-applies the local edit on top of theirs when asked to keep mine", async () => {
    let mine: Annotation | undefined;
    const { adapter } = recordingAdapter(() => conflict(mine!.id, { ...mine!, version: 9, subject: "theirs" }));
    const { store } = await harness(adapter, { onConflictResolve: "mine" });

    mine = store.add(rect("conflicted"))!;
    store.update(mine.id, { subject: "my edit" });
    await settle();

    const now = store.get(mine.id);
    expect(now?.subject).toBe("my edit");
    // Rebased onto their version, so the retry carries a base the server will accept.
    expect(now?.version).toBe(10);
  });

  it("still keeps the local edit when the server says nothing about its own copy", async () => {
    // A bodyless 409 leaves `theirs` undefined. Discarding the resolution here would silently
    // throw away work the caller explicitly chose to keep.
    let mine: Annotation | undefined;
    const { adapter, batches } = recordingAdapter(() => conflict(mine!.id));
    const { store } = await harness(adapter, { onConflictResolve: "mine" });

    mine = store.add(rect("conflicted"))!;
    store.update(mine.id, { subject: "my edit" });
    await settle();

    expect(store.get(mine.id)?.subject).toBe("my edit");
    const resent = batches.slice(1).flatMap((b) => upserted(b)).map((m) => m.annot.id);
    expect(resent).toContain(mine.id);
  });

  it("does not throw away an answer it just asked the host for", async () => {
    let mine: Annotation | undefined;
    const { adapter, batches } = recordingAdapter(() => conflict(mine!.id));
    const onConflict = vi.fn(async (c: { mine?: Annotation }) => c.mine ?? null);
    const { store } = await harness(adapter, { onConflictResolve: "ask", onConflict });

    mine = store.add(rect("conflicted"))!;
    store.update(mine.id, { subject: "my edit" });
    await settle();

    expect(onConflict).toHaveBeenCalledOnce();
    expect(store.get(mine.id)?.subject).toBe("my edit");
    expect(batches.slice(1).flatMap((b) => upserted(b)).map((m) => m.annot.id)).toContain(mine.id);
  });

  it("accepts the server's copy when the host answers null", async () => {
    let mine: Annotation | undefined;
    const { adapter } = recordingAdapter(() => conflict(mine!.id, { ...mine!, version: 9, subject: "theirs" }));
    const { store } = await harness(adapter, { onConflictResolve: "ask", onConflict: async () => null });

    mine = store.add(rect("conflicted"))!;
    store.update(mine.id, { subject: "my edit" });
    await settle();

    expect(store.get(mine.id)?.subject).toBe("theirs");
  });
});
