# Security and deployment hardening

Operational guidance for running this in an enterprise environment. For reporting a vulnerability,
see [SECURITY.md](../SECURITY.md).

## Content-Security-Policy

The library needs no `unsafe-eval` and no `unsafe-inline` for scripts. This policy is exercised on
every CI run by `e2e/csp.spec.ts`, which serves the built demo behind it as a real response header
and asserts a drawing rasterises with zero violations:

```
default-src 'self';
script-src 'self' blob:;
worker-src 'self' blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' data: blob:;
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
```

Why each of the loosenings is there:

- **`blob:` in `script-src` and `worker-src`** — pdf.js runs its parser in a Web Worker, and most
  bundlers emit that worker as a blob URL. Without it nothing renders at all. If your bundler emits
  the worker as a same-origin file instead, drop `blob:` from `script-src`.
- **`'unsafe-inline'` in `style-src`** — the viewer positions pages, tiles and the text layer by
  writing to `element.style`. That is CSSOM, which a policy does *not* block; the directive is here
  because pdf.js's text layer sets inline styles on the spans it creates. There is no way to use a
  nonce for that. Note this is `style-src`, not `script-src`: inline styles cannot execute script.
- **`data:` in `img-src` and `connect-src`** — attachments captured on a device with no upload
  endpoint are stored as data URLs, and the demo generates its sample PDF as one.

`frame-ancestors 'none'` is not required by the library; include it unless you intend the viewer to
be embedded in an iframe by another origin.

## Permissions

`core/policy.ts` enforces a capability check inside the annotation store, which is the seam every
mutation crosses — tool, keyboard shortcut, import, storage adapter, and any host script holding a
reference to the viewer.

```ts
import { createViewer, capabilityCheck } from "@massingcloud/pdf-viewer";

const viewer = await createViewer({
  container,
  author: currentUser.name,
  permissions: capabilityCheck({
    granted: ["markup:create", "markup:edit", "markup:status", "export"],
  }),
});
```

Capabilities are about *acts*, not about buttons:

| Capability | Covers |
|---|---|
| `markup:create` | drawing a new markup |
| `markup:edit` | changing a markup's geometry or content |
| `markup:editOthers` | doing that to a markup someone else authored |
| `markup:delete` / `markup:deleteOthers` | the same split, for deletion |
| `markup:status` | moving an issue between open / in review / resolved |
| `calibrate` | setting the drawing scale |
| `sheet:edit` | editing sheet metadata |
| `export` / `import` | interchange in each direction |

`markup:edit` alone means "may edit **my own**". Editing a colleague's needs `markup:editOthers` as
well — the distinction that stops a subcontractor silently rewording the architect's comment.

Return a string instead of `false` to explain the refusal; it is shown to the user and recorded in
the audit trail. "You can't do that" with no reason generates a support ticket, and on a review the
reason is usually specific and knowable.

### What a client-side check can and cannot promise

It holds against ordinary use and against the host's own scripting, because it is not in the UI. It
**cannot** bind someone who controls their own browser — nothing running in a user's page can. The
server remains the authority. What this buys you is that the interface agrees with the server
instead of offering actions the user's role forbids, and that every attempt is recorded.

A check that throws is treated as a denial. A permission service being unreachable must not read as
"allow everything".

Some acts need more than one capability. Editing a markup *and* moving it to `resolved` in the same
patch needs `markup:edit` and `markup:status`, and both are decided before either is recorded — the
audit trail carries one entry, `markup:status+markup:edit`, reflecting whether the update actually
happened. Checking them one at a time would log the first as allowed even when the second refuses,
which is worse than no entry in a record meant to be evidence.

## Audit trail

```ts
const viewer = await createViewer({
  container,
  author: currentUser.name,
  audit: (event) => auditPipeline.write(event),
});
```

Every gated act produces one flat, serialisable record:

```json
{
  "at": "2026-07-27T14:02:11.884Z",
  "actor": "A. Reviewer",
  "action": "markup:create",
  "allowed": true,
  "annotId": "an_9f3c…",
  "annotKind": "cloud",
  "page": 2,
  "documentId": "a1b2c3…"
}
```

Refusals are recorded too, with `allowed: false` and the reason — usually the entry a compliance
review is actually looking for, since it records that someone tried.

The sink is your code and runs synchronously on the mutation path. Keep it cheap: buffer and batch
rather than issuing a request per event. A sink that throws is caught and logged rather than
allowed to block someone marking up a drawing.

`documentId` is the PDF's content fingerprint, which is stable across re-uploads of identical bytes
and changes when the drawing is re-issued — usually what you want for correlating with a server-side
record.

## Credentials

Never put an OCR API key in browser code. See the note at the top of `plugins/ocr-providers.ts` and
[ocr.md](ocr.md); use the `proxy` option and hold the credential server-side.

## Supply chain

- No runtime dependencies. `pdfjs-dist` and `pdf-lib` are peers, so their versions and patch cadence
  are yours.
- Dependabot runs weekly for npm and monthly for Actions. Major bumps of the two peers are excluded
  deliberately — raising that floor is a breaking change for every consumer.
- CodeQL (`security-and-quality`) runs on every push and weekly.
- Releases publish with npm provenance, so a tarball can be traced to the workflow run and commit
  that produced it.
- Licences are Apache-2.0 / MIT throughout, deliberately: a copyleft dependency here would propagate
  into every consumer. See [licences.md](licences.md).
