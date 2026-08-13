# Real-time co-markup — design note

Roadmap item 5. This is the argument, not the implementation. It exists because the questions it
settles are the expensive kind: a lock in the wrong place, or presence on the wrong transport, is
cheap to write and costly to unpick once two products depend on it.

## What already works, stated accurately

The roadmap described live sync as "a signal that triggers a reload: coarse". **That was wrong**,
and the correction changes what is left to build.

`StorageAdapter.subscribe(key, onChange)` delivers a `LoadResult`, and `persistencePlugin` folds it
in with `store.merge(result.annotations)` — a per-record merge that only accepts a remote record if
its `version` is genuinely newer. It then advances `baseVersions` for anything accepted, so the next
local edit is based on what the server actually holds, and redraws. Nothing reloads, and nothing is
lost.

So the collaboration substrate is already record-level and correct:

| | Status |
|---|---|
| Another person's saved markup appears without a refresh | works, via `subscribe` + `merge` |
| Two people editing the same markup | detected — `baseVersion` → 409 → `ConflictError` carrying both sides |
| Choosing between the two versions | `conflictsPlugin` |
| Knowing someone else is *in* the document | **missing** |
| Knowing they are editing *this markup*, before you both save | **missing** |
| Seeing a stroke as it is drawn | **missing**, and see "What not to build" |

The gap is not synchronisation. It is **intent**: today you find out about a collision after you
have both done the work. That is the whole of what item 5 should fix, and it is a smaller thing than
"real-time editing" implies.

## Q1 — where does a lock live?

**Not in the annotation record.** Three reasons, in increasing order of severity.

`Annotation.locked` already exists and already means something else: *"set by the host when the
markup must not be edited (issued for construction, signed off)"*, enforced in `store.update` and
`store.removeSelected`. Overloading it would mean releasing a session lock could clear a sign-off —
two lifetimes, one field, and the destructive one wins.

Adding a *different* field to `Annotation` is no better. The record is the document. Anything on it
rides the persistence queue, takes a version, is written to IndexedDB by `OfflineAdapter`, and
reaches interchange unless deliberately excluded — which is exactly the "promoting a field out of
`ext`" trap already documented in CLAUDE.md. A lock would be saved into the drawing's history.

Worst: a lock stored as a versioned record field can itself conflict. Two people grabbing the same
markup would produce a 409 about the *lock*, which is a conflict-resolution dialog about who is
allowed to have a conflict-resolution dialog.

**So: beside it.** A presence map keyed by annotation id, owned by the plugin, never merged into the
store. `AnnotationStore` keeps meaning "the document"; presence is view state, like selection or
zoom.

The consequence to hold on to: `render/svg.ts` must not learn about locks. The overlay decoration
for "someone else has this" comes from the plugin's own map, passed as render context — the same
seam custom renderers already use.

## Q2 — what releases a lock when a tab closes?

Nothing you can rely on the client to send. `beforeunload` does not fire dependably on mobile
Safari, and never fires on a crash, a killed tab, a flat battery or a dropped connection. A
release-on-exit design fails exactly when it matters, and the failure mode is a markup nobody can
edit and nobody can explain.

**Leases, with the server owning time.** A lock is granted for a bounded period, the holder renews
while they are still working, and the server expires it. Roughly a 30-second lease renewed every 10,
so two missed renewals release it. Client clocks are wrong often and adversarial occasionally, so
expiry must be judged server-side; the client only renews.

The load-bearing property: **a lock is advisory, and the version check remains the authority.**
If a lease expires mid-edit and someone else takes the markup, the existing 409 path catches it and
`conflictsPlugin` asks the reviewer. Locking makes collisions *rare and visible*; it does not make
them impossible, and must never be the only thing preventing loss. That is what keeps this an
improvement layered on optimistic concurrency rather than a replacement for it — and what keeps a
host with no lock support working exactly as it does today.

## Q3 — does presence go through `StorageAdapter`?

**No.** The contract is four request/response methods plus an optional `subscribe`, and presence is
a different shape of traffic: frequent, ephemeral, tolerant of loss, and actively harmful if
retained.

Routing it through `save()` would put presence into the durable outbound queue and, via
`OfflineAdapter`, into IndexedDB — so a client that went offline and came back would replay stale
cursor positions and lock claims from minutes ago as though they were current. The offline queue
exists precisely because markups must survive a dropped connection. Presence must do the opposite.

A separate optional channel, supplied alongside the adapter:

```ts
export interface PresenceChannel {
  /** Join a document. Returns a leave function. */
  join(key: StoreKey, self: Participant): Promise<PresenceSession>;
}

export interface PresenceSession {
  /** Everyone currently in the document, including self. Fires on any change. */
  onParticipants(fn: (people: Participant[]) => void): () => void;
  /** Announce what this person is looking at. Cheap, lossy, rate-limited by the caller. */
  setViewing(state: { page: number; box?: Box }): void;
  /** Ask for an advisory lease on a markup. Resolves null if someone else holds it. */
  acquire(annotId: string): Promise<Lease | null>;
  /** Locks held by others, keyed by annotation id. */
  onLocks(fn: (locks: Map<string, { by: Participant; until: number }>) => void): () => void;
  leave(): void;
}
```

Omit it and everything degrades to what ships today — the same shape as `subscribe` being optional,
and as OCR having no default engine. A host without a realtime backend must not be worse off for the
feature existing.

## What not to build

**Operational transform or CRDTs for markup geometry.** They solve concurrent edits to a shared
mutable structure — a text document. A markup is a small immutable-ish record with a version, and
two people dragging the same cloud's vertices in the same second is not the case that hurts. The
case that hurts is two people editing the same markup over minutes, which `baseVersion` + the
conflict dialog already handle. OT is a large, permanent complexity cost paid against a rare event,
and it would have to be understood by everyone who touches the store afterwards.

**Live stroke replay.** Watching a colleague's ink appear point by point demos well and is worth
little on a review: the markup matters when it is finished. It is also the most expensive traffic
here. If it is ever wanted, it belongs on the presence channel as a transient, never in the store.

## Staging

1. **Presence only** — who is in the document, which sheet they are on. No locking. Small, useful
   immediately ("Ana is on A-201"), and proves the channel without touching the store.
2. **Advisory leases** — acquire on selection-for-edit, renew while editing, decorate markups held
   by others. The 409 path stays as the safety net underneath.
3. **Viewport presence** — where on the sheet someone is looking. Only if 1 and 2 are being used.

Each stage ships alone and each is useful alone, which is the test of whether the split is real.

## Open, and worth deciding before stage 2

- **What does acquiring a lock mean for `markup:editOthers`?** A lease says "I am editing this now";
  the capability says "I may edit this at all". They are different questions and the check must stay
  in the store, not move into the lease.
- **Should a held lock block the local UI, or only warn?** Blocking is honest but makes a stale
  lease infuriating. Warning is recoverable but ignorable. Leaning towards warn-and-decorate, on the
  same reasoning as the conflict dialog defaulting to "keep theirs": the recoverable choice wins
  where the mechanism cannot be trusted absolutely.
