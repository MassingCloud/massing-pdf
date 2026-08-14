/**
 * Presence and advisory locking — who else is here, and what they are editing right now.
 *
 * Deliberately **not** part of {@link StorageAdapter}. That contract is request/response plus an
 * optional `subscribe`, and everything crossing it is durable: `OfflineAdapter` writes pending
 * mutations to IndexedDB so a markup survives a dropped connection. Presence needs the opposite —
 * it is frequent, ephemeral, and actively harmful if retained, because a client that reconnects
 * after ten minutes would replay ten-minute-old cursors and lock claims as though they were now.
 *
 * The whole surface is optional. A host with no realtime backend supplies nothing, `collabPlugin`
 * is not installed, and the viewer behaves exactly as it does today — the same shape as `subscribe`
 * being optional and OCR having no default engine.
 *
 * See [docs/realtime.md](../../docs/realtime.md) for why locks live here rather than on the
 * annotation record, and why leases expire server-side.
 */
import type { StoreKey } from "./types";

/** Someone in the document. `id` is the host's stable user key, not a session id. */
export interface Participant {
  id: string;
  name: string;
  /** Display colour. The host owns this so a person is the same colour everywhere in the product. */
  colour?: string;
}

/** Where someone is looking. Coarse on purpose — a page is useful, a pixel is noise. */
export interface Viewing {
  page: number;
}

/**
 * An advisory claim on one markup.
 *
 * Advisory is the load-bearing word. A lease makes a collision *rare and visible*; the optimistic
 * version check remains the authority, and an expired lease degrades to the existing 409 path
 * rather than to lost work. Nothing here may become the only thing preventing data loss.
 */
export interface Lease {
  annotId: string;
  /** When the granting side will drop it, as an epoch millisecond *on that side's clock*. */
  until: number;
}

/** A lock held by somebody else. */
export interface HeldLock {
  by: Participant;
  until: number;
}

export interface PresenceSession {
  /** Everyone currently in the document, including self. Fires on any change. */
  onParticipants(fn: (people: Participant[]) => void): () => void;
  /** Locks held by *others*, keyed by annotation id. Fires on any change. */
  onLocks(fn: (locks: Map<string, HeldLock>) => void): () => void;
  /** Announce what this person is looking at. Cheap, lossy, rate-limited by the caller. */
  setViewing(state: Viewing): void;
  /** Ask for a lease. Resolves `null` when someone else holds it. */
  acquire(annotId: string): Promise<Lease | null>;
  /** Extend a lease already held. Resolves `null` if it was lost in the meantime. */
  renew(annotId: string): Promise<Lease | null>;
  release(annotId: string): void;
  leave(): void;
}

export interface PresenceChannel {
  readonly id: string;
  join(key: StoreKey, self: Participant): Promise<PresenceSession>;
}

/** Everything a lease implementation has to agree on. Exported so a host can match it. */
export const LEASE = {
  /** How long a grant lasts without renewal. */
  ttlMs: 30_000,
  /** How often the holder renews. Two missed renewals release the lock. */
  renewMs: 10_000,
} as const;

// ---- in-process implementation ----------------------------------------------

interface Room {
  people: Map<string, Participant>;
  viewing: Map<string, Viewing>;
  locks: Map<string, { by: string; until: number }>;
  listeners: Set<() => void>;
}

const rooms = new Map<string, Room>();

/**
 * A presence channel with no network, for the demo and for tests.
 *
 * Two viewers in the same page share a room and genuinely see each other, which is enough to
 * exercise every rule — including expiry, since this side owns the clock exactly as a server would.
 * It is not a substitute for a backend: nothing here crosses a tab, let alone a machine.
 */
export class MemoryPresenceChannel implements PresenceChannel {
  readonly id = "memory-presence";
  /** Injectable so a test can drive expiry without waiting thirty seconds. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  join(key: StoreKey, self: Participant): Promise<PresenceSession> {
    const roomId = `${key.projectId ?? ""}/${key.documentId}`;
    let room = rooms.get(roomId);
    if (!room) {
      room = { people: new Map(), viewing: new Map(), locks: new Map(), listeners: new Set() };
      rooms.set(roomId, room);
    }
    const r = room;
    r.people.set(self.id, self);

    const notify = () => { for (const fn of [...r.listeners]) fn(); };

    /** Drop anything past its deadline. The granting side owns time, so it is checked on read. */
    const sweep = (): boolean => {
      let changed = false;
      for (const [id, lock] of r.locks) {
        if (lock.until <= this.now()) { r.locks.delete(id); changed = true; }
      }
      return changed;
    };

    const heldByOthers = (): Map<string, HeldLock> => {
      sweep();
      const out = new Map<string, HeldLock>();
      for (const [annotId, lock] of r.locks) {
        if (lock.by === self.id) continue;
        const by = r.people.get(lock.by);
        if (by) out.set(annotId, { by, until: lock.until });
      }
      return out;
    };

    const grant = (annotId: string): Lease | null => {
      sweep();
      const existing = r.locks.get(annotId);
      if (existing && existing.by !== self.id) return null;
      const until = this.now() + LEASE.ttlMs;
      r.locks.set(annotId, { by: self.id, until });
      notify();
      return { annotId, until };
    };

    const session: PresenceSession = {
      onParticipants(fn) {
        const listener = () => { fn([...r.people.values()]); };
        r.listeners.add(listener);
        listener();
        return () => r.listeners.delete(listener);
      },
      onLocks(fn) {
        const listener = () => { fn(heldByOthers()); };
        r.listeners.add(listener);
        listener();
        return () => r.listeners.delete(listener);
      },
      setViewing(state) { r.viewing.set(self.id, state); notify(); },
      acquire(annotId) { return Promise.resolve(grant(annotId)); },
      renew(annotId) {
        sweep();
        // Renewing something that expired and was taken is a *loss*, not a re-grant — the caller
        // has to find out, because it may be mid-edit on a markup that is no longer theirs.
        const existing = r.locks.get(annotId);
        if (existing && existing.by !== self.id) return Promise.resolve(null);
        return Promise.resolve(grant(annotId));
      },
      release(annotId) {
        const existing = r.locks.get(annotId);
        if (existing?.by === self.id) { r.locks.delete(annotId); notify(); }
      },
      leave() {
        r.people.delete(self.id);
        r.viewing.delete(self.id);
        for (const [annotId, lock] of r.locks) if (lock.by === self.id) r.locks.delete(annotId);
        notify();
        if (!r.people.size) rooms.delete(roomId);
      },
    };

    notify();
    return Promise.resolve(session);
  }
}

/** Drop every in-process room. Test hygiene: rooms are module state and outlive a viewer. */
export function resetMemoryPresence(): void { rooms.clear(); }
