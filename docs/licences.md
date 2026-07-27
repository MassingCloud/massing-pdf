# Dependency licences

**Permissive only — Apache-2.0 and MIT-family.** Not a preference: this library is built to be
embedded in other people's products, so a copyleft dependency anywhere in the tree would propagate
its terms to every consumer. It is also why there is no PyMuPDF equivalent here, despite PyMuPDF
being the better PDF toolkit in several respects.

Checked on every CI run by `npm run check:licences`, which walks the installed tree rather than
trusting a manifest, and fails the build on anything outside an explicit allowlist. Adding to that
list requires a pull request with a reason.

## Current state

At the last audit: **249 packages, 9 distinct licences, zero copyleft, zero unknown.**

| Count | Licence |
|---:|---|
| 198 | MIT |
| 19 | Apache-2.0 |
| 12 | ISC |
| 9 | BSD-2-Clause |
| 6 | BSD-3-Clause |
| 2 | BlueOak-1.0.0 |
| 1 | Python-2.0 |
| 1 | (MIT AND Zlib) |
| 1 | 0BSD |

Reproduce with:

```bash
npm run check:licences -- --list
```

Almost all of these are development-time only. The shipped package has **no runtime dependencies**;
`pdfjs-dist` (Apache-2.0) and `pdf-lib` (MIT) are peer dependencies supplied by the host.

## How expressions are evaluated

SPDX `OR` is a choice, so one acceptable option is enough. `AND` is a conjunction — the package is
offered under all of those terms simultaneously, so every one must be acceptable. `pako`'s
`(MIT AND Zlib)` passes because both are permissive; it would fail if either were not.

## This project's own licence

MIT — see [LICENSE](../LICENSE).
