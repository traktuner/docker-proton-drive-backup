# Update the Proton SDK

The app release has its own version (`package.json` → `version`, image tags
`X.Y.Z`/`X.Y`/`X`, see [RELEASING.md](RELEASING.md)). The Proton Drive SDK is a
pinned dependency of it.

## One pin, everything derived

The only place to change is `dependencies["@protontech/drive-sdk"]` in
`package.json`. `npm run sdk:update` derives the rest from the matching upstream
release tag `js/v<version>` of [ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk):

| Derived | From |
|---|---|
| `@protontech/crypto` (exact) | `cli/package.json` at that tag (the tested combination) |
| `ky` (exact) | `incubating/account/js/bun.lock` at that tag |
| `src/server/proton/vendor/account/` | `incubating/account/js/src` at that tag (not published to npm), byte-for-byte |
| `src/server/proton/vendor/UPSTREAM.json` | tag, commit, versions and SHA-256 of every vendored file |
| `package-lock.json` | `npm install` |

The image labels (`io.github.traktuner.proton-drive-sdk.version/commit`), the
footer, **Settings → Updates** and `GET /api/version` show the SDK version and the
upstream commit.

## Routine update

Automatic: the **Check Proton Drive SDK update** workflow runs daily. When npm
has a newer SDK, it runs the command below and opens a PR with the gate results.
A failing gate opens a draft PR.

Manual:

```bash
npm run sdk:update -- 0.24.0      # or: latest
npm run sdk:check                 # pin, lockfile, vendored files consistent
npm run typecheck                 # app + the SDK boundary against the new SDK types
npm test                          # unit + regression tests (fake Drive)
npm run build
docker build -t pdb:sdk . && test/upgrade/upgrade.sh   # upgrade acceptance test
```

Commit `package.json`, `package-lock.json` and `src/server/proton/vendor/`. Bump
`version` in `package.json` to publish a release.

To undo a bump, run the same command with the previous version
(`npm run sdk:update -- 0.23.0`). The result is byte-identical to the earlier
commit.

## Where an SDK change can break the app

All Proton-specific code is in `src/server/proton/runtime.ts`. It is the only
file that imports the SDK, crypto or the account module, and it implements the
small `DriveService`/`ProtonRuntime` contract in `src/server/proton/types.ts`.
The engine and the API routes only use that contract.

- **API change:** `npm run typecheck` fails in `runtime.ts` and names the call
  site. Type errors inside upstream sources (`node_modules`, the vendored module)
  are reported but do not fail the check.
- **Behaviour change:** the regression suite (`src/server/engine.test.ts`) and
  the upgrade test exercise the contract.
- **Real Proton:** `test/live/live.sh` runs the live round trip against a
  dedicated test account (see its header).

## Upstream patches

There is one, applied at bundle time and documented in
`src/server/proton/PATCHES.md`: `@protontech/crypto` imports `openpgp/lightweight`,
which `openpgp` exports for browsers only. `scripts/build-proton.mjs` aliases it
to the Node build — the same change the official CLI ships as a source patch.
The vendored account module is never edited; `sdk:check` rejects local changes.
