import { expect, test } from "@playwright/test";
import { annotations, openSample, waitForRender } from "./helpers";

/**
 * The storage adapters.
 *
 * IndexedDB has no usable shim in a headless DOM, so the durable half of offline-first — the
 * working copy and the outbound queue — is only testable in a browser. The queue behaviour is the
 * part worth proving: a field user must never lose a markup because the network dropped mid-save.
 */
test.describe("IndexedDbAdapter", () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
  });

  test("round-trips markups, calibrations and sheet metadata", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbAdapter } = await import("/src/index.ts");
      const adapter = new IndexedDbAdapter();
      const key = { documentId: "test-roundtrip" };
      await adapter.clear(key);

      const annot = window.viewer.addAnnotation({
        kind: "cloud", page: 1,
        points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }],
        subject: "Verify header", discipline: "structural",
      });
      await adapter.save(key, [
        { op: "upsert", annot },
        { op: "calibration", calibration: { unitsPerPoint: 0.111, unit: "ft", source: "preset", page: 1 }, page: 1 },
        { op: "sheet", sheet: { sheetId: "A-201", page: 1, number: "A-201", title: "SECOND FLOOR PLAN" } },
      ]);

      const loaded = await adapter.load(key);
      await adapter.clear(key);
      return {
        annots: loaded.annotations.length,
        subject: loaded.annotations[0]?.subject,
        discipline: loaded.annotations[0]?.discipline,
        points: loaded.annotations[0]?.points.length,
        unit: loaded.calibrations?.[0]?.unit,
        sheetNumber: loaded.sheets?.[0]?.number,
      };
    });
    expect(result).toMatchObject({
      annots: 1, subject: "Verify header", discipline: "structural",
      points: 3, unit: "ft", sheetNumber: "A-201",
    });
  });

  test("applies removals", async ({ page }) => {
    const remaining = await page.evaluate(async () => {
      const { IndexedDbAdapter } = await import("/src/index.ts");
      const adapter = new IndexedDbAdapter();
      const key = { documentId: "test-remove" };
      await adapter.clear(key);
      const a = window.viewer.addAnnotation({ kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
      const b = window.viewer.addAnnotation({ kind: "rect", page: 1, points: [{ x: 20, y: 20 }, { x: 30, y: 30 }] });
      await adapter.save(key, [{ op: "upsert", annot: a }, { op: "upsert", annot: b }]);
      await adapter.save(key, [{ op: "remove", id: a.id }]);
      const left = (await adapter.load(key)).annotations.map((x) => x.id);
      await adapter.clear(key);
      return { left, expected: b.id };
    });
    expect(remaining.left).toEqual([remaining.expected]);
  });

  test("keeps documents separate", async ({ page }) => {
    const counts = await page.evaluate(async () => {
      const { IndexedDbAdapter } = await import("/src/index.ts");
      const adapter = new IndexedDbAdapter();
      const one = { documentId: "doc-one" }, two = { documentId: "doc-two" };
      await adapter.clear(one); await adapter.clear(two);
      const a = window.viewer.addAnnotation({ kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
      await adapter.save(one, [{ op: "upsert", annot: a }]);
      const result = {
        one: (await adapter.load(one)).annotations.length,
        two: (await adapter.load(two)).annotations.length,
      };
      await adapter.clear(one); await adapter.clear(two);
      return result;
    });
    expect(counts).toEqual({ one: 1, two: 0 });
  });

  test("survives a page reload — markups come back on the same document", async ({ page }) => {
    await waitForRender(page, 1);
    await page.evaluate(() => {
      window.viewer.addAnnotation({
        kind: "cloud", page: 1,
        points: [{ x: 300, y: 300 }, { x: 500, y: 300 }, { x: 500, y: 420 }],
        subject: "Survives a reload",
      });
    });
    // The persistence plugin debounces; give it time to flush before navigating away.
    await page.waitForTimeout(1500);

    await page.reload();
    await page.waitForFunction(() => Boolean(window.viewer));
    await page.locator("#sample").click();
    await page.waitForFunction(() => Boolean(window.viewer.doc), null, { timeout: 60_000 });

    await expect
      .poll(async () => (await annotations(page)).some((a) => a.subject === "Survives a reload"), { timeout: 20_000 })
      .toBe(true);

    // Leave the store clean for other specs sharing this fingerprint.
    await page.evaluate(async () => {
      const { IndexedDbAdapter } = await import("/src/index.ts");
      await new IndexedDbAdapter().clear({ documentId: window.viewer.doc!.fingerprint });
    });
  });
});

test.describe("OfflineAdapter", () => {
  // These drive the adapters directly, but still need the demo page: the library is imported from
  // the dev server inside the browser context.
  test.beforeEach(async ({ page }) => {
    await openSample(page);
  });

  test("serves the local copy immediately and queues the write", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { OfflineAdapter, IndexedDbAdapter } = await import("/src/index.ts");
      const key = { documentId: "offline-basic" };
      const local = new IndexedDbAdapter();
      await local.clear(key);

      const seen: unknown[][] = [];
      const remote = {
        id: "stub",
        async load() { return { annotations: [] }; },
        async save(_k: unknown, m: unknown[]) { seen.push(m); },
        online: () => true,
      };
      const adapter = new OfflineAdapter({ remote, local });
      await adapter.load(key);

      const annot = window.viewer.addAnnotation({ kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 9, y: 9 }] });
      await adapter.save(key, [{ op: "upsert", annot }]);

      const localCopy = (await local.load(key)).annotations.length;
      const pending = await adapter.pendingCount();
      await local.clear(key);
      return { localCopy, pushed: seen.length, pending };
    });
    // Written locally, pushed once, and nothing left waiting.
    expect(result.localCopy).toBe(1);
    expect(result.pushed).toBe(1);
    expect(result.pending).toBe(0);
  });

  test("keeps the markup and the queue when the network fails, then drains on retry", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { OfflineAdapter, IndexedDbAdapter } = await import("/src/index.ts");
      const key = { documentId: "offline-retry" };
      const local = new IndexedDbAdapter();
      await local.clear(key);

      let failing = true;
      let accepted = 0;
      const remote = {
        id: "flaky",
        async load() { return { annotations: [] }; },
        async save(_k: unknown, m: unknown[]) {
          if (failing) throw new Error("network down");
          accepted += m.length;
        },
        online: () => true,
      };
      const states: string[] = [];
      const adapter = new OfflineAdapter({ remote, local, retryMs: 60_000, onState: (s) => states.push(s.state) });
      await adapter.load(key);

      const annot = window.viewer.addAnnotation({ kind: "rect", page: 1, points: [{ x: 1, y: 1 }, { x: 8, y: 8 }] });
      await adapter.save(key, [{ op: "upsert", annot }]);

      const afterFailure = {
        local: (await local.load(key)).annotations.length,
        pending: await adapter.pendingCount(),
        accepted,
      };

      // Connection returns.
      failing = false;
      await adapter.drain();
      const afterRecovery = { pending: await adapter.pendingCount(), accepted };

      adapter.dispose();
      await local.clear(key);
      return { afterFailure, afterRecovery, sawError: states.includes("error") };
    });

    // The markup survived the failure locally, and the mutation stayed queued rather than vanishing.
    expect(result.afterFailure.local).toBe(1);
    expect(result.afterFailure.pending).toBe(1);
    expect(result.afterFailure.accepted).toBe(0);
    expect(result.sawError).toBe(true);

    // On reconnect the queue drains exactly once.
    expect(result.afterRecovery.pending).toBe(0);
    expect(result.afterRecovery.accepted).toBe(1);
  });

  test("does not attempt the network while offline", async ({ page }) => {
    const attempts = await page.evaluate(async () => {
      const { OfflineAdapter, IndexedDbAdapter } = await import("/src/index.ts");
      const key = { documentId: "offline-down" };
      const local = new IndexedDbAdapter();
      await local.clear(key);

      let tried = 0;
      const remote = {
        id: "down",
        async load() { return { annotations: [] }; },
        async save() { tried++; },
        online: () => false,
      };
      const adapter = new OfflineAdapter({ remote, local });
      await adapter.load(key);
      const annot = window.viewer.addAnnotation({ kind: "rect", page: 1, points: [{ x: 2, y: 2 }, { x: 7, y: 7 }] });
      await adapter.save(key, [{ op: "upsert", annot }]);
      const pending = await adapter.pendingCount();
      adapter.dispose();
      await local.clear(key);
      return { tried, pending };
    });
    expect(attempts.tried).toBe(0);
    expect(attempts.pending).toBe(1);
  });

  test("mirrors an inbound remote change into the local cache", async ({ page }) => {
    const cached = await page.evaluate(async () => {
      const { OfflineAdapter, IndexedDbAdapter } = await import("/src/index.ts");
      const key = { documentId: "offline-sub" };
      const local = new IndexedDbAdapter();
      await local.clear(key);

      const theirs = {
        id: "an_theirs", kind: "pin" as const, sheetId: "A-201", page: 1,
        points: [{ x: 50, y: 50 }], author: "Someone Else",
        createdAt: new Date().toISOString(), version: 3, status: "open" as const,
        subject: "From a colleague",
      };
      let push: ((r: { annotations: typeof theirs[] }) => void) | null = null;
      const remote = {
        id: "live",
        async load() { return { annotations: [] }; },
        async save() {},
        subscribe(_k: unknown, onChange: (r: { annotations: typeof theirs[] }) => void) { push = onChange; return () => {}; },
        online: () => true,
      };
      const adapter = new OfflineAdapter({ remote, local });
      await adapter.load(key);
      adapter.subscribe(key, () => {});
      push!({ annotations: [theirs] });
      await new Promise((r) => setTimeout(r, 300));

      const stored = (await local.load(key)).annotations.map((a) => a.subject);
      adapter.dispose();
      await local.clear(key);
      return stored;
    });
    // A colleague's markup must survive the tab going offline immediately after it arrived.
    expect(cached).toContain("From a colleague");
  });
});
