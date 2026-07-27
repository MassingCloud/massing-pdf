// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-demo/**", "node_modules/**", "coverage/**", "playwright-report/**", "test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    rules: {
      // The codebase leans on `!` where an index is provably in bounds and the alternative is a
      // defensive branch that can never run; `noUncheckedIndexedAccess` already forces the thought.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
  {
    files: ["test/**/*.ts", "e2e/**/*.ts", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
