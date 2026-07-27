# Publishing to npm

The package is `@massingcloud/pdf-viewer`. Everything mechanical is wired up; what remains is a
handful of one-time account steps that only a human with org access can do.

## One-time setup

1. **Create the `@massingcloud` scope on npmjs.com.** Either an npm organisation named
   `massingcloud`, or a user account of that name. Scoped packages cannot be published to a scope
   that does not exist, and the name is claimed first-come — worth doing before the code is ready
   rather than after.

2. **Add the publishers to the org** with at least *write* on the package.

3. **Create a granular access token** (npmjs.com → Access Tokens → Granular). Scope it to
   *this package only*, with read-and-write, and give it an expiry. A classic "automation" token
   works too but grants everything the account can do.

4. **Store it as a repository secret** named `NPM_TOKEN`
   (GitHub → Settings → Secrets and variables → Actions).

5. **Enable trusted publishing** (optional, and better than a token if you take it). npm supports
   OIDC from GitHub Actions, which removes the long-lived secret entirely. If you set that up,
   delete `NPM_TOKEN` and drop the `NODE_AUTH_TOKEN` env from the workflow.

Nothing above is in the repo, and none of it can be scripted from here — it needs someone signed in
to the npm account.

## What is already handled

| Concern | Where |
| --- | --- |
| Scoped packages default to private, and publishing one on a free account fails with `402` | `publishConfig.access: "public"` in `package.json` |
| Publishing a stale or unbuilt `dist/` | `prepublishOnly` runs `check` then `build` |
| `exports` pointing at a file the build never emitted | `npm run check:package`, in CI and in the release workflow |
| A tag that disagrees with the manifest version | guard step in `.github/workflows/release.yml` |
| Proving where the tarball was built | `npm publish --provenance` with `id-token: write` |
| Shipping the whole repo | `files: ["dist", "README.md", "LICENSE"]` |
| Consumers ending up with two copies of pdf.js | `pdfjs-dist` and `pdf-lib` are peers, external in the build |

## Releasing

```bash
npm version minor -m "Release v%s"
git push --follow-tags
```

The tag push triggers `.github/workflows/release.yml`, which re-runs the full check, builds,
validates the entry points, prints the tarball contents and publishes.

To rehearse without publishing, run the workflow manually from the Actions tab — `workflow_dispatch`
defaults to a dry run and does everything except the publish step.

## Before the first release

`0.1.0` has never been published, so the first release is also the first time any of this runs for
real. Two things are worth doing deliberately:

- **Dry-run the workflow first.** It is the only way to see the token and provenance wiring work
  without committing to a version number that can never be reused — npm does not allow republishing
  a version, even after `npm unpublish`.
- **Decide whether `0.1.0` is the right opening number.** It signals "shape may still move", which
  is honest while Massing is the only consumer. If the API is meant to be stable on day one, publish
  `1.0.0` instead — going `0.x → 1.0` later is a much louder change than starting there.

## Consuming it from Massing

Massing's `apps/web` already carries `pdfjs-dist` ^6 and `pdf-lib` ^1.17, which is why they are
peers here rather than dependencies — the versions were matched deliberately so reintegration does
not duplicate them. See [integration-massing.md](integration-massing.md).
