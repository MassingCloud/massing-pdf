# Versioning and API stability

[Semantic versioning](https://semver.org). Currently pre-1.0, which under semver means the API may
change in a minor release — and here it means it genuinely might, while Massing is the only
consumer.

## What is covered

The public API is **what `src/index.ts` exports**, and nothing else. A deep import into
`src/plugins/…` or `dist/core/…` reaches real files, and they may be renamed or restructured in a
patch release without it counting as a break.

Also covered by semver:

- The `ViewerEvents` map — event names and payload shapes.
- The plugin contract: `ViewerPlugin`, `PluginContext`, and the tool/action/panel/renderer registries.
- The storage adapter contract, and the wire shape `RestAdapter` sends.
- Interchange output: XFDF, BCF, CSV and the flattened PDF must keep round-tripping.

## What is not covered

- CSS class names and the DOM structure of the panels. Style them at your own risk; use the plugin
  API to replace a panel rather than restyling its internals.
- Anything marked `@internal` in a doc comment.
- The demo application.
- The exact wording of user-facing strings.

## Before 1.0

- Breaking changes land in a **minor** bump (`0.1.x` → `0.2.0`) and are listed in the release notes.
- Bug fixes and additive changes land in a **patch** bump.

## After 1.0

- Breaking changes land in a **major** bump, and only there.
- Deprecations are announced one minor release ahead, keep working for the whole of the current
  major, and say what to use instead.

## Node and browsers

The supported Node range is in `engines`. Raising its floor is a breaking change and waits for a
major (a minor before 1.0). Dropping a browser engine from
[browser-support.md](browser-support.md) is treated the same way.

## Peer dependencies

`pdfjs-dist` and `pdf-lib` are peers so the host controls their versions. Widening a peer range is
additive. **Narrowing one, or raising its floor, is a breaking change** — it can make the package
uninstallable for a consumer who was fine a moment earlier — so Dependabot is configured not to
propose major bumps of either.
