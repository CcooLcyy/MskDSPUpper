# Releasing

## Current Baseline

- App version: `0.6.0`
- CI updater URL: `https://pub-19f3d71852b04011b120b1b814141c12.r2.dev/mskdsp-upper/ci/latest.json`
- Stable updater URL: `https://pub-19f3d71852b04011b120b1b814141c12.r2.dev/mskdsp-upper/stable/latest.json`
- Beta updater URL: `https://pub-19f3d71852b04011b120b1b814141c12.r2.dev/mskdsp-upper/beta/latest.json`
- Static updater base URL: `https://pub-19f3d71852b04011b120b1b814141c12.r2.dev/mskdsp-upper`
- Stable workflow trigger: push tag `v*`
- Beta workflow trigger: push branch `beta/**`, or manual `workflow_dispatch`
- Static source backfill trigger: manual `workflow_dispatch`
- CI workflow trigger: pull request, or push to `main`

## Before The First GitHub Run

1. Push the release-prep workflow changes to the default branch first.
   If the GitHub repository is still empty, this first push should create `main` and establish it as the default branch.
2. Keep `package.json` and `src-tauri/tauri.conf.json` at the same stable version.
   The current expected stable tag is `v0.6.0`.
3. Use a beta branch name that matches the current version line.
   For `0.6.0`, use `beta/0.6` or `beta/0.6.0`.
4. Do not create the stable tag from `main` only.
   `release.yml` verifies that the tagged commit belongs to at least one `beta/*` branch.

## CI Static Channel

`CI` runs verification on pull requests and pushes to `main`. Only `main` pushes
run `package-main`; that job builds the CI package, writes updater metadata for
the R2 URL above, uploads updater assets to `ci/windows-x64/`, and uploads
`latest.json` last.

## GitHub Secrets

Create these repository secrets in `Settings -> Secrets and variables -> Actions`:

- `TAURI_SIGNING_PRIVATE_KEY`
  Paste the full content of `C:\Users\mutex\.tauri\mskdsp-upper.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  Optional. Leave unset when using a passwordless updater key.
- `SUBMODULE_TOKEN`
  Optional. Use a GitHub token that can read `CcooLcyy/MskDSPProto` if anonymous HTTPS checkout is not enough.
- `SUBMODULE_SSH_KEY`
  Optional alternative to `SUBMODULE_TOKEN` for submodule access.
- `R2_ACCOUNT_ID`
  Cloudflare account ID used to build the R2 S3 endpoint.
- `R2_ACCESS_KEY_ID`
  R2 API token access key with read/write access to the update bucket.
- `R2_SECRET_ACCESS_KEY`
  Secret corresponding to `R2_ACCESS_KEY_ID`.

Notes:

- `scripts/workflow/Prepare-SubmoduleAccess.ps1` falls back to anonymous HTTPS if neither submodule secret is set.
- If the `proto` submodule is private, at least one of `SUBMODULE_TOKEN` or `SUBMODULE_SSH_KEY` is required.
- R2 defaults are configured through repository variables `R2_BUCKET`,
  `R2_PREFIX` and `R2_PUBLIC_BASE_URL`.
  If unset, workflows use bucket `mskdsp-update`, prefix `mskdsp-upper`, and
  the public `r2.dev` address listed above. The workflow appends the
  `mskdsp-upper` path automatically; legacy static-server variables are ignored.
- `Sync Static Updater Source` can backfill the static source from an existing
  GitHub Release without building or publishing a new version. Leave `release_tag`
  empty to use `v<package version>` for stable or `beta-latest` for beta.

## Actions Permissions

In `Settings -> Actions -> General`:

1. Make sure GitHub Actions is enabled for this repository.
2. Under `Workflow permissions`, select `Read and write permissions`.
3. Save the setting before the first beta/stable run.

The workflows create or update releases and upload release assets, so `contents: write` must be effective.

## First Validation Order

### 1. First Beta

1. Create the beta branch from the same commit you want to validate:
   `git switch -c beta/0.6`
2. Push the branch:
   `git push -u origin beta/0.6`
3. Wait for the automatic `Beta` workflow, or run `Actions -> Beta -> Run workflow` with `beta_ref=beta/0.6`.
4. Confirm `verify-beta` and `publish-beta` both succeed.
5. Open the rolling release `beta-latest` and confirm its assets were refreshed.
6. Confirm there is also a timestamped beta prerelease whose tag starts with `beta-0-6-`.
7. Open the R2 Beta URL listed in the baseline and confirm it downloads.

### 2. First Stable

1. Pick the commit that already passed beta.
2. Create the stable tag locally on that exact commit:
   `git tag -a v0.6.0 <commit-sha> -m "Release v0.6.0"`
3. Push only the tag:
   `git push origin v0.6.0`
4. Wait for `Actions -> Release` to finish successfully.
5. Open the `v0.6.0` release and confirm it is marked as the latest release.
6. Open the R2 Stable URL listed in the baseline and confirm it downloads.

### 3. Client Updater Validation

Beta validation:

1. Install an older beta build generated from the beta channel.
2. Repeat the same updater flow.
3. Confirm the downloaded metadata comes from the R2 Beta URL listed in the baseline.

Stable validation:

1. Install an older stable build.
2. Repeat the same updater flow.
3. Confirm the downloaded metadata comes from the R2 Stable URL listed in the baseline.

## Static Source Backfill

Use `Actions -> Sync Static Updater Source -> Run workflow` when GitHub Release
assets already exist but the static source is empty or needs to be fully
resynced.

Inputs:

- `channel`: `stable` or `beta`.
- `release_tag`: optional. Defaults to `v<package version>` for stable or
  `beta-latest` for beta.
- `platform`: optional. Defaults to `windows-x64`.

The workflow downloads all assets from the selected GitHub Release, rewrites
`latest.json` so `platforms.*.url` points at
`<R2_PUBLIC_BASE_URL>/mskdsp-upper/<channel>/<platform>/`, uploads all assets
first, and uploads `latest.json` last. The R2 publish script then removes stale
objects only from the same channel/platform prefix. No server or nginx restart
is needed.

## Optional Follow-up

- After a manual stable release, confirm the `stable` channel manifest and the GitHub Release assets are in sync.
- The pushed tag version must match `package.json`: `release.yml` publishes the version it finds in `package.json`, so a mismatched tag produces a mislabeled release.
