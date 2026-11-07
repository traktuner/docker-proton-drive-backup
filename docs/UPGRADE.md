# Upgrade an existing container and roll back

Release 1.0 replaces the bundled `proton-drive` CLI with the official Proton Drive
SDK running inside the app. Your compose file, your `/data` volume and your
backup sets stay exactly as they are.

## Upgrade

1. Optional, recommended: copy `/data` while the container is stopped
   (`docker compose stop`, then copy the host folder or snapshot the dataset).
   The app also writes `backup.db.pre-sdk.bak` next to the database on its first
   start — a consistent copy of the old database — but a dataset snapshot also
   covers the session file.
2. Update the image like any other release:

   ```bash
   docker compose pull && docker compose up -d
   ```

   If you pin a version tag, change it to `1.0.0-<n>` first. Tags keep the
   `<version>-<revision>` shape, so Renovate and the in-app update check see the
   new release.
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

If the CLI release shows "session expired" after a rollback (for example because
you signed out in 1.0), sign in again in its UI. Your sets are not affected.
