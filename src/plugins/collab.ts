/**
 * Live co-markup: who else is in the document, and what they are editing right now.
 *
 * The synchronisation substrate already worked — `StorageAdapter.subscribe` delivers records and
 * `store.merge` folds them in by version, so a colleague's saved markup appears without a refresh,
 * and two people editing the same one meet at a 409 with both sides carried. What was missing is
 * *intent*: you found out about the collision after you had both done the work.
 *
 * This closes that, and nothing more. It does not synchronise strokes as they are drawn, and it
 * does not attempt operational transform on geometry — see [docs/realtime.md](../../docs/realtime.md)
 * for why both are deliberate.
 *
 * **Locks live here, not on the record.** `Annotation.locked` already means "issued for
 * construction, signed off"; and anything on an `Annotation` takes a version, rides the persistence
 * queue and reaches storage — so a lock stored there could itself conflict, which would be a
 * conflict dialog about who is allowed a conflict dialog. The map below is view state, like
 * selection. The store keeps meaning "the document".
 *
 * ```ts
 * const viewer = await createViewer({
 *   container, workerUrl,
 *   persistence: { adapter, key },
 *   collab: { channel: new MemoryPresenceChannel(), self: { id: "u1", name: "A. Reviewer" } },
 * });
 * ```
 */
import { definePlugin } from "../core/plugin";
import { activate } from "../core/a11y";
import { LEASE, type HeldLock, type Participant, type PresenceChannel, type PresenceSession } from "../adapters/presence";
import type { StoreKey } from "../adapters/types";
import type { Viewer } from "../core/viewer";

export interface CollabOptions {
  channel: PresenceChannel;
  /** Who this client is. The host owns identity; the library never invents one. */
  self: Participant;
  /**
   * Which document to join. Defaults to the PDF's fingerprint, matching `persistencePlugin`'s
   * default so both halves land in the same room without the host wiring it twice.
   */
  key?: (viewer: Viewer) => StoreKey;
  side?: "left" | "right";
  /**
   * Block editing a markup somebody else holds, instead of warning.
   *
   * Off by default. A lease can go stale — a held lock outliving the person who took it is a real
   * outcome, and being hard-blocked by one is infuriating in a way that being warned is not. The
   * same reasoning as the conflict dialog defaulting to "keep theirs": where the mechanism cannot
   * be trusted absolutely, the recoverable choice wins.
   */
  enforce?: boolean;
}

