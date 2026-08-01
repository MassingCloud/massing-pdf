import { describe, expect, it, vi } from "vitest";
import { paddleOcrProvider } from "../src/plugins/ocr-providers";
import type { OcrInput } from "../src/plugins/ocr";

/**
 * The PaddleOCR adapter.
 *
 * Everything here is about the seam rather than the engine: loading the module, mapping its boxes
 * into the plugin's word shape, and not rebuilding the engine once per tile. The recognition
 * quality itself is measured in `e2e/ocr-bench.spec.ts` against a real drawing, because that is the
 * only place it can honestly be measured.
 */

const tile = (): OcrInput => ({
  page: 1,
  canvas: {} as HTMLCanvasElement,
  width: 958, height: 500, scale: 4.1667,
  offset: { x: 2340, y: 1590 }, index: 0, count: 1,
});

/** A stand-in for `ppu-paddle-ocr/web`, so the adapter can be driven without ONNX. */
function fakeModule(results: { text: string; box: { x: number; y: number; width: number; height: number }; confidence: number }[]) {
  const built: { options: unknown; initialised: number; recognised: number } =
    { options: null, initialised: 0, recognised: 0 };

  class PaddleOcrService {
    constructor(options?: unknown) { built.options = options; }
    async initialize() { built.initialised++; }
    async recognize() {
      built.recognised++;
      return { results, text: results.map((r) => r.text).join(" "), confidence: 0.9 };
    }
    async destroy() { /* nothing to release in a stub */ }
  }
  return { module: { PaddleOcrService }, built };
}

const word = (text: string, confidence = 0.9) =>
  ({ text, box: { x: 10, y: 20, width: 30, height: 12 }, confidence });

describe("loading the engine", () => {
  it("uses an injected module", async () => {
    // The default import is deliberately opaque to bundlers, which also means the browser gets a
    // bare specifier it cannot resolve. `load` is the way out, and it is worth a test because the
    // first version of the benchmark reported a load failure and still passed.
    const { module, built } = fakeModule([word("A-101")]);
    const provider = paddleOcrProvider({ load: async () => module });

    const result = await provider.recognise(tile());
    expect(built.initialised).toBe(1);
    expect(result.words[0]?.text).toBe("A-101");
  });

  it("explains itself when the module will not load", async () => {
    const provider = paddleOcrProvider({ load: async () => { throw new Error("not installed"); } });
    await expect(provider.recognise(tile())).rejects.toThrow(/npm install ppu-paddle-ocr/);
    await expect(provider.recognise(tile())).rejects.toThrow(/not installed/);
  });

  it("rejects a module that is not the one we asked for", async () => {
    // A loader wired to the wrong entry point resolves fine and then fails later with something
    // unrelated to the actual mistake.
    const provider = paddleOcrProvider({ load: async () => ({ somethingElse: true }) });
    await expect(provider.recognise(tile())).rejects.toThrow(/no PaddleOcrService export/);
  });

  it("builds the engine once, not once per tile", async () => {
    // A drawing set is thousands of tiles. Constructing the service per tile would recompile the
    // ONNX graph every time.
    const { module, built } = fakeModule([word("x")]);
    const provider = paddleOcrProvider({ load: async () => module });
    for (let i = 0; i < 25; i++) await provider.recognise(tile());
    expect(built.initialised).toBe(1);
    expect(built.recognised).toBe(25);
  });

  it("shares one initialisation between concurrent tiles", async () => {
    const { module, built } = fakeModule([word("x")]);
    const provider = paddleOcrProvider({ load: async () => module });
    await Promise.all(Array.from({ length: 8 }, () => provider.recognise(tile())));
    expect(built.initialised).toBe(1);
  });

  it("can be retried after a failed start", async () => {
    // A first attempt that fails must not be cached as permanent — the models may simply not have
    // been served yet.
    let attempt = 0;
    const { module } = fakeModule([word("recovered")]);
    const provider = paddleOcrProvider({
      load: async () => {
        if (attempt++ === 0) throw new Error("models 404");
        return module;
      },
    });
    await expect(provider.recognise(tile())).rejects.toThrow();
    expect((await provider.recognise(tile())).words[0]?.text).toBe("recovered");
  });
});

