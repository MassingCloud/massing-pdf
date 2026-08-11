import { describe, expect, it, vi } from "vitest";
import { conflictsPlugin } from "../src/plugins/conflicts";
import { persistencePlugin, type Conflict } from "../src/plugins/persistence";
import { ConflictError, type Mutation, type StorageAdapter } from "../src/adapters/types";
import { AnnotationStore } from "../src/core/store";
import { EventBus } from "../src/core/events";
import type { PluginContext } from "../src/core/plugin";
import type { Viewer } from "../src/core/viewer";
import type { Annotation } from "../src/core/types";

/**
 * The conflict dialog.
 *
 * This asks a reviewer to choose between two versions of their own work, and a wrong default here
 * destroys the one it does not pick. So these mostly probe what happens when nobody makes a
 * deliberate choice — Escape, a timeout, a server that will not say what it holds — because those
 * are the paths a real site tablet takes and the ones nobody demos.
 */

const annot = (over: Partial<Annotation> = {}): Annotation => ({
  id: "an_1", kind: "cloud", sheetId: "A-201", page: 1,
  points: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 70 }],
  author: "A. Reviewer", createdAt: "2026-07-20T09:00:00.000Z",
  version: 3, status: "open", subject: "Verify header",
  ...over,
});

/** Install the plugin against a root element and hand back the `ask` it exposes. */
function harness(options: Parameters<typeof conflictsPlugin>[0] = {}) {
  const root = document.createElement("div");
  root.className = "mpdf-root";
  document.body.appendChild(root);

  const announced: string[] = [];
  const cleanups: (() => void)[] = [];
  const viewer = {
    el: { root },
    announce: (message: string) => { announced.push(message); },
  } as unknown as Viewer;

  const ctx = {
    viewer,
    registerTool() {}, registerAction() {}, registerPanel() {}, registerRenderer() {},
    onCleanup(fn: () => void) { cleanups.push(fn); },
  } as unknown as PluginContext;

  conflictsPlugin(options).setup(ctx);

  const dialog = () => root.querySelector<HTMLElement>(".mpdf-conflict");
  const button = (text: string) => Array.from(root.querySelectorAll("button"))
    .find((b) => b.textContent === text)!;

  return {
    root, viewer, announced,
    ask: (c: Conflict) => viewer.conflicts!.ask(c),
    dialog, button,
    rows: () => Array.from(root.querySelectorAll(".mpdf-conflict-table tr"))
      .slice(1)
      .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent)),
    teardown: () => { cleanups.forEach((fn) => { fn(); }); root.remove(); },
  };
}

