# Releasing

Releases are deliberate: a commit on `main` does **not** change `latest`. A release
is a git tag `vX.Y.Z` plus its notes in `docs/releases/vX.Y.Z.md`.

## Image tags

| Built from | Tags | Shown in the app as | Offered as an update |
|---|---|---|---|
| tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `X`, `latest` (+ `X.Y.Z-1` for 0.x update checks) | `X.Y.Z` | yes |
| tag `vX.Y.Z-rc.N` | `X.Y.Z-rc.N` | `X.Y.Z` | no |
| push to `main` | `main`, `<sha>` | `X.Y.Z-edge.<sha>` | no |
| manual run on a branch | `<branch>`, `<sha>` | `X.Y.Z-preview.<sha>` | no |

The update check in Settings compares only plain `X.Y.Z` tags and links the
GitHub Release of the newest one (`src/server/updates.ts`).

## Cut a release

1. Set the version in `package.json` (for example `1.0.1`) and merge to `main`.
2. Write the user-facing notes in `docs/releases/v1.0.1.md`, in plain words:
   - what changed for users;
   - how to upgrade;
   - anything they must do or know.

   Merge it to `main`.
3. Tag the merge commit and push the tag. Push it as a person, or with a token
   that can trigger workflows; a tag pushed by `GITHUB_TOKEN` starts no workflow.

   ```bash
   git switch main && git pull
   git tag -a v1.0.1 -m "v1.0.1"
   git push origin v1.0.1
   ```

4. "Build and Push Docker Image" then runs these jobs, in this order:
   - **guard**: fails before anything is built if the tag does not match
     `package.json`, or if the notes file is missing;
   - **build** and **merge**: push the images with the tags above;
   - **release**: creates the GitHub Release from the notes file. A tag with `-`
     (for example `v1.1.0-rc.1`) becomes a pre-release.

Editing the notes later: change `docs/releases/vX.Y.Z.md`, then run
`gh release edit vX.Y.Z --notes-file docs/releases/vX.Y.Z.md`.
