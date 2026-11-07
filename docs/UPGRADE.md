# Upgrade an existing container and roll back

Release 1.0 replaces the bundled `proton-drive` CLI with the official Proton Drive
SDK running inside the app. Your compose file, your `/data` volume and your
backup sets stay exactly as they are.

## Upgrade

1. Nothing to back up by hand. Before it changes anything, the first start of 1.0
   saves the old database as `backup.db.pre-sdk.bak` and the untouched session as
   `proton/auth-session.pre-sdk.json`. If your platform makes it easy, a dataset
   snapshot of `/data` beforehand (with the container stopped) is a welcome extra.
2. Update the image like any other release:

   ```bash
   docker compose pull && docker compose up -d
   ```

   If you pin a version tag, change it first: `:1` follows all 1.x releases,
   `:1.0` only 1.0.x fixes, `:1.0.0` exactly this release. Containers on `:latest`
   get it with the pull. (From 1.0 on, tags are plain versions; the 0.x shape
   `<version>-<revision>` is published once more as `1.0.0-1`, only so that 0.x
   containers show the update.)
3. Open the web UI. Expected result:
   - all backup sets, schedules, excludes and the run history are there;
   - you are still signed in — the session in `/data/proton/auth-session.json`
     is reused;
   - the next run of an unchanged set reports `0 uploaded, N unchanged` and
     uploads, revises and deletes nothing. It only reads the catalog; it does not
     scan Drive.

Nothing else is required: no new mounts, no GPG or `pass` setup, no re-created
jobs. Settings that only the CLI needed are ignored if they stay in your compose
file: `PROTON_DRIVE_CREDENTIALS_STORE`, `PROTON_DRIVE_LOG_LEVEL`,
`BUN_JSC_forceRAMSize`, `PROTON_DRIVE_CLI` and `cap_add: [NET_ADMIN]` (the upload
speed limit now works without it).

### If the app asks you to sign in or to confirm the account

- **"Proton session expired — reconnect"**: Proton did not accept the old session
  (for example because it was revoked, or it had expired before the upgrade).
  Click **Reconnect** and sign in once in the browser.
- **"Confirm the Proton account for your backup sets"**: shown after a new
  sign-in on an installation that already has backup sets. Check the address and
  the listed targets, then confirm. Backups — also scheduled ones — wait until
  you do, so nothing is ever written into the wrong account.
- **"Signed in as … but these backup sets belong to …"**: you signed in with a
  different account. Sign out and sign in with the original one.

A due schedule runs once, as soon as the app is signed in and the account is
confirmed.

## Roll back

Rolling back to the last CLI release keeps working after 1.0 has run, uploaded
files and refreshed the session:

```yaml
    image: ghcr.io/traktuner/docker-proton-drive-backup:0.9.0-21
```

```bash
docker compose up -d
```

Why this works:

- the database change is additive (one column, one table); 0.x releases ignore
  both;
- 1.0 keeps the session in the CLI's own file format and updates that file when
  it refreshes tokens, so the CLI reads the current tokens. Refresh tokens are
  single-use; restoring an old copy of `auth-session.json` would log you out;
- files uploaded by 1.0 are in the catalog, so the CLI release does not upload
  them again.

Do not restore `backup.db.pre-sdk.bak` for a rollback. It predates every run
since the upgrade, so the CLI release would upload those files again as new
revisions. Use it only if the database itself is damaged.

On its first start 1.0 also keeps the untouched 0.x session as
`/data/proton/auth-session.pre-sdk.json`. You need it only in one case: 1.0 asked
you to sign in again right after the upgrade (Proton did not accept the old session
for this app) and you now roll back. Then, with the container stopped:

```bash
cp data/proton/auth-session.pre-sdk.json data/proton/auth-session.json
```

In every other case leave it alone — after 1.0 has refreshed the session, that
copy holds an outdated, already invalidated refresh token. If the CLI release
shows "session expired" after a rollback, sign in again in its UI. Your sets are
not affected. Both files can be deleted once you stay on 1.x
(`backup.db.pre-sdk.bak`, `auth-session.pre-sdk.json`).
