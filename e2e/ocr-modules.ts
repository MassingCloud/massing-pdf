/**
 * OCR engines, imported where the dev server can resolve them.
 *
 * Code inside `page.evaluate` is serialised and run as raw JavaScript in the browser — it never
 * passes through Vite, so a bare specifier like `ppu-paddle-ocr/web` reaches the browser unresolved
 * and throws. A module *served* by the dev server does get transformed, so the benchmark imports
 * this and hands the results to the providers' `load` option.
 *
 * Deliberately not in `demo/`: the demo bundle should not carry an ONNX runtime that only a
 * benchmark uses.
 */
export const loadPaddle = () => import("ppu-paddle-ocr/web");
export const loadTesseract = () => import("tesseract.js");