describe("conflict dialog", () => {
  it("shows only the fields that actually differ", async () => {
    const h = harness();
    const answer = h.ask({
      id: "an_1",
      mine: annot({ subject: "Verify header", note: "Check bearing", status: "open" }),
      theirs: annot({ subject: "Verify header", note: "Bearing confirmed", status: "resolved" }),
    });

    // Subject matches on both sides, so it is not a decision and does not belong in the table.
    expect(h.rows()).toEqual([
      ["Comment", "Check bearing", "Bearing confirmed"],
      ["Status", "open", "resolved"],
    ]);

    h.button("Keep theirs").click();
    await answer;
    h.teardown();
  });

  it("resolves null for theirs and the record for mine", async () => {
    const h = harness();
    const mine = annot({ note: "mine" });

    const a = h.ask({ id: "an_1", mine, theirs: annot({ note: "theirs" }) });
    h.button("Keep theirs").click();
    expect(await a).toBeNull();

    const b = h.ask({ id: "an_1", mine, theirs: annot({ note: "theirs" }) });
    h.button("Keep mine").click();
    expect(await b).toBe(mine);
    h.teardown();
  });

  it("treats Escape as keeping theirs, never as overwriting", async () => {
    const h = harness();
    const answer = h.ask({ id: "an_1", mine: annot({ note: "mine" }), theirs: annot({ note: "theirs" }) });

    h.dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    // Dismissing a dialog you did not understand must not be how you erase a colleague's edit.
    expect(await answer).toBeNull();
    expect(h.dialog()).toBeNull();
    h.teardown();
  });

  it("answers for an unattended tablet, keeping theirs", async () => {
    const h = harness({ timeoutSeconds: 0.01 });
    const answer = h.ask({ id: "an_1", mine: annot({ note: "mine" }), theirs: annot({ note: "theirs" }) });

    expect(await answer).toBeNull();
    expect(h.dialog()).toBeNull();
    expect(h.announced.some((m) => m.includes("their version was kept"))).toBe(true);
    h.teardown();
  });

  it("does not fire the timeout once a person has answered", async () => {
    const h = harness({ timeoutSeconds: 0.01 });
    const mine = annot({ note: "mine" });
    const answer = h.ask({ id: "an_1", mine, theirs: annot({ note: "theirs" }) });
    h.button("Keep mine").click();
    expect(await answer).toBe(mine);

    // A timer left running past `close` would fire into a resolved promise and — worse — announce
    // that their version was kept, contradicting what the reviewer just chose.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.announced.some((m) => m.includes("their version was kept"))).toBe(false);
    h.teardown();
  });

  it("shows no comparison when the server did not say what it holds", async () => {
    const h = harness();
    const mine = annot({ note: "mine" });
    const answer = h.ask({ id: "an_1", mine });

    // A side-by-side table needs two sides. Diffing against a record we were never given fills
    // their column with em dashes, which asserts their version has no subject and no status — the
    // one thing a bodyless 409 does not tell us. The choice is still real, so it is spelled out.
    expect(h.dialog()!.textContent).toContain("Keeping yours will overwrite theirs");
    expect(h.rows()).toEqual([]);

    h.button("Keep mine").click();
    expect(await answer).toBe(mine);
    h.teardown();
  });

  it("offers no choice when there is no local version to keep", async () => {
    const h = harness();
    const answer = h.ask({ id: "an_1", theirs: annot({ note: "theirs" }) });

    // `mine` is optional on a Conflict, and a "Keep mine" with nothing to keep would resolve null —
    // a button reporting the opposite of what it does.
    expect(h.button("Keep mine")).toBeUndefined();
    expect(h.rows()).toEqual([]);
    expect(h.dialog()!.textContent).toContain("Their version will be kept");

    h.button("OK").click();
    expect(await answer).toBeNull();
    h.teardown();
  });

  it("says so when both sides changed outside the compared fields", async () => {
    const h = harness();
    const answer = h.ask({
      id: "an_1",
      mine: annot({ style: { color: "#f00" } }),
      theirs: annot({ style: { color: "#0f0" } }),
    });

    // An empty table reads as "nothing differs, why am I being asked" and gets dismissed blind.
    expect(h.rows()).toEqual([["The visible fields match; the difference is in data not shown here."]]);
    h.button("Keep theirs").click();
    await answer;
    h.teardown();
  });

  it("reports geometry as moved rather than as coordinates", async () => {
    const h = harness();
    const answer = h.ask({
      id: "an_1",
      mine: annot(),
      theirs: annot({ points: [{ x: 40, y: 40 }, { x: 90, y: 10 }, { x: 90, y: 70 }] }),
    });

    expect(h.rows()).toEqual([["Position", "moved", "moved differently"]]);
    h.button("Keep theirs").click();
    await answer;
    h.teardown();
  });

  it("renders a hostile record from the server as text", async () => {
    const h = harness();
    const answer = h.ask({
      id: "an_1",
      mine: annot({ note: "mine" }),
      theirs: annot({ note: "<img src=x onerror=alert(1)>", author: "<script>alert(2)</script>" }),
    });

    // `theirs` arrives over the wire, so it is untrusted the same as any other imported record.
    expect(h.dialog()!.querySelector("img")).toBeNull();
    expect(h.dialog()!.querySelector("script")).toBeNull();
    expect(h.dialog()!.textContent).toContain("<img src=x onerror=alert(1)>");

    h.button("Keep theirs").click();
    await answer;
    h.teardown();
  });

  it("opens focused on the choice that destroys nothing", async () => {
    const h = harness();
    const answer = h.ask({ id: "an_1", mine: annot({ note: "mine" }), theirs: annot({ note: "theirs" }) });

    // Enter on an unread dialog should not be how a colleague's edit gets overwritten.
    expect(document.activeElement).toBe(h.button("Keep theirs"));
    expect(h.dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(h.dialog()!.getAttribute("aria-labelledby")).toBe("mpdf-conflict-title");

    h.button("Keep theirs").click();
    await answer;
    h.teardown();
  });

  it("keeps Tab inside the dialog and gives focus back on close", async () => {
    const before = document.createElement("button");
    before.textContent = "Toolbar";
    document.body.appendChild(before);
    before.focus();

    const h = harness();
    const answer = h.ask({ id: "an_1", mine: annot({ note: "mine" }), theirs: annot({ note: "theirs" }) });

    // Tabbing off the end of a modal must land back at its start, not on the sheet behind it —
    // otherwise the dialog is dismissible only by mouse and everything under it is still reachable.
    h.button("Keep mine").focus();
    h.dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(h.button("Keep theirs"));

    h.button("Keep theirs").focus();
    h.dialog()!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", shiftKey: true, bubbles: true, cancelable: true,
    }));
    expect(document.activeElement).toBe(h.button("Keep mine"));

    h.button("Keep theirs").click();
    await answer;

    // And whatever had focus before gets it back, rather than the page falling back to the body.
    expect(document.activeElement).toBe(before);
    before.remove();
    h.teardown();
  });

  it("names the author through the host's directory when given one", async () => {
    const h = harness({ describeAuthor: (a) => `Person<${a.author}>` });
    const answer = h.ask({
      id: "an_1",
      mine: annot(),
      theirs: annot({ author: "b.engineer@example.com", note: "theirs" }),
    });

    expect(h.dialog()!.textContent).toContain("Person<b.engineer@example.com> saved a different version");
    h.button("Keep theirs").click();
    await answer;
    h.teardown();
  });

  /**
   * The documented wiring, end to end: a rejected save opens the dialog, and what the reviewer
   * presses decides what the store holds and what gets retried. Each half is covered above and by
   * `persistence.test.ts`; this covers the seam between them, which is where a plugin that works in
   * isolation still does nothing useful.
   */
  it("settles a rejected save through the dialog", async () => {
    const root = document.createElement("div");
    root.className = "mpdf-root";
    document.body.appendChild(root);

    const bus = new EventBus();
    const store = new AnnotationStore({
      bus,
      author: () => "A. Reviewer",
      pageSize: () => ({ width: 1000, height: 800 }),
    });
    const viewer = {
      el: { root },
      announce() {},
      redraw() {},
      store,
    } as unknown as Viewer;
    const ctx = {
      viewer, bus, store,
      registerTool() {}, registerAction() {}, registerPanel() {}, registerRenderer() {},
      onCleanup() {},
    } as unknown as PluginContext;

    conflictsPlugin().setup(ctx);

    const theirs = annot({ note: "theirs", version: 7 });
    let rejected = false;
    const adapter = {
      load: async () => [],
      save: async (_key: unknown, mutations: Mutation[]) => {
        if (!rejected) {
          rejected = true;
          throw new ConflictError([{ id: "an_1", theirs }]);
        }
        saved.push(...mutations);
      },
    } as unknown as StorageAdapter;
    const saved: Mutation[] = [];

    persistencePlugin({
      adapter,
      key: () => ({ documentId: "doc-1" }),
      debounceMs: 1,
      onConflictResolve: "ask",
      onConflict: (c) => viewer.conflicts!.ask(c),
    }).setup(ctx);

    const restored = new Promise<void>((r) => { bus.on("markups:restored", () => { r(); }); });
    bus.emit("doc:loaded", { name: "d", pages: 1, fingerprint: "fp" });
    await restored;

    store.add(annot({ note: "mine", version: 1 }));

    // Wait for the rejected save to reach the dialog, rather than guessing at a delay.
    const dialog = await new Promise<HTMLElement>((resolve) => {
      const poll = setInterval(() => {
        const el = root.querySelector<HTMLElement>(".mpdf-conflict");
        if (el) { clearInterval(poll); resolve(el); }
      }, 2);
    });

    expect(dialog.textContent).toContain("Comment");
    Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Keep mine")!.click();

    await new Promise((r) => setTimeout(r, 40));

    // Keeping mine rebases the local edit onto their version and retries it, so the note survives
    // and the retry carries a base the server will accept.
    expect(store.get("an_1")?.note).toBe("mine");
    expect(store.get("an_1")?.version).toBe(theirs.version + 1);
    expect(saved.length).toBeGreaterThan(0);
    root.remove();
  });

  it("withdraws its API on teardown", () => {
    const h = harness();
    expect(h.viewer.conflicts).toBeDefined();
    h.teardown();
    expect(h.viewer.conflicts).toBeUndefined();
  });

  it("resolves through the handle on the plugin as well as the viewer", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const plugin = conflictsPlugin();
    plugin.setup({
      viewer: { el: { root }, announce() {} } as unknown as Viewer,
      registerTool() {}, registerAction() {}, registerPanel() {}, registerRenderer() {},
      onCleanup() {},
    } as unknown as PluginContext);

    // This is the handle the documented wiring uses, because `onConflict: (c) =>
    // viewer.conflicts!.ask(c)` inside `createViewer` refers to the variable being declared and
    // silently infers `any` for the whole viewer.
    const mine = annot({ note: "mine" });
    const answer = plugin.ask({ id: "an_1", mine, theirs: annot({ note: "theirs" }) });
    Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Keep mine")!.click();
    expect(await answer).toBe(mine);
    root.remove();
  });

  it("keeps the server's version when wired but never installed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = conflictsPlugin();

    // A host that wires `onConflict` and forgets `plugins: [conflicts]`. Throwing would escape into
    // the save queue's conflict handler, which has no catch around it — so this answers the way
    // every other ambiguous path here does, and says why in the console.
    expect(await plugin.ask({ id: "an_1", mine: annot() })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
