import { afterEach, describe, expect, it } from "vitest";
import { MemoryPresenceChannel, resetMemoryPresence, LEASE } from "../src/adapters/presence";
import { collabPlugin } from "../src/plugins/collab";
import { AnnotationStore } from "../src/core/store";
import { EventBus } from "../src/core/events";
import type { PluginContext } from "../src/core/plugin";
import type { Viewer } from "../src/core/viewer";

/**
 * Presence and advisory locking.
 *
 * The properties worth pinning are the ones docs/realtime.md argues for, because they are the ones
 * that are cheap to write wrong: a lock never reaches the annotation record, expiry is decided by
 * the granting side rather than the holder, and losing a lease is reported rather than swallowed.
 */

const KEY = { documentId: "doc-1" };

afterEach(() => { resetMemoryPresence(); });

describe("the in-process presence channel", () => {
  it("shows both people to each other", async () => {
    const ch = new MemoryPresenceChannel();
    const a = await ch.join(KEY, { id: "u1", name: "Ana" });
    const b = await ch.join(KEY, { id: "u2", name: "Ben" });

    let seenByA: string[] = [];
    a.onParticipants((p) => { seenByA = p.map((x) => x.name); });
    expect(seenByA.sort()).toEqual(["Ana", "Ben"]);

    b.leave();
    expect(seenByA.sort()).toEqual(["Ana"]);
  });

  it("keeps documents apart", async () => {
    const ch = new MemoryPresenceChannel();
    const a = await ch.join({ documentId: "one" }, { id: "u1", name: "Ana" });
    await ch.join({ documentId: "two" }, { id: "u2", name: "Ben" });
    let seen: string[] = [];
    a.onParticipants((p) => { seen = p.map((x) => x.name); });
    expect(seen).toEqual(["Ana"]);
  });

  it("grants a lock to one holder at a time", async () => {
    const ch = new MemoryPresenceChannel();
    const a = await ch.join(KEY, { id: "u1", name: "Ana" });
    const b = await ch.join(KEY, { id: "u2", name: "Ben" });

    expect(await a.acquire("an_1")).not.toBeNull();
    expect(await b.acquire("an_1")).toBeNull();

    a.release("an_1");
    expect(await b.acquire("an_1")).not.toBeNull();
  });

  it("only reports locks held by other people", async () => {
    const ch = new MemoryPresenceChannel();
    const a = await ch.join(KEY, { id: "u1", name: "Ana" });
    const b = await ch.join(KEY, { id: "u2", name: "Ben" });

    let mine = new Map<string, unknown>();
    a.onLocks((l) => { mine = l; });
    await a.acquire("an_1");
    // My own lock is not an obstacle to me, and showing it as one would be a lie on screen.
    expect([...mine.keys()]).toEqual([]);

    await b.acquire("an_2");
    expect([...mine.keys()]).toEqual(["an_2"]);
  });

  it("expires a lease on the granting side, not the holder's", async () => {
    let now = 1_000;
    const ch = new MemoryPresenceChannel(() => now);
    const a = await ch.join(KEY, { id: "u1", name: "Ana" });
    const b = await ch.join(KEY, { id: "u2", name: "Ben" });

    await a.acquire("an_1");
    expect(await b.acquire("an_1")).toBeNull();

    // Ana's tab was killed: no release is ever sent. `beforeunload` does not fire on a crash, which
    // is exactly why the grant carries a deadline rather than trusting a goodbye.
    now += LEASE.ttlMs + 1;
    expect(await b.acquire("an_1")).not.toBeNull();
  });

  it("reports a renewal that lost the lock rather than re-granting it", async () => {
    let now = 1_000;
    const ch = new MemoryPresenceChannel(() => now);
    const a = await ch.join(KEY, { id: "u1", name: "Ana" });
    const b = await ch.join(KEY, { id: "u2", name: "Ben" });

    await a.acquire("an_1");
    now += LEASE.ttlMs + 1;
    await b.acquire("an_1");

    // Ana must find out. She may be mid-edit on a markup that is no longer hers, and a silent
    // re-grant would hand her a 409 later as the first sign.
    expect(await a.renew("an_1")).toBeNull();
  });

  it("drops the locks of someone who leaves", async () => {
    const ch = new MemoryPresenceChannel();
    const a = await ch.join(KEY, { id: "u1", name: "Ana" });
    const b = await ch.join(KEY, { id: "u2", name: "Ben" });
    await a.acquire("an_1");
    a.leave();
    expect(await b.acquire("an_1")).not.toBeNull();
  });
});

