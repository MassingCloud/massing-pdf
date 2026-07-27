/**
 * The persistence contract.
 *
 * One narrow interface, three implementations (memory, IndexedDB, REST) and a wrapper that composes
 * the last two into an offline-first queue. The viewer never talks to a server directly — that is
 * what lets the same engine run against Massing's API, a customer's own backend, or nothing at all.
 */
import type { Annotation, Calibration, SheetMeta } from "../core/types";

/** What identifies a markup set: a document within a project. */
export interface StoreKey {
  projectId?: string;
  /** Stable document key — the PDF fingerprint, a document id, or a sheet number. */
  documentId: string;
}

/** A change to push. `remove` carries only the id. */
export type Mutation =
  | { op: "upsert"; annot: Annotation }
  | { op: "remove"; id: string }
  | { op: "calibration"; calibration: Calibration | null; page: number }
  | { op: "sheet"; sheet: SheetMeta };

export interface LoadResult {
  annotations: Annotation[];
  calibrations?: Calibration[];
  sheets?: SheetMeta[];
  /** Opaque cursor a backend can use to serve deltas on the next load. */
  cursor?: string;
}

export interface StorageAdapter {
  readonly id: string;
  /** Read the markup set. */
  load(key: StoreKey): Promise<LoadResult>;
  /** Apply a batch of changes. Batched so a drag or a bulk import is one round trip. */
  save(key: StoreKey, mutations: Mutation[]): Promise<void>;
  /**
   * Subscribe to changes made by other people. Return an unsubscribe. Optional: adapters without a
   * push channel simply omit it and the viewer stays single-player.
   */
  subscribe?(key: StoreKey, onChange: (result: LoadResult) => void): () => void;
  /** True when the adapter can currently reach its backing store. */
  online?(): boolean;
}

/** Thrown when a save is rejected because someone else changed the record first. */
export class ConflictError extends Error {
  constructor(readonly annotId: string, readonly theirs?: Annotation) {
    super(`markup ${annotId} was changed by someone else`);
    this.name = "ConflictError";
  }
}
