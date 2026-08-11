import { describe, expect, it, vi } from "vitest";
import { AnnotationStore } from "../src/core/store";
import { EventBus } from "../src/core/events";
import { Policy, capabilityCheck, type AuditEvent, type Capability } from "../src/core/policy";
import type { Annotation, AnnotationDraft } from "../src/core/types";

/**
 * Permissions and the audit trail.
 *
 * The property worth testing is that the gate is in the *store*, not the interface: a host script,
 * an import, or an adapter writing a colleague's markup all pass through the same door as a
 * toolbar click, and a check that only covers the toolbar covers nothing.
 */

function harness(options: { granted?: readonly Capability[]; actor?: string } = {}) {
  const bus = new EventBus();
  const audit: AuditEvent[] = [];
  const denials: string[] = [];
  const actor = options.actor ?? "A. Reviewer";

  const policy = new Policy({
    actor: () => actor,
    documentId: () => "A-201",
    audit: (e) => audit.push(e),
    onDeny: (reason) => denials.push(reason),
    ...(options.granted ? { check: capabilityCheck({ granted: options.granted }) } : {}),
  });

  const store = new AnnotationStore({
    bus, policy,
    author: () => actor,
    pageSize: () => ({ width: 1000, height: 800 }),
  });
  return { store, bus, audit, denials, policy };
}

const draft = (over: Partial<AnnotationDraft> = {}): AnnotationDraft => ({
  kind: "rect", page: 1, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], ...over,
});

const ALL: Capability[] = [
  "markup:create", "markup:edit", "markup:editOthers", "markup:delete", "markup:deleteOthers",
  "markup:status", "calibrate", "sheet:edit", "export", "import",
];

