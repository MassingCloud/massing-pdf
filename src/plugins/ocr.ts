/**
 * OCR for scanned sheets.
 *
 * Scanned drawings and archive material carry no text layer, so search, spec parsing and
 * title-block extraction all return nothing on them. They degrade gracefully — but they degrade to
 * empty, which is the single thing that most limits this engine on real archive work.
 *
 * **The engine is not bundled.** Two constraints pull opposite ways: the viewer must run fully
 * offline (so a server call is not always available), and it must stay a library you can drop into
 * an app (so several megabytes of WASM cannot be a default dependency). Resolving that by picking
 * one would be wrong for half of all consumers, so OCR is a *provider interface*: this plugin owns
 * the rasterisation, the coordinate mapping and the wiring into search and specs, and the host
 * supplies the recogniser — a server endpoint, a bundled WASM engine, or a cloud API.
 *
 * `tesseractProvider()` is included for the offline case and dynamically imports `tesseract.js`, so
 * a consumer that never calls it pays nothing.
 */
import { definePlugin } from "../core/plugin";
import type { TextItem } from "../core/document";
import type { Viewer } from "../core/viewer";

/** A page rendered for recognition. */
export interface OcrInput {
  page: number;
  /** The rasterised page. Providers that need bytes can call `canvas.toBlob`. */
  canvas: HTMLCanvasElement;
  /** Raster size in pixels. */
  width: number;
  height: number;
  /** Pixels per PDF point, for mapping results back to page space. */
  scale: number;
}

/** One recognised word, in **raster pixels**. The plugin converts to page space. */
export interface OcrWord {
  text: string;
  x: number; y: number; w: number; h: number;
  /** 0..1. Words below `minConfidence` are dropped. */
  confidence?: number;
}

export interface OcrResult {
  words: OcrWord[];
}

export interface OcrProvider {
  id: string;
  recognise(input: OcrInput): Promise<OcrResult>;
  /** Release any engine resources. */
  dispose?(): Promise<void> | void;
}

export interface OcrOptions {
  provider?: OcrProvider;
  /** Raster resolution for recognition, px on the long edge. 300 DPI on a D sheet is ~10 800. */
  resolution?: number;
  /** Drop words the engine is less sure of than this. */
  minConfidence?: number;
  /** Recognise every text-less page as soon as a document loads. Off by default — it is expensive. */
  auto?: boolean;
}

export function ocrPlugin(options: OcrOptions = {}) {
  const minConfidence = options.minConfidence ?? 0.4;
  const resolution = options.resolution ?? 2600;

  return definePlugin({
    id: "ocr",
    order: 12,
    setup(ctx) {
      const provider = options.provider;
      let busy = false;

      ctx.onCleanup(() => { void provider?.dispose?.(); });

      const recognisePage = async (v: Viewer, page: number): Promise<number> => {
        if (!provider || !v.doc) return 0;
        const input = await rasterise(v, page, resolution);
        const { words } = await provider.recognise(input);
        const items = toTextItems(words, input.scale, minConfidence);
        v.setRecognisedText(page, items);
        return items.length;
      };

      const run = async (v: Viewer, pages: number[]): Promise<void> => {
        if (!provider) {
          v.bus.emit("notice", {
            level: "warn",
            message: "No OCR engine configured — pass a provider to ocrPlugin() to read scanned sheets.",
          });
          return;
        }
        if (busy) return;
        busy = true;
        let total = 0;
        try {
          for (let i = 0; i < pages.length; i++) {
            const page = pages[i]!;
            v.bus.emit("notice", { level: "info", message: `Reading page ${page} (${i + 1} of ${pages.length})…` });
            total += await recognisePage(v, page);
          }
          v.bus.emit("notice", {
            level: total ? "success" : "warn",
            message: total
              ? `Recognised ${total} words across ${pages.length} page${pages.length === 1 ? "" : "s"}. Search and specifications now cover them.`
              : "No text recognised on those pages.",
          });
        } catch (e) {
          v.bus.emit("notice", { level: "error", message: `OCR failed: ${(e as Error).message}` });
        } finally {
          busy = false;
        }
      };

      /** Pages with neither a text layer nor recognised text. */
      const pending = async (v: Viewer): Promise<number[]> => {
        const out: number[] = [];
        for (let p = 1; p <= v.numPages; p++) if (await v.needsText(p)) out.push(p);
        return out;
      };

      ctx.registerAction({
        id: "ocr.page", label: "Read this page (OCR)", icon: "👁", group: "archive",
        enabled: (v) => Boolean(provider && v.doc),
        run: (v) => run(v, [v.page]),
      });

      ctx.registerAction({
        id: "ocr.document", label: "Read every scanned page (OCR)", icon: "👁▤", group: "archive",
        enabled: (v) => Boolean(provider && v.doc),
        async run(v) {
          const pages = await pending(v);
          if (!pages.length) {
            v.bus.emit("notice", { level: "info", message: "Every page already has text — nothing to recognise." });
            return;
          }
          await run(v, pages);
        },
      });

      if (options.auto) {
        ctx.bus.on("doc:loaded", () => {
          void (async () => {
            const pages = await pending(ctx.viewer);
            if (pages.length) await run(ctx.viewer, pages);
          })();
        });
      }

      ctx.viewer.ocr = {
        available: () => Boolean(provider),
        recognisePage: (page: number) => recognisePage(ctx.viewer, page),
        recogniseDocument: async () => { await run(ctx.viewer, await pending(ctx.viewer)); },
        pendingPages: () => pending(ctx.viewer),
      };
    },
  });
}

