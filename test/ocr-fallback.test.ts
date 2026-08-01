import { describe, expect, it, vi } from "vitest";
import { fallbackOcrProvider } from "../src/plugins/ocr-providers";
import type { OcrInput, OcrProvider, OcrResult } from "../src/plugins/ocr";

/**
 * The fallback chain.
 *
 * The case that matters is not a bad tile, it is a provider that cannot work at all — a missing
 * model file, a rejected key, no network. A drawing set is thousands of tiles, so "try it every
 * time" turns one misconfiguration into thousands of timeouts before any work happens.
 */

const tile = (): OcrInput => ({
  page: 1,
  canvas: {} as HTMLCanvasElement,
  width: 1024, height: 1024, scale: 4, offset: { x: 0, y: 0 }, index: 0, count: 1,
});

/** A provider that answers however the test tells it to. */
function stub(id: string, behaviour: () => OcrResult | never): OcrProvider & { calls: number } {
  const provider = {
    id,
    calls: 0,
    async recognise() {
      provider.calls++;
      return behaviour();
    },
  };
  return provider;
}

const works = (text = "A-101") => () => ({ words: [{ text, x: 0, y: 0, w: 10, h: 10, confidence: 0.9 }] });
const fails = (message: string) => () => { throw new Error(message); };
const empty = () => ({ words: [] });

describe("falling through", () => {
  it("uses the first provider that works", async () => {
    const first = stub("paddle", works("from paddle"));
    const second = stub("tesseract", works("from tesseract"));
    const chain = fallbackOcrProvider([first, second]);

    const result = await chain.recognise(tile());
    expect(result.words[0]?.text).toBe("from paddle");
    expect(second.calls).toBe(0);
  });

  it("moves to the next when the first throws", async () => {
    const first = stub("paddle", fails("models not found"));
    const second = stub("tesseract", works("from tesseract"));
    const chain = fallbackOcrProvider([first, second]);

    expect((await chain.recognise(tile())).words[0]?.text).toBe("from tesseract");
  });

  it("reports the switch, because degrading silently is the problem", async () => {
    // Falling from a local engine to a cloud one changes where the drawing goes and who is billed.
    const onFallback = vi.fn();
    const chain = fallbackOcrProvider(
      [stub("paddle", fails("no models")), stub("azure", works())],
      { onFallback },
    );
    await chain.recognise(tile());
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback.mock.calls[0]?.[0]?.id).toBe("paddle");
    expect(onFallback.mock.calls[0]?.[2]?.id).toBe("azure");
  });

  it("names every failure when nothing works", async () => {
    const chain = fallbackOcrProvider([stub("a", fails("boom")), stub("b", fails("bang"))]);
    await expect(chain.recognise(tile())).rejects.toThrow(/a: boom.*b: bang/);
  });

  it("keeps a blank tile by default, since most of a drawing is blank", async () => {
    const second = stub("tesseract", works());
    const chain = fallbackOcrProvider([stub("paddle", empty), second]);
    expect((await chain.recognise(tile())).words).toEqual([]);
    expect(second.calls).toBe(0);
  });

  it("retries a blank tile when asked to", async () => {
    const chain = fallbackOcrProvider(
      [stub("paddle", empty), stub("tesseract", works("found it"))],
      { emptyIsFailure: true },
    );
    expect((await chain.recognise(tile())).words[0]?.text).toBe("found it");
  });
});

