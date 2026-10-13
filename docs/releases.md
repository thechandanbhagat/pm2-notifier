# Publish a release

**Owner:** Project maintainers · **Last reviewed:** 2026-10-13 · **Review by:** 2027-01-13 or the next release.

This guide is for maintainers publishing `@thechandanbhagat/pm2-notifier` from the public GitHub repository.

[CI](../.github/workflows/ci.yml) runs TypeScript checks, unit tests, and the Linux PM2 integration test on pushes to `main` and pull requests.

## Configure npm authentication

The first publication requires an npm account with write access to the `@thechandanbhagat` organization. npm requires two-factor authentication for an interactive publication, or a granular token with **Bypass 2FA** enabled. Disabling account MFA does not permit publication.

For future releases, configure [trusted publishing](https://docs.npmjs.com/trusted-publishers/) in the package's npm settings after the package exists:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `thechandanbhagat` |
| Repository | `pm2-notifier` |
| Workflow filename | `release.yml` |
| Environment name | Leave empty |
| Allowed actions | Enable direct publishing with `npm publish` |

The release workflow uses short-lived OpenID Connect (OIDC) credentials. No npm token is needed with a configured trusted publisher. Complete its first successful publication within two days of creating the trust configuration; otherwise npm expires it. Create the configuration when the next release is ready.

If trusted publishing is unavailable, add an Actions repository secret named `NPM_TOKEN`. Use a short-lived [granular token](https://docs.npmjs.com/creating-and-viewing-access-tokens/) restricted to the `@thechandanbhagat` scope with **Read and write (publish and stage)** and **Bypass 2FA** enabled. Organization permissions can remain **No access**. Enter the token through GitHub's secret settings or `gh secret set NPM_TOKEN`, never in a commit, issue, or chat.

## Prepare the version

Update `package.json`, `package-lock.json`, and `CHANGELOG.md` for the intended version. Keep changes in granular conventional commits and push them to `main`.

Before tagging, run:

```sh
npm ci
npm run check
npm test
npm run test:integration
```

The integration test requires Linux and verifies a registry installation in an isolated PM2 home. The workflow uses Node.js `22.23.3` and npm `11.12.1`, including the dependency metadata patches run by `npm ci`.

Create an annotated `vX.Y.Z` tag at the release commit on `main`, then push that tag. The tag must match `package.json` exactly. Keep published versions and tags immutable; corrections require a new version.

## Bootstrap the first publication locally

Before configuring a trusted publisher, publish the first version from an authenticated maintainer session. If interactive CLI approval expires, [stage the verified archive](https://docs.npmjs.com/cli/v11/commands/npm-stage/) with npm `11.15.0` or newer:

```sh
npm exec --ignore-scripts --yes --package npm@11.15.0 -- npm stage publish ./excluded/thechandanbhagat-pm2-notifier-0.1.0.tgz --access public --tag latest
```

This command uploads the existing archive without rebuilding it. Sign in to npmjs.com, open **Staged Packages**, and approve the version with 2FA after npm finishes scanning it. Staging creates a placeholder for a new package; the intended version becomes installable after approval. A staged version reserves its version number, so approve it before running the release workflow for that same version.

## Run the release workflow

Pushing a `v*` tag starts [.github/workflows/release.yml](../.github/workflows/release.yml). You can also select **Release → Run workflow** in GitHub Actions and enter an existing `release_tag`.

The workflow verifies the tag belongs to `main`, runs TypeScript checks, unit tests, the Linux PM2 integration test, and the production dependency audit. It accepts only the documented upstream `braces` advisory; any other advisory blocks publication.

It packs the module once and passes the checksummed archive to the publication job. That job publishes the exact archive publicly to npm, verifies registry integrity, then publishes the GitHub release with the archive and checksum.

Tag-triggered runs include npm provenance. For a manual run, select the same tag as the workflow ref to include provenance. A manual run from `main` against an older tag disables provenance because the workflow event identifies a different source commit. The selected tag still supplies the package source and must pass all checks.

## Recover a failed run

If npm authentication fails, correct the trusted-publisher fields or token permission, then rerun the workflow. An existing npm version must have the same archive integrity for the run to continue; a different archive fails instead of replacing the published package. Use a new version when the released artifact needs a correction.

If npm succeeds but GitHub release creation fails, rerun the same workflow run. Existing assets must match the verified archive; reruns retain matching assets and upload missing ones.

Verify the completed release:

```sh
npm view @thechandanbhagat/pm2-notifier version dist.integrity
gh release view --repo thechandanbhagat/pm2-notifier
```

Users install the published module with `pm2 install @thechandanbhagat/pm2-notifier`; configuration steps remain in the [README](../README.md#quick-start).
