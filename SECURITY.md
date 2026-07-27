# Security policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/MassingCloud/massing-pdf/security/advisories/new).
Please do not open a public issue for a suspected vulnerability.

Include what you need to make it reproducible: the version, a PDF or markup record that triggers it
if one is involved, and what you expected instead. If you have a proof of concept, a private
advisory is the right place for it.

We aim to acknowledge within three working days and to agree a disclosure timeline with you. Credit
in the advisory unless you would rather not be named.

## Supported versions

Pre-1.0. Only the latest minor line receives fixes; there are no backports to earlier `0.x`
versions. This will change when 1.0 ships — see [docs/publishing.md](docs/publishing.md).

## What this library does and does not defend against

Being explicit, because the boundary decides whose problem a given risk is.

### Treated as untrusted input

- **PDF bytes.** Parsing is delegated to `pdfjs-dist`, which runs the parser in a Web Worker.
  Vulnerabilities in PDF parsing are pdf.js issues; keep the peer dependency current.
- **Markup records**, wherever they come from — the storage adapter, an XFDF or BCF import, a live
  sync from another user. Records carry author-controlled strings and URLs. All text is written with
  `textContent`, never `innerHTML`; attachment URLs are vetted by `core/url.ts` before they reach
  `window.open` or a `src`, which is what stops a record carrying `javascript:` from executing when
  a reviewer clicks it.
- **OCR provider responses**, which are treated as data and never evaluated.

### Explicitly not defended against

- **A compromised host page.** The library runs in the host's origin with the host's privileges.
  Anything already executing there can do whatever the library can.
- **A malicious user with a valid session.** The permission model (`core/policy.ts`) is enforced in
  the store rather than in the toolbar, so it holds against ordinary use and against a host's own
  scripting. It is still *client-side* and cannot bind someone who controls their own browser. The
  server remains the authority; the client check exists so the interface agrees with the server and
  so every attempt is recorded.
- **Denial of service through pathological input.** A PDF crafted to be enormous, or a markup set of
  unbounded size, will make the tab slow. Rasterisation is tiled and budgeted, but no work is done
  to bound adversarial input.

## Handling credentials

**Do not put an OCR API key in browser code.** It ships in your bundle, it is readable in devtools,
and it is billable by whoever finds it. Every provider in `plugins/ocr-providers.ts` accepts a
`proxy` URL, which is the supported path: your server holds the credential and forwards the request.
The `key` and `apiKey` options exist for local development and for genuinely trusted internal
networks, and log a warning when used from a page that is not localhost.

## Content-Security-Policy

The library runs under a strict policy with no `unsafe-eval` and no `unsafe-inline` for scripts.
This is verified on every CI run by `e2e/csp.spec.ts`, which loads the built demo behind a real CSP
header and asserts that a drawing still rasterises with zero violations. See
[docs/security.md](docs/security.md) for the policy to copy.

## Dependencies

There are no runtime dependencies. `pdfjs-dist` and `pdf-lib` are peer dependencies supplied by the
host, so you control their versions and their patch cadence. Everything else is a devDependency and
does not reach production. Licence posture is Apache-2.0 / MIT throughout — deliberately, since a
copyleft dependency here would propagate into every consumer.
