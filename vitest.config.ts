import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // happy-dom rather than jsdom: it implements enough SVG and DOM for the renderer and the panel
    // code, and starts fast enough that the whole suite stays a sub-second feedback loop.
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
});
