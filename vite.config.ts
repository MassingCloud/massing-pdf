import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

/**
 * Two builds from one config:
 *
 * - default — the library. `pdfjs-dist` and `pdf-lib` stay external so a host bundles exactly one
 *   copy of each; that matters most for the pdf.js worker, which breaks in confusing ways if two
 *   versions end up in the same page.
 * - `--mode demo` — the standalone app in `demo/`, which *does* bundle everything so it can be
 *   dropped on any static host (GitHub Pages included) and still run fully offline.
 */
export default defineConfig(({ mode }) => {
  if (mode === "demo") {
    return {
      root: resolve(__dirname, "demo"),
      base: "./",
      build: {
        outDir: resolve(__dirname, "dist-demo"),
        emptyOutDir: true,
        target: "es2022",
        rollupOptions: {
          // `tesseract.js` is an optional peer the OCR plugin reaches for only when a host has
          // configured the offline provider. Left unmarked, the demo build emits an unresolved
          // import that `vite preview` reports as an error at startup — noise that reads like a
          // failure in CI logs when nothing is actually wrong.
          external: ["tesseract.js"],
        },
      },
    };
  }

  return {
    build: {
      target: "es2022",
      sourcemap: true,
      lib: {
        entry: resolve(__dirname, "src/index.ts"),
        name: "MassingPdf",
        formats: ["es"],
        fileName: () => "massing-pdf.js",
      },
      rollupOptions: {
        external: ["pdfjs-dist", "pdf-lib", /^pdfjs-dist\//],
        output: { assetFileNames: "massing-pdf.[ext]" },
      },
    },
    plugins: [
      dts({
        include: ["src"],
        exclude: ["src/**/*.test.ts"],
        rollupTypes: false,
      }),
    ],
    server: { open: "/demo/index.html" },
  };
});
