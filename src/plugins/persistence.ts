/**
 * Wires the annotation store to a storage adapter.
 *
 * Saves are debounced and coalesced per annotation id: dragging a markup produces one write, not
 * one per frame. Inbound changes from other people are merged by version rather than applied
 * wholesale, so a colleague's save never clobbers an edit in progress locally.
 */
import { definePlugin } from "../core/plugin";
import type { Mutation, StorageAdapter, StoreKey } from "../adapters/types";
import type { Annotation } from "../core/types";
import type { Viewer } from "../core/viewer";

export interface PersistenceOptions {
  adapter: StorageAdapter;
  /** Identify the markup set. Called after the document loads, so it can use the fingerprint. */
  key: (viewer: Viewer) => StoreKey;
  /** Coalescing window, ms. */
  debounceMs?: number;
  /** Subscribe to other people's changes when the adapter supports it. */
  live?: boolean;
  /** Load the stored set on document open. */
  autoLoad?: boolean;
}

export function persistencePlugin(options: PersistenceOptions) {
  const wait = options.debounceMs ?? 600;

  return definePlugin({
    id: "persistence",
    order: 80,
    setup(ctx) {
      const { viewer, store } = ctx;
      let key: StoreKey | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      /** Coalesced pending work: last write per id wins. */
      const pendingUpserts = new Map<string, Annotation>();
      const pendingRemovals = new Set<string>();
      const pendingMeta: Mutation[] = [];
      /** Suppresses the save loop while applying inbound remote changes. */
      let applying = false;

      const flush = async () => {
        if (!key) return;
        const mutations: Mutation[] = [
          ...[...pendingRemovals].map((id) => ({ op: "remove" as const, id })),
          ...[...pendingUpserts.values()].map((annot) => ({ op: "upsert" as const, annot })),
          ...pendingMeta,
        ];
        pendingUpserts.clear();
        pendingRemovals.clear();
        pendingMeta.length = 0;
        if (!mutations.length) return;
        try {
          ctx.bus.emit("sync:state", { state: "saving", pending: mutations.length });
          await options.adapter.save(key, mutations);
          ctx.bus.emit("sync:state", { state: "idle", pending: 0 });
        } catch (e) {
          ctx.bus.emit("sync:state", { state: "error", pending: mutations.length, message: (e as Error).message });
          ctx.bus.emit("notice", { level: "error", message: `Couldn't save markups: ${(e as Error).message}` });
        }
      };

      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void flush(), wait);
      };

      const queueUpsert = (annot: Annotation) => {
        if (applying) return;
        pendingRemovals.delete(annot.id);
        pendingUpserts.set(annot.id, annot);
        schedule();
      };

      ctx.bus.on("annot:added", ({ annot }) => queueUpsert(annot));
      ctx.bus.on("annot:updated", ({ annot }) => queueUpsert(annot));
      ctx.bus.on("annot:removed", ({ annot }) => {
        if (applying) return;
        pendingUpserts.delete(annot.id);
        pendingRemovals.add(annot.id);
        schedule();
      });
      ctx.bus.on("calibration:changed", ({ calibration, page }) => {
        if (applying) return;
        pendingMeta.push({ op: "calibration", calibration, page });
        schedule();
      });
      ctx.bus.on("sheet:changed", ({ meta }) => {
        if (applying) return;
        pendingMeta.push({ op: "sheet", sheet: meta });
        schedule();
      });

      ctx.bus.on("doc:loaded", () => {
        unsubscribe?.();
        key = options.key(viewer);
        if (options.autoLoad === false) return;
        void (async () => {
          try {
            const result = await options.adapter.load(key!);
            applying = true;
            store.reset(result.annotations, { undoable: false });
            for (const c of result.calibrations ?? []) store.setCalibration(c, c.page);
            for (const s of result.sheets ?? []) store.setSheet(s);
            applying = false;
            store.clearHistory();
            viewer.redraw();
            if (result.annotations.length) {
              ctx.bus.emit("notice", { level: "info", message: `Loaded ${result.annotations.length} saved markups.` });
            }
          } catch (e) {
            applying = false;
            ctx.bus.emit("notice", { level: "warn", message: `Couldn't load saved markups: ${(e as Error).message}` });
          }
        })();

        if (options.live !== false && options.adapter.subscribe) {
          unsubscribe = options.adapter.subscribe(key, (result) => {
            applying = true;
            // Merge by version: a remote record only wins if it is genuinely newer.
            const { added, updated } = store.merge(result.annotations);
            applying = false;
            if (added || updated) viewer.redraw();
          });
        }
      });

      ctx.registerAction({
        id: "persistence.save", label: "Save now", icon: "💾", group: "io", shortcut: "S",
        run: async () => { clearTimeout(timer); await flush(); },
      });

      ctx.registerAction({
        id: "persistence.reload", label: "Reload markups", icon: "⟲", group: "io",
        async run(v) {
          if (!key) return;
          const result = await options.adapter.load(key);
          applying = true;
          v.store.reset(result.annotations, { undoable: false });
          applying = false;
          v.redraw();
          v.bus.emit("notice", { level: "success", message: `Reloaded ${result.annotations.length} markups.` });
        },
      });

      ctx.onCleanup(() => {
        clearTimeout(timer);
        unsubscribe?.();
        // A pending batch on teardown is exactly the batch most worth not losing.
        void flush();
      });
    },
  });
}