export function collabPlugin(options: CollabOptions) {
  return definePlugin({
    id: "collab",
    order: 95,
    setup(ctx) {
      const { viewer, store } = ctx;
      let session: PresenceSession | null = null;
      let people: Participant[] = [];
      let locks = new Map<string, HeldLock>();
      /** Markups this client holds, and the timer keeping each alive. */
      const held = new Map<string, ReturnType<typeof setInterval>>();
      let renderPanel = () => { /* replaced when the panel mounts */ };

      const leave = () => {
        for (const timer of held.values()) clearInterval(timer);
        held.clear();
        session?.leave();
        session = null;
        people = [];
        locks = new Map();
      };

      const join = async (): Promise<void> => {
        leave();
        const key = options.key?.(viewer) ?? { documentId: viewer.doc?.fingerprint ?? "unknown" };
        try {
          session = await options.channel.join(key, options.self);
        } catch (e) {
          // Presence is a convenience. Losing it must not take the review down with it.
          ctx.bus.emit("notice", { level: "warn", message: `Live presence unavailable: ${(e as Error).message}` });
          return;
        }
        session.onParticipants((p) => { people = p; renderPanel(); });
        session.onLocks((l) => { locks = l; decorateAll(); renderPanel(); });
        session.setViewing({ page: viewer.page });
      };

      // ---- decoration -------------------------------------------------------

      /**
       * Mark the markups somebody else holds.
       *
       * Applied to the overlay after it paints rather than baked into the renderer: a lock is not a
       * property of the markup, so `render/svg.ts` must not learn about one. The overlay is rebuilt
       * on every repaint, which is what `overlay:painted` is for.
       */
      const decorate = (page: number) => {
        const root = viewer.el.root;
        for (const g of root.querySelectorAll<SVGGElement>(`.mpdf-overlay[data-page="${page}"] [data-annot]`)) {
          const id = g.dataset.annot;
          const lock = id ? locks.get(id) : undefined;
          if (lock) {
            g.classList.add("is-locked-by-other");
            // On the group rather than a tooltip: a title element inside SVG is the only thing a
            // screen reader will read here, and "who has it" is the whole content of the signal.
            g.setAttribute("aria-label", `Being edited by ${lock.by.name}`);
          } else {
            g.classList.remove("is-locked-by-other");
            g.removeAttribute("aria-label");
          }
        }
      };
      const decorateAll = () => {
        for (let p = 1; p <= viewer.numPages; p++) decorate(p);
      };

      ctx.bus.on("overlay:painted", ({ page }) => decorate(page));

      // ---- leases -----------------------------------------------------------

      /** Take a lease and keep it alive while this client is still editing. */
      const acquire = async (annotId: string): Promise<boolean> => {
        if (!session || held.has(annotId)) return held.has(annotId);
        const lease = await session.acquire(annotId);
        if (!lease) return false;
        const timer = setInterval(() => {
          void session?.renew(annotId).then((still) => {
            // Lost it. Say so rather than carrying on: the person may be mid-edit on a markup that
            // is no longer theirs, and the 409 that follows is a worse way to find out.
            if (!still) {
              release(annotId);
              viewer.announce(`Your hold on this markup expired.`, "assertive");
              ctx.bus.emit("notice", { level: "warn", message: "Your hold on a markup expired — save soon or you may hit a conflict." });
            }
          });
        }, LEASE.renewMs);
        held.set(annotId, timer);
        return true;
      };

      const release = (annotId: string) => {
        const timer = held.get(annotId);
        if (timer) clearInterval(timer);
        held.delete(annotId);
        session?.release(annotId);
      };

      /**
       * Claim what is selected, let go of what is not.
       *
       * Selection is the honest signal for "about to edit". Waiting for the first modification
       * would announce intent only after the edit exists, which is exactly the lateness this
       * feature is for.
       */
      ctx.bus.on("annot:selected", ({ ids }) => {
        for (const id of [...held.keys()]) if (!ids.includes(id)) release(id);
        for (const id of ids) void acquire(id);
      });

      // Someone else's lock is advisory by default; enforcing is opt-in.
      if (options.enforce) {
        ctx.bus.on("annot:selected", ({ ids }) => {
          const blocked = ids.filter((id) => locks.has(id));
          if (blocked.length) {
            const who = locks.get(blocked[0]!)!.by.name;
            ctx.bus.emit("notice", { level: "warn", message: `${who} is editing that markup.` });
          }
        });
      }

      ctx.bus.on("doc:loaded", () => { void join(); });
      ctx.bus.on("page:changed", ({ page }) => session?.setViewing({ page }));
      ctx.onCleanup(leave);
      // A closing tab should let go if it gets the chance — but nothing depends on it, which is why
      // leases expire. `beforeunload` does not fire on a crash, a killed tab, or mobile Safari.
      if (typeof window !== "undefined") {
        const bye = () => leave();
        window.addEventListener("pagehide", bye);
        ctx.onCleanup(() => window.removeEventListener("pagehide", bye));
      }

      ctx.registerPanel({
        id: "collab", title: "In this document", side: options.side ?? "right", order: 5,
        mount: (host) => {
          const list = document.createElement("div");
          list.className = "mpdf-collab";
          host.appendChild(list);

          renderPanel = () => {
            list.textContent = "";
            if (!session) {
              const p = document.createElement("p");
              p.className = "mpdf-empty";
              p.textContent = "Not connected.";
              list.appendChild(p);
              return;
            }
            for (const person of people) {
              const row = document.createElement("div");
              row.className = "mpdf-collab-person";
              if (person.id === options.self.id) row.dataset.self = "true";
              const dot = document.createElement("span");
              dot.className = "mpdf-collab-dot";
              if (person.colour) dot.style.background = person.colour;
              const name = document.createElement("span");
              name.textContent = person.id === options.self.id ? `${person.name} (you)` : person.name;
              row.append(dot, name);
              list.appendChild(row);
            }
            const editing = [...locks.entries()];
            if (editing.length) {
              const p = document.createElement("p");
              p.className = "mpdf-empty";
              p.textContent = `${editing.length} markup${editing.length === 1 ? "" : "s"} being edited by others.`;
              list.appendChild(p);
              for (const [annotId, lock] of editing) {
                const row = document.createElement("div");
                row.className = "mpdf-collab-lock";
                row.textContent = `${lock.by.name} — ${store.get(annotId)?.subject ?? annotId}`;
                activate(row, () => {
                  const a = store.get(annotId);
                  if (a) void viewer.goToAnnotation(a);
                }, { label: `Go to the markup ${lock.by.name} is editing`, roving: false });
                list.appendChild(row);
              }
            }
          };
          renderPanel();
          return () => { renderPanel = () => { /* unmounted */ }; };
        },
      });

      viewer.collab = {
        participants: () => people,
        locks: () => locks,
        acquire,
        release,
        held: () => [...held.keys()],
      };
      ctx.onCleanup(() => { delete viewer.collab; });
    },
  });
}

declare module "../core/viewer" {
  interface Viewer {
    /** Present once the collab plugin is installed. */
    collab?: {
      participants(): Participant[];
      /** Markups held by *other* people, keyed by annotation id. */
      locks(): Map<string, HeldLock>;
      /** Take an advisory lease. Resolves false when someone else holds it. */
      acquire(annotId: string): Promise<boolean>;
      release(annotId: string): void;
      /** Markups this client currently holds. */
      held(): string[];
    };
  }
}