describe("giving up on a broken provider", () => {
  it("stops trying one that keeps failing", async () => {
    const broken = stub("paddle", fails("models not found"));
    const good = stub("tesseract", works());
    const chain = fallbackOcrProvider([broken, good], { giveUpAfter: 3 });

    for (let i = 0; i < 10; i++) await chain.recognise(tile());
    // Three strikes, then never again — not ten, and not once per tile of a 3,000-tile set.
    expect(broken.calls).toBe(3);
    expect(good.calls).toBe(10);
  });

  it("says so, once", async () => {
    const onGiveUp = vi.fn();
    const chain = fallbackOcrProvider(
      [stub("paddle", fails("no models")), stub("tesseract", works())],
      { giveUpAfter: 2, onGiveUp },
    );
    for (let i = 0; i < 5; i++) await chain.recognise(tile());
    expect(onGiveUp).toHaveBeenCalledOnce();
    expect(onGiveUp.mock.calls[0]?.[0]?.id).toBe("paddle");
  });

  it("forgives a provider that recovers", async () => {
    // An intermittent failure must not accumulate across a whole set and retire an engine that is
    // basically fine.
    let failNext = true;
    const flaky = stub("paddle", () => {
      if (failNext) { failNext = false; throw new Error("one bad tile"); }
      return works()();
    });
    const chain = fallbackOcrProvider([flaky, stub("tesseract", works())], { giveUpAfter: 2 });

    await chain.recognise(tile());          // fails once, falls through
    for (let i = 0; i < 5; i++) await chain.recognise(tile());   // succeeds from here
    failNext = true;
    await chain.recognise(tile());          // one more isolated failure
    await chain.recognise(tile());

    // Still in play: the successes cleared the record between failures.
    expect(flaky.calls).toBeGreaterThan(6);
  });

  it("does not count a blank tile against the provider", async () => {
    // Most of a drawing is blank. Counting an empty result as ill-health retired the primary engine
    // after three tiles of margin and sent the rest of the set to the fallback, which is a cost and
    // privacy change nobody chose.
    const blank = stub("paddle", empty);
    const backup = stub("tesseract", works());
    const chain = fallbackOcrProvider([blank, backup], { emptyIsFailure: true, giveUpAfter: 3 });

    for (let i = 0; i < 10; i++) await chain.recognise(tile());
    // Still asked every time: it was never broken, the sheet was just empty there.
    expect(blank.calls).toBe(10);
  });

  it("announces the give-up once even when failures overlap", async () => {
    // `fallbackOcrProvider` is exported, so a host may drive it concurrently. Two in-flight
    // failures could both cross the threshold and each fire the callback.
    const onGiveUp = vi.fn();
    const chain = fallbackOcrProvider(
      [stub("paddle", fails("no models")), stub("tesseract", works())],
      { giveUpAfter: 2, onGiveUp },
    );
    await Promise.all(Array.from({ length: 8 }, () => chain.recognise(tile())));
    expect(onGiveUp).toHaveBeenCalledOnce();
  });

  it("fails loudly once every provider has been dropped", async () => {
    const chain = fallbackOcrProvider(
      [stub("a", fails("x")), stub("b", fails("y"))],
      { giveUpAfter: 1 },
    );
    await expect(chain.recognise(tile())).rejects.toThrow();
    await expect(chain.recognise(tile())).rejects.toThrow(/dropped after repeated failures/);
  });

  it("retries forever when told to", async () => {
    const broken = stub("paddle", fails("flaky network"));
    const chain = fallbackOcrProvider([broken, stub("tesseract", works())], { giveUpAfter: 0 });
    for (let i = 0; i < 6; i++) await chain.recognise(tile());
    expect(broken.calls).toBe(6);
  });
});

describe("construction", () => {
  it("refuses an empty chain rather than failing later", async () => {
    expect(() => fallbackOcrProvider([])).toThrow(/at least one provider/);
  });

  it("names what it is made of, for logs", () => {
    const chain = fallbackOcrProvider([stub("paddle", works()), stub("tesseract", works())]);
    expect(chain.id).toBe("fallback(paddle → tesseract)");
  });

  it("disposes everything it wraps", async () => {
    const disposed: string[] = [];
    const make = (id: string): OcrProvider => ({
      id,
      recognise: async () => ({ words: [] }),
      dispose: () => { disposed.push(id); },
    });
    await fallbackOcrProvider([make("a"), make("b")]).dispose?.();
    expect(disposed).toEqual(["a", "b"]);
  });
});