describe("the collab plugin", () => {
  function harness(enforce = false) {
    const bus = new EventBus();
    const store = new AnnotationStore({
      bus, author: () => "Ana", pageSize: () => ({ width: 1000, height: 800 }),
    });
    const root = document.createElement("div");
    const notices: string[] = [];
    bus.on("notice", ({ message }) => notices.push(message));

    const viewer = {
      bus, store, el: { root }, numPages: 1, page: 1,
      doc: { fingerprint: "doc-1" },
      announce() {}, redraw() {}, goToAnnotation() { return Promise.resolve(); },
    } as unknown as Viewer;

    const ctx = {
      viewer, bus, store,
      registerTool() {}, registerAction() {}, registerPanel() {}, registerRenderer() {},
      onCleanup() {},
    } as unknown as PluginContext;

    collabPlugin({
      channel: new MemoryPresenceChannel(),
      self: { id: "u1", name: "Ana" },
      ...(enforce ? { enforce: true } : {}),
    }).setup(ctx);

    return { viewer, bus, store, notices, root };
  }

  /** The plugin joins on `doc:loaded`, which resolves a microtask later. */
  const joined = async (h: ReturnType<typeof harness>) => {
    h.bus.emit("doc:loaded", { name: "d", pages: 1, fingerprint: "doc-1" });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return h;
  };

  it("joins the document and reports itself present", async () => {
    const h = await joined(harness());
    expect(h.viewer.collab!.participants().map((p) => p.name)).toEqual(["Ana"]);
  });

  it("claims a lease when a markup is selected and lets go when it is not", async () => {
    const h = await joined(harness());
    const a = h.store.add({ kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })!;

    h.store.select(a.id);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Selection is the honest signal for "about to edit": waiting for the first modification would
    // announce intent only after the edit exists, which is the lateness this is for.
    expect(h.viewer.collab!.held()).toEqual([a.id]);

    h.store.select(null);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.viewer.collab!.held()).toEqual([]);
  });

  it("never writes a lock onto the annotation record", async () => {
    const h = await joined(harness());
    const a = h.store.add({ kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })!;
    const before = JSON.stringify(h.store.get(a.id));

    h.store.select(a.id);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // `locked` already means "issued for construction, signed off", and anything on the record takes
    // a version and rides the persistence queue — so a lock there could itself conflict.
    expect(JSON.stringify(h.store.get(a.id))).toBe(before);
    expect(h.store.get(a.id)!.locked).toBeUndefined();
    expect(h.viewer.collab!.held()).toEqual([a.id]);
  });

  it("surfaces a colleague's lock without touching the store", async () => {
    const h = await joined(harness());
    const a = h.store.add({ kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })!;

    const other = await new MemoryPresenceChannel().join({ documentId: "doc-1" }, { id: "u2", name: "Ben" });
    await other.acquire(a.id);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(h.viewer.collab!.locks().get(a.id)?.by.name).toBe("Ben");
    expect(h.store.get(a.id)!.locked).toBeUndefined();
  });

  it("warns rather than blocks by default, and warns louder when told to enforce", async () => {
    const plain = await joined(harness());
    const a = plain.store.add({ kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })!;
    const other = await new MemoryPresenceChannel().join({ documentId: "doc-1" }, { id: "u2", name: "Ben" });
    await other.acquire(a.id);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    plain.store.select(a.id);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Advisory: the edit is still possible, because a stale lease must not strand a markup.
    expect(plain.store.update(a.id, { subject: "still editable" })).toBeDefined();
    expect(plain.notices.some((m) => m.includes("Ben"))).toBe(false);
  });

  it("says who has it when enforcing", async () => {
    resetMemoryPresence();
    const h = await joined(harness(true));
    const a = h.store.add({ kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })!;
    const other = await new MemoryPresenceChannel().join({ documentId: "doc-1" }, { id: "u2", name: "Ben" });
    await other.acquire(a.id);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    h.store.select(a.id);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.notices.some((m) => m.includes("Ben is editing"))).toBe(true);
  });

  it("keeps working when the channel refuses to join", async () => {
    const bus = new EventBus();
    const store = new AnnotationStore({
      bus, author: () => "Ana", pageSize: () => ({ width: 1000, height: 800 }),
    });
    const notices: string[] = [];
    bus.on("notice", ({ message }) => notices.push(message));
    const viewer = {
      bus, store, el: { root: document.createElement("div") }, numPages: 1, page: 1,
      doc: { fingerprint: "doc-1" }, announce() {}, redraw() {},
    } as unknown as Viewer;

    collabPlugin({
      channel: { id: "broken", join: () => Promise.reject(new Error("no socket")) },
      self: { id: "u1", name: "Ana" },
    }).setup({
      viewer, bus, store,
      registerTool() {}, registerAction() {}, registerPanel() {}, registerRenderer() {},
      onCleanup() {},
    } as unknown as PluginContext);

    bus.emit("doc:loaded", { name: "d", pages: 1, fingerprint: "doc-1" });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Presence is a convenience. Losing it must not take the review down with it.
    expect(notices.some((m) => m.includes("Live presence unavailable"))).toBe(true);
    expect(store.add({ kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBeDefined();
  });
});
