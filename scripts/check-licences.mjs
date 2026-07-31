#!/usr/bin/env node
/**
 * Fail if a dependency arrives under a licence this project cannot accept.
 *
 * "Permissive licences only" is a stated constraint, not a preference: this library is built to be
 * embedded in other people's products, and a copyleft dependency anywhere in the tree propagates
 * its terms to every consumer. It is also the reason there is no PyMuPDF equivalent here.
 *
 * A transitive dependency can introduce one without anyone noticing, so it is checked rather than
 * asserted. Run with `--list` to print the full breakdown.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "node_modules");

/**
 * Does anything here actually ship?
 *
 * With no runtime dependencies, the tree is build tooling and peers, and the weak-copyleft
 * allowance below is safe. Add a runtime dependency and it stops being safe, so this fails loudly
 * rather than letting the allowance widen by accident.
 */
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runtimeDeps = Object.keys(manifest.dependencies ?? {});
const shipsNothing = runtimeDeps.length === 0;
if (!shipsNothing) {
  console.error(`This package now has runtime dependencies (${runtimeDeps.join(", ")}), which ship`);
  console.error("to every consumer. The weak-copyleft allowance in this script assumed nothing");
  console.error("shipped. Re-check it before proceeding — an MPL-2.0 file reaching a consumer is");
  console.error("a different question entirely.");
  process.exit(1);
}

/**
 * Licences that may appear.
 *
 * Additions belong in a pull request with a reason, which is the point of an explicit list rather
 * than a "does it look copyleft" heuristic.
 */
const ALLOWED = new Set([
  "MIT", "MIT-0", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "BlueOak-1.0.0", "Unlicense", "CC0-1.0", "Python-2.0", "Zlib", "WTFPL",
]);

/**
 * Additionally tolerated while nothing in the tree can reach a consumer.
 *
 * MPL-2.0 is *file-level* copyleft: it obliges you to publish changes you make to the covered files
 * themselves, and reaches no further. It does not cover code that merely uses the library, and a
 * build tool's output is not a derivative work of the tool — `lightningcss`, which Vite 8 uses to
 * transform CSS, is the case that brought this up.
 *
 * This is only sound because the published package has **no runtime dependencies at all**: every
 * package scanned here is build tooling or a peer the host installs itself, so none of it ships.
 * That assumption is checked below rather than trusted, because it is exactly the sort of thing
 * that quietly stops being true.
 */
const BUILD_ONLY = new Set(["MPL-2.0"]);

/**
 * Evaluate an SPDX expression against {@link ALLOWED}.
 *
 * `OR` is a choice, so one acceptable option is enough. `AND` is a conjunction — the package is
 * offered under *all* of them at once, so every term has to be acceptable. Collapsing the two, or
 * matching the whole expression as a literal string, gets `(MIT AND Zlib)` wrong in opposite
 * directions.
 */
function isAllowed(expression, extra = new Set()) {
  const clean = expression.replace(/\bWITH\s+[\w.-]+/gi, "").trim();
  return clean
    .split(/\s+OR\s+/i)
    .some((alternative) => alternative
      .split(/\s+AND\s+/i)
      .every((term) => {
        const t = term.replace(/[()]/g, "").trim();
        return ALLOWED.has(t) || extra.has(t);
      }));
}

/** Normalise the several shapes `license` takes across the registry's history. */
function licenceOf(pkg) {
  const raw = pkg.license ?? pkg.licenses;
  if (!raw) return "UNKNOWN";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((l) => (typeof l === "string" ? l : l?.type ?? "UNKNOWN")).join(" OR ");
  return raw.type ?? "UNKNOWN";
}

const counts = new Map();
const offenders = [];

function walk(dir, depth = 0) {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".bin" || entry === ".cache") continue;
    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    const manifest = join(path, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name && pkg.version) {
        const licence = licenceOf(pkg);
        counts.set(licence, (counts.get(licence) ?? 0) + 1);
        if (!isAllowed(licence, BUILD_ONLY)) offenders.push({ name: pkg.name, version: pkg.version, licence });
      }
    } catch { /* not a package directory */ }

    walk(join(path, "node_modules"), depth + 1);
    if (entry.startsWith("@")) walk(path, depth);
  }
}

walk(modules);

const total = [...counts.values()].reduce((a, b) => a + b, 0);
if (total === 0) {
  console.error("no packages found — run `npm ci` first");
  process.exit(1);
}

if (process.argv.includes("--list")) {
  for (const [licence, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(String(n).padStart(5), licence);
  }
  console.log();
}

if (offenders.length) {
  console.error(`Disallowed or unknown licences in ${offenders.length} package(s):`);
  for (const o of offenders) console.error(`  ${o.name}@${o.version} — ${o.licence}`);
  console.error("\nIf one of these is genuinely acceptable, add it to ALLOWED in this script with a reason.");
  process.exit(1);
}

const weak = [...counts].filter(([l]) => !isAllowed(l) && isAllowed(l, BUILD_ONLY));
for (const [licence, n] of weak) {
  console.log(`note: ${n} build-time package(s) under ${licence} — permitted because nothing here ships`);
}
console.log(`licences OK (${total} packages, ${counts.size} distinct licences)`);
