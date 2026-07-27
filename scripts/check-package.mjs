#!/usr/bin/env node
/**
 * Verify the manifest's entry points exist in the built output.
 *
 * `npm publish` does not check this. A wrong path in `exports` produces a tarball that installs
 * cleanly and then fails at the consumer's first `import` — the one failure mode we cannot fix
 * without shipping another version, since npm forbids republishing a version.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

/** Every file path the manifest promises a consumer can resolve. */
function entryPoints(manifest) {
  const found = [];
  const walk = (value, where) => {
    if (typeof value === "string") {
      if (value.startsWith("./")) found.push({ path: value, where });
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, `${where}.${key}`);
    }
  };
  for (const field of ["main", "module", "types"]) {
    if (manifest[field]) found.push({ path: manifest[field], where: field });
  }
  walk(manifest.exports, "exports");
  return found;
}

const missing = [];
for (const entry of entryPoints(pkg)) {
  if (!existsSync(resolve(root, entry.path))) missing.push(entry);
}

// `files` is what actually ships. An entry point outside it resolves here and 404s once installed.
// Entries may be globs (`dist/**`, `dist/*.js`), so compare on the literal prefix before any
// wildcard rather than on the whole string — otherwise a correct manifest fails this check.
const shipped = new Set(
  (pkg.files ?? []).map((f) => f.replace(/^\.?\//, "").split("/")[0]).filter((seg) => !/[*?[{]/.test(seg)),
);
const unshipped = entryPoints(pkg).filter((entry) => {
  const top = entry.path.replace(/^\.\//, "").split("/")[0];
  return !shipped.has(top);
});

if (missing.length || unshipped.length) {
  for (const entry of missing) {
    console.error(`missing: ${entry.path} (referenced by ${entry.where}) — run the build first`);
  }
  for (const entry of unshipped) {
    console.error(`not shipped: ${entry.path} (referenced by ${entry.where}) is outside "files"`);
  }
  process.exit(1);
}

console.log(`package entry points OK (${entryPoints(pkg).length} checked)`);
