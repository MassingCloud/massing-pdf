# Browser support

| Engine | Supported | Verified by |
|---|---|---|
| Chromium (Chrome, Edge) | last 2 major versions | full Playwright suite on every CI run |
| WebKit (Safari 16.4+) | last 2 major versions | full Playwright suite on every CI run |
| Firefox (115 ESR+) | last 2 major versions | full Playwright suite on every CI run |
| Chromium on touch/pen devices | yes | separate `hasTouch` project — pinch, two-finger pan, stylus, palm rejection |
| Internet Explorer | no | — |

"Verified by" is literal: these are not compatibility claims from a support matrix, they are the
same 130-odd browser tests running against each engine. Canvas size limits, pointer and touch
dispatch and IndexedDB semantics are exactly where engines disagree, which is why all three run
rather than one standing in for the others.

## Touch and pen

Touch and pen events are driven through the Chrome DevTools Protocol, which Firefox and WebKit do
not expose, so those specs run only on the Chromium touch project. The *code paths* are engine-
neutral (Pointer Events throughout, no vendor branches), but the behaviour is only proven on
Chromium. Treat stylus support on iPad Safari as expected-to-work rather than verified.

## Requirements

- ES2022. The package ships ESM only; there is no CommonJS or UMD build.
- `ResizeObserver`, `IntersectionObserver`, Pointer Events, Web Workers.
- IndexedDB, for the offline adapter only — the viewer degrades to in-memory storage without it.
- `OffscreenCanvas` is used where available and is not required.

## The pdf.js version sets part of this floor

`pdfjs-dist` is a peer, so you choose the version — but it is not a free choice. From **6.2** pdf.js
uses Iterator Helpers, which need Chrome 122+, Firefox 131+ and Safari 18.4+, well above the floor
above. It also drops Node 20, which matters for server-side rendering and for test environments.

This repo therefore tests against the `6.1.x` line. The peer range stays `^6.0.0` — narrowing it
would be a breaking change for consumers already on 6.2 — but if you take 6.2 or later, the browser
support you can promise is pdf.js's, not this table's.

## Known engine differences

- **Firefox could not be launched on the primary development machine** (`spawn UNKNOWN`, a Windows
  environment issue rather than a code one). It runs in CI on Linux, which is where the Firefox
  results above come from. Locally, verify with
  `--project=chromium --project=chromium-touch --project=webkit`.
- **Per-canvas size limits differ** between engines, which is why rasterisation is tiled with a
  budget rather than sized to the page. Exceeding a limit does not throw — the browser silently
  yields a blank canvas, which is the failure the tiling exists to prevent.
- **Text-layer selection** behaves differently enough across engines that the text layer is switched
  off under view rotation rather than mis-placing selections.