describe("permissions are enforced where the mutation happens", () => {
  it("refuses a create the role does not allow", () => {
    const { store, denials } = harness({ granted: ["markup:edit"] });
    expect(store.add(draft())).toBeUndefined();
    expect(store.size).toBe(0);
    expect(denials[0]).toMatch(/does not allow creating markups/);
  });

  it("allows a create the role does allow", () => {
    const { store } = harness({ granted: ["markup:create"] });
    expect(store.add(draft())).toBeDefined();
    expect(store.size).toBe(1);
  });

  it("lets someone edit their own markup but not a colleague's", () => {
    // The distinction the whole capability set exists for: "may annotate" is not "may reword the
    // architect's comment".
    const { store } = harness({ granted: ["markup:create", "markup:edit"] });
    const mine = store.add(draft({ subject: "mine" }))!;
    expect(store.update(mine.id, { subject: "edited" })?.subject).toBe("edited");

    const theirs = store.add(draft({ subject: "theirs" }))!;
    // Rewrite the author directly, as a load from the server would.
    store.reset([{ ...theirs, author: "B. Engineer" }, store.get(mine.id)!], { undoable: false });
    expect(store.update(theirs.id, { subject: "hijacked" })).toBeUndefined();
    expect(store.get(theirs.id)?.subject).toBe("theirs");
  });

  it("permits a colleague's markup once the escalated capability is granted", () => {
    const { store } = harness({ granted: ["markup:create", "markup:edit", "markup:editOthers"] });
    const a = store.add(draft({ subject: "theirs" }))!;
    store.reset([{ ...a, author: "B. Engineer" }], { undoable: false });
    expect(store.update(a.id, { subject: "moderated" })?.subject).toBe("moderated");
  });

  it("treats a status change as its own permission", () => {
    // A site manager may close an issue without being trusted to reword it.
    const { store } = harness({ granted: ["markup:create", "markup:status"] });
    const a = store.add(draft())!;
    expect(store.update(a.id, { status: "resolved" })?.status).toBe("resolved");
    expect(store.update(a.id, { subject: "reworded" })).toBeUndefined();
  });

  it("refuses a patch that bundles an edit with a status change", () => {
    // The bypass this closes: the check used to pick *one* capability, and a patch containing a
    // status change was only ever tested against `markup:status` — so everything else in the same
    // object rode along. A site manager may close an issue without being trusted to reword it.
    const { store } = harness({ granted: ["markup:create", "markup:status"] });
    const a = store.add(draft({ subject: "original" }))!;

    expect(store.update(a.id, { status: "resolved", subject: "hijacked" })).toBeUndefined();
    const now = store.get(a.id)!;
    expect(now.subject).toBe("original");
    expect(now.status).toBe("open");
  });

  it("refuses geometry smuggled in alongside a status change", () => {
    const { store } = harness({ granted: ["markup:create", "markup:status"] });
    const a = store.add(draft())!;
    const before = a.points;
    expect(store.update(a.id, { status: "resolved", points: [{ x: 900, y: 900 }] })).toBeUndefined();
    expect(store.get(a.id)?.points).toEqual(before);
  });

  it("allows the bundle when both capabilities are held", () => {
    const { store } = harness({ granted: ["markup:create", "markup:status", "markup:edit"] });
    const a = store.add(draft({ subject: "original" }))!;
    const after = store.update(a.id, { status: "resolved", subject: "reworded" });
    expect(after?.subject).toBe("reworded");
    expect(after?.status).toBe("resolved");
  });

  it("still allows a status-only change without edit rights", () => {
    // The distinction has to keep working in the direction it was built for.
    const { store } = harness({ granted: ["markup:create", "markup:status"] });
    const a = store.add(draft())!;
    expect(store.update(a.id, { status: "resolved" })?.status).toBe("resolved");
  });

  it("refuses a version write, which is what optimistic concurrency runs on", () => {
    // The hole this closes: `version` was excluded from the permission check as "store-managed",
    // but a patch can still set it. A caller with no edit rights could pin it to 999 and every
    // other user's save would 409 against a base version that never catches up.
    const { store } = harness({ granted: ["markup:create"] });
    const a = store.add(draft())!;
    expect(store.update(a.id, { version: 999 }, { bump: false })).toBeUndefined();
    expect(store.get(a.id)?.version).toBe(a.version);
  });

  it("does nothing at all for a patch that changes nothing", () => {
    // No revision, no `annot:updated`, no version bump. It used to do all three — and with no
    // permission check, because there was nothing to authorise.
    const { store, bus } = harness({ granted: ["markup:create"] });
    const a = store.add(draft())!;
    let updates = 0;
    bus.on("annot:updated", () => updates++);

    expect(store.update(a.id, {})).toBe(a);
    expect(store.update(a.id, { status: a.status })).toBe(a);
    expect(store.get(a.id)?.version).toBe(a.version);
    expect(updates).toBe(0);
  });

  it("still lets a rebase set the version when the editor may edit", () => {
    // The conflict path re-applies a local edit on top of the server's version, which means writing
    // `version` deliberately. That has to keep working.
    const { store } = harness({ granted: ["markup:create", "markup:edit"] });
    const a = store.add(draft({ subject: "mine" }))!;
    const rebased = store.update(a.id, { subject: "mine", version: 9 }, { bump: false });
    expect(rebased?.version).toBe(9);
  });

  it("guards calibration, because every measurement on the sheet derives from it", () => {
    const { store } = harness({ granted: ["markup:create"] });
    store.setCalibration({ page: 1, unitsPerPoint: 1 / 6, unit: "ft", source: "preset" }, 1);
    expect(store.calibration(1)).toBeUndefined();
  });

  it("guards a delete, and leaves the markup in place when refused", () => {
    const { store } = harness({ granted: ["markup:create"] });
    const a = store.add(draft())!;
    expect(store.remove(a.id)).toEqual([]);
    expect(store.size).toBe(1);
  });

  it("filters an import to the records the role may bring in", () => {
    const { store } = harness({ granted: ["markup:create"] });
    expect(store.addMany([draft(), draft()])).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("never lets a refused act reach the undo stack", () => {
    // Undo and redo re-apply changes without going back through the gate — they have to, since
    // they reverse acts already authorised. That is only sound while a *refused* act cannot get
    // onto the stack, because otherwise undo becomes a second door into the change the gate just
    // rejected. Every refusal returns before its `push`, and this pins that.
    const { store } = harness({ granted: ["markup:create"] });
    const a = store.add(draft({ subject: "original" }))!;

    store.update(a.id, { subject: "refused" });   // no markup:edit
    store.remove(a.id);                            // no markup:delete
    expect(store.size).toBe(1);
    expect(store.get(a.id)?.subject).toBe("original");

    // The only entry on the stack is the authorised create, so undo reverses that and nothing else.
    store.undo();
    expect(store.size).toBe(0);
    store.redo();
    expect(store.get(a.id)?.subject).toBe("original");
  });

  it("does not gate reset and merge, and the docs say so", () => {
    // These are the storage seam, not user actions: persistence calls `reset` when a restore lands
    // and `merge` when live sync delivers a colleague's change. Gating them would stop a reviewer
    // without `import` receiving their own saved markups back.
    //
    // Pinned as a *test* because it is a documented limit — docs/security.md tells a host that
    // `viewer.store.reset([])` empties the store whatever the policy says. If someone later decides
    // to gate these, this test failing is the prompt to correct that page too.
    const { store } = harness({ granted: [] });
    const seeded = {
      ...draft(), id: "an_seed", author: "B. Engineer",
      createdAt: "2026-01-01T00:00:00Z", version: 3, status: "open",
    } as unknown as Parameters<typeof store.reset>[0][number];

    store.reset([seeded], { undoable: false });
    expect(store.size).toBe(1);
    store.reset([], { undoable: false });
    expect(store.size).toBe(0);
  });

  it("keeps that limit local: neither reaches the persistence queue", () => {
    // The reason the ungated seam is acceptable. `annot:reset` is not what the save loop listens
    // on, so a wipe cannot propagate to the server — the next restore repopulates.
    const { store, bus } = harness({ granted: [] });
    const queued: string[] = [];
    for (const e of ["annot:added", "annot:updated", "annot:removed"] as const) {
      bus.on(e, () => queued.push(e));
    }
    store.reset([], { undoable: false });
    store.merge([]);
    expect(queued).toEqual([]);
  });

  it("allows everything when no check is configured", () => {
    const { store } = harness();
    expect(store.add(draft())).toBeDefined();
    store.setCalibration({ page: 1, unitsPerPoint: 1, unit: "ft", source: "preset" }, 1);
    expect(store.calibration(1)).toBeDefined();
  });

  it("fails closed when the host's check throws", () => {
    // A permission service that is down must not be read as "allow".
    const bus = new EventBus();
    const policy = new Policy({
      actor: () => "A",
      check: () => { throw new Error("identity service unreachable"); },
    });
    const store = new AnnotationStore({ bus, policy, author: () => "A", pageSize: () => undefined });
    expect(store.add(draft())).toBeUndefined();
  });
});

describe("the audit trail", () => {
  it("records what was done, by whom, and against which document", () => {
    const { store, audit } = harness({ granted: ALL });
    const a = store.add(draft())!;
    const entry = audit.find((e) => e.action === "markup:create");
    expect(entry).toMatchObject({
      actor: "A. Reviewer", allowed: true, annotId: a.id, annotKind: "rect",
      page: 1, documentId: "A-201",
    });
    expect(Date.parse(entry!.at)).not.toBeNaN();
  });

  it("records a refusal, with the reason", () => {
    // A denial is the entry a compliance review actually wants: someone tried.
    const { store, audit } = harness({ granted: [] });
    store.add(draft());
    const entry = audit.find((e) => e.action === "markup:create");
    expect(entry?.allowed).toBe(false);
    expect(entry?.reason).toMatch(/does not allow creating markups/);
  });

  it("does not record an allowed capability for an act that was refused", () => {
    // A bundled patch needs two capabilities. Checking them one at a time wrote
    // `markup:status allowed:true` before `markup:edit allowed:false` — a compliance reviewer
    // reading that sees a status change that never happened.
    const { store, audit } = harness({ granted: ["markup:create", "markup:status"] });
    const a = store.add(draft({ subject: "original" }))!;
    audit.length = 0;

    store.update(a.id, { status: "resolved", subject: "hijacked" });

    expect(audit).toHaveLength(1);
    expect(audit[0]?.allowed).toBe(false);
    expect(audit[0]?.action).toBe("markup:status+markup:edit");
    expect(audit[0]?.reason).toMatch(/does not allow editing markups/);
  });

  it("records a bundled act that succeeded as one entry", () => {
    const { store, audit } = harness({ granted: ["markup:create", "markup:status", "markup:edit"] });
    const a = store.add(draft())!;
    audit.length = 0;
    store.update(a.id, { status: "resolved", subject: "reworded" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "markup:status+markup:edit", allowed: true });
  });

  it("leaves a single-capability act named as it always was", () => {
    // Existing log queries should keep matching.
    const { store, audit } = harness({ granted: ["markup:create", "markup:edit"] });
    const a = store.add(draft())!;
    audit.length = 0;
    store.update(a.id, { subject: "reworded" });
    expect(audit[0]?.action).toBe("markup:edit");
  });

  it("keeps working when the sink throws", () => {
    // The sink is the host's code. A broken logger cannot be allowed to stop a review.
    const bus = new EventBus();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const policy = new Policy({ actor: () => "A", audit: () => { throw new Error("pipeline down"); } });
    const store = new AnnotationStore({ bus, policy, author: () => "A", pageSize: () => undefined });
    expect(() => store.add(draft())).not.toThrow();
    expect(store.size).toBe(1);
    spy.mockRestore();
  });

  it("stays inert when nothing is configured", () => {
    const policy = new Policy({ actor: () => "A" });
    expect(policy.active).toBe(false);
    expect(policy.allows("markup:create")).toBe(true);
  });
});

describe("capabilityCheck", () => {
  const annot = (author: string) => ({ author, page: 1, id: "a", kind: "rect" } as Annotation);

  it("explains the refusal rather than just saying no", () => {
    const check = capabilityCheck({ granted: [] });
    expect(check({ capability: "export", actor: "A" })).toMatch(/does not allow exporting/);
  });

  it("names the owner when refusing someone else's markup", () => {
    const check = capabilityCheck({ granted: ["markup:edit"] });
    const answer = check({ capability: "markup:edit", actor: "A", annot: annot("B. Engineer") });
    expect(answer).toMatch(/belongs to B. Engineer/);
  });

  it("takes a host's own idea of ownership", () => {
    // Ownership is often a team or a company, not a person.
    const check = capabilityCheck({
      granted: ["markup:edit"],
      isOwner: (a) => a.author.endsWith("@acme.example"),
    });
    expect(check({ capability: "markup:edit", actor: "x", annot: annot("someone@acme.example") })).toBe(true);
    expect(check({ capability: "markup:edit", actor: "x", annot: annot("other@rival.example") })).not.toBe(true);
  });
});
