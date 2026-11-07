# Proton Drive Backup

A self-hosted web app that backs up local folders to Proton Drive. It works like
a classic two-pane backup tool: your local folders on the left, your Proton Drive
on the right. You define backup sets that upload a selection from the left into
a folder on the right. It talks to Drive through the official
[Proton Drive SDK](https://github.com/ProtonDriveApps/sdk).

> [!IMPORTANT]
> This is an independent community project. It is not made, endorsed, sponsored
> or supported by Proton AG. For the official product and support, see
> [proton.me](https://proton.me).

The 0.x releases ran the `proton-drive` CLI once per operation. Since 1.0, one
process does all the work with the SDK. Each changed file is read once (the CLI
read it twice, images three times), and a run over a million unchanged files
takes about 20 seconds instead of almost 3 minutes and writes nothing. To upgrade, keep the
same compose file and the same `/data` volume and update the image. Sets,
schedules, history, catalog and your login carry over, and the first run uploads
nothing. Rollback works too. See [docs/UPGRADE.md](docs/UPGRADE.md).

## Security

### No built-in authentication

The web UI and all API routes have no authentication. Anyone who can reach the
port can browse your local files, browse and trash Drive files, create and run
backups, and sign the app out of Proton. Run it on a trusted network or behind a
reverse proxy that enforces its own login (nginx, Traefik, Caddy, Cloudflare).
Do not expose the port to the internet. If in doubt, bind it to localhost or a
private interface, for example `127.0.0.1:3005:3000`.

### Session at rest

The Proton session (tokens and the key password Proton hands over at sign-in) is
stored unencrypted in `/data/proton/auth-session.json` with mode 0600. It is the
same file and format the 0.x releases used, which is what makes upgrade and
rollback work. The app has to use the session unattended, so any key it could
encrypt it with would sit on the same host. Encrypt the `/data` volume at the storage layer instead, for example
with an encrypted ZFS dataset or LUKS, and treat it like any other secret store.

## Quick start

```bash
docker compose up -d
```

Then open http://localhost:3000. The bundled
[`docker-compose.yml`](docker-compose.yml) pulls the image from GHCR and
publishes container port 3000 on host port 3000; change the host port freely.
To build locally, uncomment `build: .` in that file.

Mount the folders you want to back up under `/sources`. Read-only is recommended,
because the app only reads them:

```yaml
services:
  proton-drive:
    container_name: proton-drive-backup
    image: ghcr.io/traktuner/docker-proton-drive-backup:latest
    ports:
      - "3000:3000"             # host:container
    volumes:
      - ./data:/data            # session and database; keep it to stay signed in
      - ./sources:/sources:ro   # folders to back up, shown in the left pane
    environment:
      - TZ=Europe/Vienna        # timezone for schedules (default UTC)
    restart: unless-stopped
```

### Several sources

Do not add nested mounts such as `/mnt/share:/sources/share:ro` while
`./sources:/sources:ro` is still active. `runc` creates each nested mountpoint
inside its parent mount, and if that subdirectory does not exist on the host, a
read-only parent makes the container fail to start with
`make mountpoint "/sources/...": read-only file system`
([#72](https://github.com/traktuner/docker-proton-drive-backup/issues/72)).
Use one of these two layouts instead.

(a) Mount the parent read-write and keep the nested data mounts read-only. The
parent directory itself is then writable from inside the container (the data in
the nested mounts is not), and `runc` leaves the created mountpoint directories
behind on the host.

```yaml
    volumes:
      - ./sources:/sources:rw
      - /mnt/nas/photos:/sources/photos:ro
      - /mnt/nas/documents:/sources/documents:ro
```

(b) Leave out the parent mount. Each share mounts directly into the image's
empty `/sources` directory, and nothing else is writable or visible.

```yaml
    volumes:
      - /mnt/nas/photos:/sources/photos:ro
      - /mnt/nas/documents:/sources/documents:ro
```

Either way, the shares appear as top-level folders in the left pane, and source
paths in a backup set are relative to `/sources` (for example `/photos/...`).

### Platforms

Images are published for `linux/amd64` and `linux/arm64`; `uname -m` must report
`x86_64` or `aarch64`. There is no 32-bit ARM build. Typical arm64 hosts are a
Raspberry Pi 4 or 5 on a 64-bit OS, Apple Silicon and generic arm64 Linux
servers. Most ARM Synology models cannot run Docker at all: Container Manager is
only offered on the x86 "+" models, which use the amd64 image.

## Using it

1. Open the UI, click **Connect Proton Drive** and finish the sign-in in the new
   tab, or copy the link to another device. The app continues once the session
   is live. Sign-in uses Proton's browser flow, so your password never reaches
   the app and no localhost callback is needed.
2. On the **Files** page, tick local files or folders on the left, open or create
   a target folder on the right, name the set, pick a mode and optionally a
   schedule and excludes, then click **Create backup set**.
3. Click **Run** on a set to upload now. Its status updates live.

You can add more source folders to an existing set while it is stopped: select
them on the left and open the set's editor. This keeps the set's catalog, so
unchanged files are not uploaded again. Existing sources cannot be removed this
way, overlapping sources are rejected, and a queued or running set stays locked.

## Backup modes

| Mode | What it does |
|---|---|
| Add new | Uploads files that are not on Drive yet. Never updates or deletes. Suits write-once archives. |
| Backup (recommended) | Uploads new files and re-uploads changed ones. Files you delete locally stay on Drive. |
| Mirror | Like Backup, but also moves files you deleted locally to the Drive trash, within the folders the set backs up. |

In Backup and Mirror, a changed file becomes a new revision of the same Drive
file, so earlier versions stay in Drive's version history. Folders are created on
Drive too, including empty ones.

### How changes are detected

The app records in a SQLite catalog (`/data/backup.db`) what Drive has confirmed
for each set, including the Drive node of every file and folder. An unchanged
file costs one `stat` and one indexed lookup: no Drive request and no file read.

A file counts as changed when its size differs, or when its modification time
differs by more than 2 seconds and its SHA-1 differs from the recorded one (for
catalogs from 0.x releases, from the one Drive stores). A change that keeps both
size and modification time is invisible to this check. To catch it, Shift-click
**Verify**: this reads every local file, compares its SHA-1 with Drive's, and the
next run re-uploads the mismatches. A plain **Verify** checks the catalog against
Drive and re-uploads anything that was deleted or changed there.

A file is recorded only after Drive confirmed the upload. If the container dies
between the confirmation and the record, the next run finds the same content on
Drive and records it without a second revision. A Drive item with the same name
that already holds the local content is adopted the same way.

The set's target folder is tracked by its Drive node, not its name. If you rename
it on Drive, the app follows. If it was moved, deleted or replaced by a new folder
with the same name, the run stops before writing and tells you; **Verify**
re-checks the set and starts it over if the folder is really gone.

## Mirror safety

To Mirror, an offline NAS share or an unreadable folder looks like files that
were deleted locally. Mirror therefore moves items only to the Drive trash, where
they can be restored, and skips the deletion step entirely, with the reason
shown, when any of these is true:

- a source path is missing, or a source that was a mounted share last time is now
  a plain directory of the container (an offline NAS leaves an empty mountpoint
  behind);
- a source is empty although it held files last time. If you emptied it or
  changed the mounts on purpose, **Apply deletions** in the set's row confirms it
  once. Only a run whose sources looked fine updates this reference, so an
  offline share never becomes the new normal;
- an upload failed or a file was unreadable in this run;
- the run would remove more than the configured share of the catalog. The default
  is 30%; change or disable it in **Settings → Backup → Mirror safety**. The other
  checks cannot be disabled. A removed folder counts with everything recorded
  below it, so a vanished nested share or a moved top-level folder counts as most
  of the set, not as one entry.

Before trashing an item, the app reads it again from Drive. It must still be the
node this backup uploaded, in the same place and under the same name. A folder
that also holds anything this backup did not upload is kept; only the backup's
own files inside it are trashed. **Preview** runs the same scan with the same
rules and shows what the next run would upload and delete, without changing
anything.

## Folders over Proton's item limit

Proton Drive accepts about 30,000 items per folder (API error 200300, "folder
limit reached"). When a backed-up folder reaches that limit, the rest of its files
go into a folder next to it named `<name> · part 2`, then `· part 3` and so on.
Nothing is skipped, and existing folders are never reorganised. Runs, revisions,
Mirror and Verify treat a folder and its parts as one.

The mapping is stored in the database; if it is lost, the parts are found again by
their names. In Mirror, a file deleted locally is trashed from whichever part
holds it, and a removed folder takes its parts with it, each identity-checked as
above. Parts are never merged back or rebalanced. If a part is deleted on Drive,
the next upload into that folder, or **Verify**, notices and uploads the missing
files again. To restore through Proton Drive's web app, copy the contents of the
parts back into one folder.

## What gets skipped

A single file never stops a backup. A file that cannot be backed up is skipped,
the run continues, and the set shows it under **N files skipped** with the reason.
A file is skipped when:

- Drive rejects its name. Proton allows 255 characters per name. Linux already
  limits names to 255 bytes, and names with special characters such as
  `Movie [1080p].mkv` work, so this is rare.
- It cannot be read (permission or I/O error). In Mirror this also blocks the
  deletion step, so an unreadable file is never mistaken for a deleted one.
- It is hidden (a dotfile such as `.env` or `.config`) and the set's **Include
  hidden files** option is off, which is the default. As with excludes, turning
  the option off later leaves hidden items already on Drive alone; Mirror does
  not trash them.
- It is a symbolic link. Links are not followed, to avoid loops, duplicates and
  targets outside the share. Each link is listed with the run, and in Mirror a
  link never causes the file or folder it replaced to be trashed. To back up a
  link's target, add the target as a source.

## Test restore

**Test restore** on a set downloads 20 random backed-up files from Drive,
decrypted exactly as a restore would, and compares them byte for byte with the
originals. It changes nothing and can run during a backup. Files over 512 MiB are
not sampled, and files that changed locally since the backup are skipped. The API
accepts up to 200 files: `POST /api/backup-sets/<id>/restore-test?files=N`.

## Scheduling

Each set runs manually (off), hourly, daily or weekly. Schedules use the
container's local time, so set `TZ` (default UTC). A run missed while the
container was off is caught up once, on the next check. Scheduled runs wait while
the app is signed out or the Proton account is unconfirmed, and start as soon as
that is resolved.

## Declarative config

To create backup sets without the UI, mount a `/config` directory with a
`backup-sets.yaml` (or `.yml` or `.json`). The container imports it on every
start, matching sets by name, so importing the same file again changes nothing.
Only the keys the file contains are changed; a key it leaves out keeps the set's
current value. Get the format with **Export** on the Files page. You still sign in
once in the browser. See volume `(3)` in [`docker-compose.yml`](docker-compose.yml).

## Settings

**Backup → Uploads → Parallel uploads** sets how many files upload at once:
1 to 5, default 2. Five is the SDK's own limit, which also caps file data in
flight at 40 MiB. A change applies to a running backup.

**Backup → Uploads → Limit upload speed** caps how fast backups read files for
upload, in KB/s, shared by all parallel uploads. The minimum is 50 KB/s. The app
throttles its own uploads, so it needs no extra Linux capability, never slows the
web UI, and applies a change within a second, also to a running backup. The
`cap_add: [NET_ADMIN]` that 0.x releases needed for this can be removed.

**Backup → Mirror safety** sets the deletion threshold described in
[Mirror safety](#mirror-safety).

**Display → Text size** scales the whole interface. It is stored per browser.

**System** shows the app, image and SDK versions, whether a newer release is
available, the timezone and the mount paths.

## Memory and performance

One Node.js process runs the web UI, the scheduler, the backup engine and the SDK.
It uses about 60 MiB when idle, signed in or out. During a run, memory is bounded:

- a fixed number of files is in flight (the parallel uploads setting);
- each file is streamed from disk in 1 MiB chunks into the SDK's 4 MiB encryption
  blocks, and the SDK keeps at most 6 encrypted blocks ready per file (upstream
  default 15, see `PDB_SDK_BUFFERED_BLOCKS`);
- the local scan runs in a separate thread with one batch in flight;
- the catalog lives in SQLite, not in memory.

A fast disk with a slow uplink does not make memory grow; the scan waits for the
uploads. To use less memory, lower the parallel uploads or turn on **Skip
thumbnails** for a set (thumbnails decode each image, one at a time).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TZ` | `UTC` | Timezone for schedules |
| `DB_PATH` | `/data/backup.db` | SQLite database |
| `LOCAL_ROOT` | `/sources` | Folder shown in the left pane |
| `CONFIG_DIR` | `/config` | Directory searched for `backup-sets.yaml`, `.yml` or `.json` |
| `PROTON_DRIVE_CACHE_DIR` | `/data/proton` | Holds the session file `auth-session.json`; must persist |
| `HOME` | `/data/proton` | Kept on the writable `/data` volume so a read-only root and a non-root user both work |
| `PUID` / `PGID` | unset | If set and the container starts as root, chown `/data` and drop to this user and group |
| `GITHUB_REPO` | `traktuner/docker-proton-drive-backup` | Repository for the update check; change it if you run a fork |
| `PROTON_DRIVE_BASE_URL` | SDK default | Proton API host. Do not change |
| `UV_THREADPOOL_SIZE` | `16` | Parallel `stat()` calls, which helps NFS and SMB sources |
| `PDB_SDK_BUFFERED_BLOCKS` | `6` | Encrypted 4 MiB blocks the SDK keeps ready per file (upstream 15). Lower uses less memory per upload |
| `PDB_ENTITY_CACHE` / `PDB_CRYPTO_CACHE` | `5000` / `200` | Entries in the SDK's node and key caches |
| `PDB_DIR_BACKLOG_CAP` | `100000` | Empty folders queued for creation before the scan waits (about 10 MiB per 100,000) |
| `PDB_ENABLE_DOWNLOAD` | unset | `1` enables `GET /api/drive/download`, for tests and diagnostics. It exposes Drive content to anyone who can reach the port |
| `PDB_DEBUG` | unset | `1` logs SDK requests and debug messages |

`PROTON_DRIVE_CLI`, `PROTON_DRIVE_CREDENTIALS_STORE`, `PROTON_DRIVE_LOG_LEVEL` and
`BUN_JSC_forceRAMSize` were used by the 0.x releases and are now ignored. Leaving
them in a compose file does no harm.

## Hardening

[`docker-compose.yml`](docker-compose.yml) sets `no-new-privileges` and
`cap_drop: ALL` by default and documents two stronger modes you can turn on. CI
boots every documented mode on each push and pull request to `main`
([`test/deployment/smoke.sh`](test/deployment/smoke.sh)).

Read-only root filesystem: the app writes only to `/data`. Add two tmpfs mounts
for `/tmp` and the Next.js cache:

```yaml
    read_only: true
    tmpfs:
      - /tmp
      - /app/.next/cache
```

`/config` is only read; leave it out or mount it `:ro`.

Non-root user, option (a): run the container as your UID with `user:`. The image
works with any UID, but the host directory bound to `/data` must already be
writable by it. `/sources` stays read-only. Because `HOME` is on `/data`, this
works together with `read_only: true`.

```bash
sudo chown -R 1000:1000 ./data
```

```yaml
    user: "1000:1000"
```

Non-root user, option (b): set `PUID` and `PGID` when you cannot chown the bind
mount yourself. The container starts as root, chowns `/data` to those IDs and
then drops to that user with `setpriv` before starting the app. Do not combine
this with `user:` or `read_only`, because it has to start privileged.

```yaml
    environment:
      - PUID=1000
      - PGID=1000
```

On some hosts with NFSv4 ACLs, the Docker daemon fails with `chmod … operation not
permitted` while creating a bind-mount source. That happens in the daemon, not in
the container; create the mount directories beforehand with the right owner.

## Upgrade, SDK updates and releases

[docs/UPGRADE.md](docs/UPGRADE.md) covers moving from a 0.x (CLI) release to 1.x
and rolling back. The first 1.0 start saves the old database and session before it
changes anything.

The SDK is bundled into one file (`dist-proton/runtime.mjs`) and pinned to an
exact upstream release in `package.json`. A daily workflow opens a pull request
when a newer SDK is published. The footer, Settings, the image labels and
`GET /api/version` show the SDK version. See
[docs/SDK-UPDATE.md](docs/SDK-UPDATE.md).

A release is a git tag `vX.Y.Z` with notes in `docs/releases/vX.Y.Z.md`; a commit
on `main` does not change `latest`. Full notes for each version are on the
[Releases page](https://github.com/traktuner/docker-proton-drive-backup/releases).
See [docs/RELEASING.md](docs/RELEASING.md).

| Built from | Image tags |
|---|---|
| Release tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `X`, `latest`, plus `X.Y.Z-1` so 0.x containers see the update |
| Release candidate `vX.Y.Z-rc.N` | `X.Y.Z-rc.N` |
| Push to `main` | `main`, `<sha>` (untested) |
| Manual run on a branch | `<branch>`, `<sha>` (untested) |

Pin `:1` to follow all 1.x releases, `:1.0` for 1.0.x fixes only, or an exact
version. The 0.x releases were tagged `<cliVersion>-<revision>`, for example
`0.9.0-21`.

## API

All routes are unauthenticated; see [Security](#security).

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Start sign-in; returns `signInUrl` |
| GET | `/api/auth/status` | `{ authenticated, loginState, signInUrl, error }` |
| POST | `/api/auth/confirm` | Confirm the signed-in account for the backup sets |
| POST | `/api/auth/logout` | Sign out |
| GET | `/api/local/list?path=` | List local files under `LOCAL_ROOT` |
| GET | `/api/local/size?path=` | Stream size and file count of a selection (server-sent events) |
| GET | `/api/drive/list?path=` | List a Drive folder |
| POST | `/api/drive/folder` | Create a Drive folder |
| POST | `/api/drive/trash` | Trash a Drive item; refuses a backup target or a folder that contains one |
| POST | `/api/drive/refresh-cache` | Drop cached Drive listings |
| GET | `/api/drive/revisions?path=` | Revisions of a Drive file |
| GET | `/api/drive/download?revision=` | Download a revision; disabled unless `PDB_ENABLE_DOWNLOAD=1` |
| GET/POST | `/api/backup-sets` | List or create backup sets |
| GET/PATCH/DELETE | `/api/backup-sets/:id` | Read, update or delete a set |
| POST | `/api/backup-sets/:id/source-paths` | Add source folders to a stopped set |
| POST | `/api/backup-sets/:id/run` | Run a set; `?confirmSources=1` confirms an emptied or re-mounted Mirror source once |
| POST | `/api/backup-sets/:id/cancel` · `/pause` | Cancel or pause a running set |
| POST | `/api/backup-sets/:id/verify` | Check the catalog against Drive; `?content=1` also compares the SHA-1 of every file |
| POST | `/api/backup-sets/:id/dry-run` | Preview the next run |
| POST | `/api/backup-sets/:id/restore-test?files=` | Test restore (default 20 files, at most 200) |
| GET/POST | `/api/config` | Export or import backup sets as YAML |
| GET | `/api/settings` | Settings, versions and account |
| GET/POST | `/api/settings/uploads` | Read or change parallel uploads and the speed limit |
| GET/POST | `/api/settings/mirror-safety` | Read or change the Mirror deletion threshold |
| GET | `/api/settings/check-updates` | Check for a newer image and SDK notices |
| GET | `/api/quota` | Drive storage use |
| GET | `/api/version` | App, image and SDK version |
| GET | `/api/diagnostics` | Memory, request and cache counters (no secrets) |
| GET | `/api/health` | Health check used by the image |

## Troubleshooting

- "Proton session expired" right after upgrading from 0.x: Proton did not accept
  the old session. Click **Reconnect** and sign in once; your sets are untouched.
  If the session expires later, a banner offers the same reconnect, and a running
  backup stops with a message.
- Backups wait for "Confirm the Proton account": see
  [docs/UPGRADE.md](docs/UPGRADE.md).
- The left pane is empty: mount your folders into `/sources`.
- A Mirror run reports a missing or empty source: check the mount on the host.
  Nothing was deleted. If you emptied the folder on purpose, click **Apply
  deletions** in the set's row.
- The container is OOM-killed during a backup: lower the parallel uploads, or turn
  on **Skip thumbnails** for photo sets. See
  [Memory and performance](#memory-and-performance).
- For a bug report, include the output of `GET /api/version`. It shows the app
  version, image tag, SDK version, upstream commit and the exact `x-pm-appversion`
  the app sends to Proton, which has the form
  `external-drive-traktuner_proton_drive_backup@<version>-stable+<commit>`.

## Development

```bash
npm install            # Node 26 (built-in node:sqlite, no native build)
npm run dev            # http://localhost:3000, builds the SDK bundle first
npm run build          # SDK bundle and production build (standalone output)
npm run typecheck      # the app and the SDK boundary against the pinned SDK types
npm test               # SDK pin check and vitest (engine regression suite on a fake Drive)
npm run test:smoke     # boot every documented deployment mode (needs an image)
npm run test:upgrade   # upgrade from the last published 0.x image, see test/upgrade
npm run sdk:update -- <version>   # see docs/SDK-UPDATE.md
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the typecheck and
the vitest suite, then the upgrade test from the last published 0.x image
([`test/upgrade/upgrade.sh`](test/upgrade/upgrade.sh)) and the deployment smoke
test. The smoke test starts the container in every documented mode (default,
hardened, read-only, non-root, read-only with non-root, PUID/PGID and both
multi-source layouts) and fails if one does not start and initialise. Tests
against real Proton Drive use a dedicated account:
[`test/live/live.sh`](test/live/live.sh) and
[`test/live/takeover.sh`](test/live/takeover.sh).

### Project structure

```
src/
  app/
    onboarding/page.tsx   # sign-in
    files/page.tsx        # two-pane set builder
    api/…                 # route handlers
  components/
    FilePane.tsx          # local and Drive browser
    BackupSets.tsx        # set list and actions
    AuthProvider.tsx      # session state and reconnect
  server/
    proton/runtime.ts     # the only file that imports the SDK
    proton/types.ts       # the small contract the rest of the app uses
    proton/vendor/        # pinned upstream account module and UPSTREAM.json
    drive.ts              # runtime loader, paths, sign-in, account binding
    engine.ts             # backup engine (add, backup, mirror), preview, verify, test restore
    scheduler.ts          # in-process scheduler
    local.ts              # local browsing and the scanner thread
    db.ts                 # SQLite (node:sqlite) and schema migration
    runner.ts             # runs a backup set
Dockerfile · docker-compose.yml · docker-entrypoint.sh
```

## License

[MIT](LICENSE) © traktuner.

The image bundles the Proton Drive SDK, `@protontech/crypto` and Proton's account
module (MIT, © Proton AG; see `dist-proton/runtime.mjs.LEGAL.txt` and
`src/server/proton/vendor/account/LICENSE.md`). Using Proton's services is subject
to Proton's terms; see the SDK's usage guidelines for third-party apps.

"Proton", "Proton Drive", "Proton Mail" and related names and logos are trademarks
of Proton AG. This project uses them only to name the software it works with and
is not affiliated with, endorsed by or sponsored by Proton AG.
