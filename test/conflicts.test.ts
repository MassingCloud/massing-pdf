import { describe, expect, it, vi } from "vitest";
import { RestAdapter } from "../src/adapters/rest";
import { ConflictError, type Mutation } from "../src/adapters/types";
import type { Annotation } from "../src/core/types";

/**
 * Optimistic concurrency.
 *
 * Two people editing the same markup is the normal case on a review, and without a version check
 * the second save silently erases the first. These cover the client half: sending the base version,
 * and turning the server's rejection into something a caller can act on.
 */

const annot = (over: Partial<Annotation> = {}): Annotation => ({
  id: "an_1", kind: "cloud", sheetId: "A-201", page: 1,
  points: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 70 }],
  author: "A. Reviewer", createdAt: "2026-07-20T09:00:00.000Z",
  version: 3, status: "open", subject: "Verify header",
  ...over,
});

/** A `fetch` stand-in that records calls and replays canned responses. */
function stubFetch(responses: { status: number; body?: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: "",
      headers: new Headers(),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const KEY = { projectId: "p1", documentId: "A-201" };

const body = (call: { init?: RequestInit } | undefined) =>
  JSON.parse(String(call?.init?.body ?? "{}"));

/**
 * Await a save that is expected to conflict and hand back the error.
 *
 * `.catch(e => e as ConflictError)` would type-launder a resolved save into an "error" with no
 * properties, so a broken adapter that silently succeeded would fail on a confusing `undefined`
 * rather than on the thing that actually went wrong.
 */
async function rejection(saving: Promise<unknown>): Promise<ConflictError> {
  try {
    await saving;
  } catch (e) {
    if (e instanceof ConflictError) return e;
    throw e;
  }
  throw new Error("expected the save to be rejected with a ConflictError, but it succeeded");
}

describe("sending the base version", () => {
  it("includes it on an upsert that carries one", async () => {
    const { impl, calls } = stubFetch([{ status: 201 }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    await adapter.save(KEY, [{ op: "upsert", annot: annot(), baseVersion: 2 }]);
    expect(body(calls[0]).markups[0].base_version).toBe(2);
  });

  it("omits it on a create, which has nothing to have moved on from", async () => {
    const { impl, calls } = stubFetch([{ status: 201 }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    await adapter.save(KEY, [{ op: "upsert", annot: annot({ version: 1 }) }]);
    expect(body(calls[0]).markups[0]).not.toHaveProperty("base_version");
  });

  it("puts it on a delete as a query parameter", async () => {
    const { impl, calls } = stubFetch([{ status: 200 }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    await adapter.save(KEY, [{ op: "remove", id: "an_1", baseVersion: 4 }]);
    expect(calls[0]!.url).toContain("base_version=4");
  });

  it("leaves a server that ignores it behaving exactly as before", async () => {
    // The field is additive; nothing about the existing payload shape changes.
    const { impl, calls } = stubFetch([{ status: 201 }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    await adapter.save(KEY, [{ op: "upsert", annot: annot(), baseVersion: 2 }]);
    const sent = body(calls[0]);
    expect(sent.sheet_id).toBe("A-201");
    expect(sent.markups[0].id).toBe("an_1");
    expect(sent.markups[0].data.record.subject).toBe("Verify header");
  });
});

describe("handling a 409", () => {
  const theirRow = {
    id: "an_1", sheet_id: "A-201", x: 10, y: 10, note: "Theirs", author: "B. Engineer",
    topic_id: null, kind: "cloud",
    data: { pts: [{ x: 10, y: 10 }], page: 1, record: { version: 7, subject: "Their edit" } },
  };

  it("throws a ConflictError rather than a generic failure", async () => {
    const { impl } = stubFetch([{ status: 409, body: { conflicts: [theirRow] } }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    await expect(adapter.save(KEY, [{ op: "upsert", annot: annot(), baseVersion: 2 }]))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("carries both sides, so a caller can do better than pick one", async () => {
    const { impl } = stubFetch([{ status: 409, body: { conflicts: [theirRow] } }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    const mine = annot({ subject: "My edit" });
    const error = await rejection(adapter.save(KEY, [{ op: "upsert", annot: mine, baseVersion: 2 }]));

    expect(error.conflicts).toHaveLength(1);
    expect(error.conflicts[0]!.mine?.subject).toBe("My edit");
    expect(error.conflicts[0]!.theirs?.subject).toBe("Their edit");
    expect(error.conflicts[0]!.theirs?.version).toBe(7);
  });

  it("accepts a bare array as the conflict body", async () => {
    const { impl } = stubFetch([{ status: 409, body: [theirRow] }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    const error = await rejection(adapter.save(KEY, [{ op: "upsert", annot: annot(), baseVersion: 2 }]));
    expect(error.ids).toEqual(["an_1"]);
  });

  it("still produces a usable error when the server says nothing useful", async () => {
    // A 409 with no body is unhelpful but must not become an unhandled parse failure.
    const { impl } = stubFetch([{ status: 409 }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    const error = await rejection(adapter.save(KEY, [{ op: "upsert", annot: annot(), baseVersion: 2 }]));
    expect(error.ids).toEqual(["an_1"]);
    expect(error.conflicts[0]!.theirs).toBeUndefined();
  });

  it("names only the rows the server rejected, when it says which", async () => {
    const { impl } = stubFetch([{ status: 409, body: { conflicts: [theirRow] } }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    const mutations: Mutation[] = [
      { op: "upsert", annot: annot(), baseVersion: 2 },
      { op: "upsert", annot: annot({ id: "an_2" }), baseVersion: 5 },
    ];
    const error = await rejection(adapter.save(KEY, mutations));
    // Only an_1 moved on; an_2 is not reported as conflicted.
    expect(error.ids).toEqual(["an_1"]);
  });

  it("reads as one sentence for one conflict and a count for several", () => {
    expect(new ConflictError([{ id: "a" }]).message).toMatch(/markup a was changed/);
    expect(new ConflictError([{ id: "a" }, { id: "b" }]).message).toMatch(/2 markups were changed/);
  });

  it("surfaces a conflict on a delete too", async () => {
    const { impl } = stubFetch([{ status: 409, body: { conflicts: [theirRow] } }]);
    const adapter = new RestAdapter({ baseUrl: "/api", fetchImpl: impl });
    await expect(adapter.save(KEY, [{ op: "remove", id: "an_1", baseVersion: 2 }]))
      .rejects.toBeInstanceOf(ConflictError);
  });
});