/** Render a page for recognition. Higher resolution than the screen — OCR accuracy tracks DPI. */
async function rasterise(v: Viewer, page: number, resolution: number): Promise<OcrInput> {
  const doc = v.doc!;
  const info = await doc.pageInfo(page);
  const scale = resolution / Math.max(info.width, info.height);
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  const pg = await doc.page(page);
  await pg.render({ canvas, canvasContext: ctx, viewport: pg.getViewport({ scale }) }).promise;

  return { page, canvas, width, height, scale };
}

/**
 * Recognised words → the same `TextItem` shape pdf.js produces, in page space.
 *
 * Emitting the *native* shape is the whole trick: search, spec parsing and title-block extraction
 * all consume `TextItem`, so once OCR output is in that shape none of them needs to know whether a
 * page's text came from the PDF or from a recogniser.
 */
export function toTextItems(words: readonly OcrWord[], scale: number, minConfidence = 0.4): TextItem[] {
  return words
    .filter((w) => w.text.trim() && (w.confidence ?? 1) >= minConfidence)
    .map((w) => ({
      str: w.text,
      x: w.x / scale,
      y: w.y / scale,
      w: w.w / scale,
      h: w.h / scale,
    }));
}

/**
 * A Tesseract-backed provider, loaded on demand.
 *
 * `tesseract.js` is not a dependency of this package — install it in the host if you want offline
 * OCR. The dynamic import means a consumer who never calls this function never downloads it.
 */
export function tesseractProvider(opts: { lang?: string; workerPath?: string; corePath?: string; langPath?: string } = {}): OcrProvider {
  type TesseractWorker = {
    recognize(image: HTMLCanvasElement): Promise<{ data: { words?: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] } }>;
    terminate(): Promise<void>;
  };
  let worker: TesseractWorker | null = null;

  const ensure = async (): Promise<TesseractWorker> => {
    if (worker) return worker;
    type TesseractModule = { createWorker: (lang?: string, oem?: number, config?: object) => Promise<TesseractWorker> };
    let mod: TesseractModule;
    try {
      // The specifier is indirect on purpose. `tesseract.js` is not a dependency of this package,
      // so a literal import would fail typecheck here and make bundlers try to resolve a module
      // most consumers will never install.
      const specifier = "tesseract.js";
      mod = (await import(/* @vite-ignore */ specifier)) as TesseractModule;
    } catch {
      throw new Error(
        "tesseractProvider() needs `tesseract.js` installed in the host application " +
        "(npm install tesseract.js), or supply your own OcrProvider.",
      );
    }
    worker = await mod.createWorker(opts.lang ?? "eng", 1, {
      ...(opts.workerPath ? { workerPath: opts.workerPath } : {}),
      ...(opts.corePath ? { corePath: opts.corePath } : {}),
      ...(opts.langPath ? { langPath: opts.langPath } : {}),
    });
    return worker;
  };

  return {
    id: "tesseract",
    async recognise({ canvas }) {
      const w = await ensure();
      const { data } = await w.recognize(canvas);
      return {
        words: (data.words ?? []).map((word) => ({
          text: word.text,
          x: word.bbox.x0,
          y: word.bbox.y0,
          w: word.bbox.x1 - word.bbox.x0,
          h: word.bbox.y1 - word.bbox.y0,
          // Tesseract reports 0..100.
          confidence: word.confidence / 100,
        })),
      };
    },
    async dispose() {
      await worker?.terminate();
      worker = null;
    },
  };
}

/**
 * A provider that posts the page image to a server endpoint. The response must be
 * `{ words: [{ text, x, y, w, h, confidence? }] }` in raster pixels.
 */
export function restOcrProvider(opts: {
  url: string;
  headers?: () => Record<string, string>;
  fieldName?: string;
}): OcrProvider {
  return {
    id: "rest",
    async recognise({ canvas, page }) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("could not encode the page image");
      const form = new FormData();
      form.append(opts.fieldName ?? "image", blob, `page-${page}.png`);
      form.append("page", String(page));
      const res = await fetch(opts.url, { method: "POST", body: form, headers: opts.headers?.() });
      if (!res.ok) throw new Error(`OCR service returned HTTP ${res.status}`);
      return (await res.json()) as OcrResult;
    },
  };
}

declare module "../core/viewer" {
  interface Viewer {
    /** Present once the OCR plugin is installed. */
    ocr?: {
      available(): boolean;
      recognisePage(page: number): Promise<number>;
      recogniseDocument(): Promise<void>;
      pendingPages(): Promise<number[]>;
    };
  }
}
