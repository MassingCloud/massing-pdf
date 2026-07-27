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
 * Evaluate an SPDX expression against {@link ALLOWED}.
 *
 * `OR` is a choice, so one acceptable option is enough. `AND` is a conjunction — the package is
 * offered under *all* of them at once, so every term has to be acceptable. Collapsing the two, or
 * matching the whole expression as a literal string, gets `(MIT AND Zlib)` wrong in opposite
 * directions.
 */
function isAllowed(expression) {
  const clean = expression.replace(/\bWITH\s+[\w.-]+/gi, "").trim();
  return clean
    .split(/\s+OR\s+/i)
    .some((alternative) => alternative
      .split(/\s+AND\s+/i)
      .every((term) => ALLOWED.has(term.replace(/[()]/g, "").trim())));
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
        if (!isAllowed(licence)) offenders.push({ name: pkg.name, version: pkg.version, licence });
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

console.log(`licences OK (${total} packages, ${counts.size} distinct licences, all permissive)`);