describe("mapping results", () => {
  it("converts a box into the plugin's word shape", async () => {
    const { module } = fakeModule([
      { text: "SHEET NUMBER", box: { x: 12, y: 34, width: 120, height: 18 }, confidence: 0.82 },
    ]);
    const provider = paddleOcrProvider({ load: async () => module });
    const [w] = (await provider.recognise(tile())).words;
    // Raster pixels, left as-is: the tiling layer adds the offset and divides by scale.
    expect(w).toEqual({ text: "SHEET NUMBER", x: 12, y: 34, w: 120, h: 18, confidence: 0.82 });
  });

  it("drops words below the confidence floor", async () => {
    const { module } = fakeModule([word("solid", 0.95), word("guess", 0.2)]);
    const provider = paddleOcrProvider({ load: async () => module, minConfidence: 0.5 });
    const words = (await provider.recognise(tile())).words;
    expect(words.map((w) => w.text)).toEqual(["solid"]);
  });

  it("keeps everything when no floor is set", async () => {
    const { module } = fakeModule([word("solid", 0.95), word("guess", 0.05)]);
    const provider = paddleOcrProvider({ load: async () => module });
    expect((await provider.recognise(tile())).words).toHaveLength(2);
  });

  it("skips empty strings, which a detector can emit for a blank region", async () => {
    const { module } = fakeModule([word(""), word("real")]);
    const provider = paddleOcrProvider({ load: async () => module });
    expect((await provider.recognise(tile())).words.map((w) => w.text)).toEqual(["real"]);
  });
});

describe("configuration", () => {
  it("passes host-supplied models through, which is what keeps it offline", async () => {
    // Left unset the library fetches its defaults over the network, which breaks the viewer's
    // offline guarantee and puts a third party in the path of the drawings.
    const { module, built } = fakeModule([word("x")]);
    const detection = new ArrayBuffer(8);
    const provider = paddleOcrProvider({
      load: async () => module,
      models: { detection, recognition: "/models/rec.onnx" },
    });
    await provider.recognise(tile());
    expect(built.options).toMatchObject({
      model: { detection, recognition: "/models/rec.onnx" },
    });
  });

  it("reports how long the engine took to come up", async () => {
    // Initialisation is seconds, not milliseconds. A host that shows nothing looks broken.
    const onReady = vi.fn();
    const { module } = fakeModule([word("x")]);
    await paddleOcrProvider({ load: async () => module, onReady }).recognise(tile());
    expect(onReady).toHaveBeenCalledOnce();
    expect(typeof onReady.mock.calls[0]?.[0]).toBe("number");
  });

  it("releases an engine that was still starting when dispose was called", async () => {
    // The leak this closes: mid-load `service` is still null, so dispose destroyed nothing, and the
    // initialiser then assigned it afterwards — an ONNX session with its models loaded, owned by a
    // provider the host had already discarded.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let destroyed = 0;

    class Slow {
      async initialize() { await gate; }
      async recognize() { return { results: [], text: "", confidence: 0 }; }
      async destroy() { destroyed++; }
    }
    const provider = paddleOcrProvider({ load: async () => ({ PaddleOcrService: Slow }) });

    const inFlight = provider.recognise(tile()).catch(() => { /* disposed underneath it */ });
    await Promise.resolve();
    const disposing = provider.dispose?.();
    release();
    await Promise.all([inFlight, disposing]);

    expect(destroyed).toBe(1);
  });

  it("releases the engine on dispose, and can start again after", async () => {
    const { module, built } = fakeModule([word("x")]);
    const provider = paddleOcrProvider({ load: async () => module });
    await provider.recognise(tile());
    await provider.dispose?.();
    await provider.recognise(tile());
    expect(built.initialised).toBe(2);
  });
});
