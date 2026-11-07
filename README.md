# Proton Drive Backup

A self-hosted web app built on the official **Proton Drive SDK** that works as a classic
left → right backup tool: browse local folders on the left, your Proton Drive on
the right, and define "backup sets" that upload the former into the latter.

> [!IMPORTANT]
> **Not affiliated with Proton.** This is an independent, community-built project.
> It is **not** made, endorsed, sponsored, or supported by Proton AG. "Proton",
> "Proton Drive" and related marks are trademarks of Proton AG, used here only
> nominatively to describe what this tool interoperates with. For the official
> product and support, see [proton.me](https://proton.me).

## Upgrading from a 0.x (CLI) release

Release 1.0 talks to Proton Drive through the official
[Proton Drive SDK](https://github.com/ProtonDriveApps/sdk) inside the app instead of
running the `proton-drive` CLI once per operation. Update the image as usual —
same compose file, same `/data`; sets, schedules, history, catalog and your login
carry over, and the first run uploads nothing. Rolling back works too. See
**[Upgrade an existing container and roll back](docs/UPGRADE.md)**.

## How it works

- **One process.** A single Node.js server runs the web UI, the scheduler, the
  backup engine and the Proton Drive SDK. No CLI processes, no second runtime.
- **The SDK is bundled once** (`dist-proton/runtime.mjs`) and pinned to an exact
  upstream release; the version is shown in the footer, in Settings and in the
  image labels. See [Update the Proton SDK](docs/SDK-UPDATE.md).
- **Login** uses Proton's browser sign-in: the app shows a link, you sign in on any
  device, the session is handed to the app. No password ever reaches the app, no
  localhost callback is needed.
- **Session** is stored in `/data/proton/auth-session.json` (0600) — the same file
  and format the CLI releases used, which is what makes upgrade and rollback work.
- **Catalog.** What Drive has confirmed is recorded per set in SQLite
  (`/data/backup.db`), including the Drive node of every file and folder. An
  unchanged run costs one `stat` and one indexed lookup per file — no Drive
  requests and no file reads.
- **Identifies honestly** to Proton as `external-drive-proton_drive_backup@<version>`.

## Security

### No built-in authentication

The web UI and **all** API routes are **unauthenticated**. Anyone who can reach
the container's port can browse your local files, browse and **trash** Drive
files, create and run backups, and log out the session. There is no login on the
app itself.

Run it only on a **trusted network**, or put it behind a reverse proxy
(nginx/Traefik/Caddy/Cloudflare) that enforces its own authentication. **Do not
expose the port directly to the internet.** Bind it to localhost or a private
interface (e.g. `127.0.0.1:3005:3000`) when in doubt.

### Session at rest

The session (tokens and the key password Proton hands over at sign-in) lives
unencrypted in `/data/proton/auth-session.json`, mode 0600 — the same file the
CLI releases used with `PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file`.

Because the app must start and use the session unattended, it can't meaningfully
encrypt it at rest by itself (any key it could use would also have to sit on the
same host). The robust mitigation is **storage-layer encryption of the `/data`
volume**, e.g. an encrypted ZFS dataset on TrueNAS or a LUKS volume. The `/data`
volume is otherwise root-only; treat it like any other secret store.

## Quick start

```bash
docker compose up -d
# then open http://localhost:3005
```

The bundled [`docker-compose.yml`](docker-compose.yml) pulls the prebuilt image
from GHCR; uncomment `build: .` there to build locally instead. Mount the folders
you want to back up under `/sources` (read-only is recommended - the tool only
ever reads them):

```yaml
services:
  proton-drive:
    container_name: proton-drive-backup
    image: ghcr.io/traktuner/docker-proton-drive-backup:latest
    # build: .            # or build locally instead of pulling
    ports:
      - "3005:3000"       # host:container - change the host port freely
    volumes:
      - ./data:/data            # session + SQLite DB (keep to stay logged in)
      - ./sources:/sources:ro   # folders to back up -> left pane (read-only)
    environment:
      - TZ=Europe/Vienna  # timezone for scheduled runs (default UTC)
    restart: unless-stopped
```

Multiple sources need care: `runc` creates each nested mount's mountpoint
*inside* its parent mount. If the corresponding subdirectory does not already
exist on the host, a read-only parent makes container start fail with
`make mountpoint "/sources/...": read-only file system`
([#72](https://github.com/traktuner/docker-proton-drive-backup/issues/72)).
Do **not** just add nested `- /mnt/share:/sources/share:ro` lines while
`- ./sources:/sources:ro` stays active. Use one of these layouts instead:

```yaml
    volumes:
      # (a) parent mounted read-write; the nested real-data mounts stay :ro.
      #     NOTE: the parent directory itself is then writable from inside the
      #     container (your data in the nested mounts is not), and runc leaves
      #     the created mountpoint directories behind on the host.
      - ./sources:/sources:rw
      - /mnt/nas/photos:/sources/photos:ro
      - /mnt/nas/documents:/sources/documents:ro
```

```yaml
    volumes:
      # (b) no parent mount at all — each share mounts directly into the
      #     image's /sources directory. Nothing else is writable or visible.
      - /mnt/nas/photos:/sources/photos:ro
      - /mnt/nas/documents:/sources/documents:ro
```

Mounted shares show up as top-level folders in the left pane; backup-set source
paths are relative to `/sources` (e.g. `/photos/...`).

## Supported architectures

The image is published for **`linux/amd64`** and **`linux/arm64`**. To check a
host: `uname -m` must report `x86_64` or `aarch64`. There is **no 32-bit ARM**
build.

Practical arm64 targets: Raspberry Pi 4/5 on a **64-bit** OS, Apple Silicon, and
generic arm64 Linux servers.

> [!NOTE]
> **Synology:** most ARM Synology models cannot run Docker at all - Synology's
> Container Manager is offered only on the x86 "+" models. Those run the amd64
> image. The arm64 image is mainly useful for Raspberry Pi / Apple Silicon /
> arm64 Linux, not for typical ARM NAS app stores.

## Using it

1. Open the UI → **Connect Proton Drive** → finish sign-in in the opened tab (or
   copy the URL to another device). You're redirected once the session is live.
2. On the **Files** page: tick local files/folders on the left, navigate to (or
   create) a target folder on the right, give the set a name, pick a **mode** (and
   optionally a schedule and excludes), then **Create backup set**.
3. Hit **Run** on a set to upload now. Status (running/success/error) updates live.

## Backup modes

| Mode | What it does |
|---|---|
| **Add new** | Uploads only files that don't exist on Drive yet. Never updates or deletes. Lightest - good for write-once archives. |
| **Backup** (recommended) | Uploads new files and re-uploads only the ones that changed (by size, date, then checksum). Nothing is downloaded, unchanged files are skipped. Files you delete locally stay on Drive. |
| **Mirror** ⚠ | Like Backup, but also **trashes** files on Drive that you removed locally (only within the folders you back up). |

A changed file in **Backup**/**Mirror** mode is written as a **new revision** of the
same Drive file, so the previous version stays in your Drive version history and
is restorable. Folders are mirrored too, including empty ones.

**What a run detects.** A file counts as changed when its size differs, or when
its modification time differs by more than 2 s *and* its SHA-1 differs from the
one recorded (or, for catalogs from 0.x releases, from the one Drive stores). A
change that keeps both size and modification time identical is invisible to this
fast check — **Shift-click Verify** for a content verify: it reads every local file
and compares its SHA-1 with Drive's, then re-uploads mismatches on the next run.

**Exactly once.** A file is only recorded after Drive confirmed the upload. If the
container dies after Drive confirmed but before the record was written, the next
run finds Drive already holding that exact content and records it — no second
revision. A Drive item with the same name that already holds the local content is
adopted the same way instead of being uploaded again.

**Mirror safety.** Deletion moves items to the **Drive trash** (restorable) and is
skipped, with the reason shown, when:
- a source path is missing, or a source that was a mounted share last time is now
  a plain directory of the container (NAS offline, empty mountpoint left behind);
- a source is completely **empty** although it held files last time — if you
  emptied it (or changed the mounts) on purpose, **Apply deletions** in the set's
  row confirms it once. The "last time" reference is only updated by a run whose
  sources looked fine, so an offline share never becomes the new normal;
- any upload failed or a file was unreadable in this run;
- more than the configured share of the catalog would be removed (Settings →
  Mirror safety; default 30%, can be disabled — the other gates cannot).

Before an item is trashed it is re-read from Drive and must still be the node this
backup uploaded, in the same place and under the same name. A folder that contains
anything this backup did not upload is kept; only our files inside it are trashed.
**Preview** (dry run) uses the same scan and the same rules.

**The set's Drive folder** is identified by its node, not its name: renamed on
Drive → followed; moved, deleted, or replaced by a new folder with the same name →
the run stops without writing and tells you. **Verify** re-checks the set (and, if
the folder is really gone, starts the set over).

## What gets skipped (a backup is never stopped by one bad file)

A backup **never pauses or aborts** because of an individual file. If a single
file can't be backed up, it is **skipped** and the rest of the run continues; the
skipped files are listed per run in the set's **"N files skipped"** panel (with the
reason), so nothing is ever lost silently. A file is skipped when:

- **Its name is unsupported by Proton Drive.** Proton limits each file/folder name
  to **255 characters**. In practice a local file can't exceed this (Linux caps a
  name at 255 bytes), and names with special characters (e.g. `Movie [1080p].mkv`)
  are handled automatically — but if Drive ever rejects a name, that one file is
  skipped, not the whole backup.
- **It can't be read** (permission or I/O error). It's counted and named as skipped
  instead of vanishing silently — and in Mirror mode this also prevents an
  unreadable-but-present file from being mistaken for "deleted".
- **It's hidden** (a dotfile like `.env`/`.config`) and the set's **"Include hidden
  files"** option is off (the default).

## Scheduling

Each set can run **off** (manual only), **hourly**, **daily**, or **weekly**.
Scheduled times use the container's local time, so set the `TZ` environment
variable (default UTC). Missed runs (container was off) are caught up on the next
tick, once. Scheduled runs wait while signed out or while the Proton account is
unconfirmed, and run as soon as that is resolved.

## Declarative config

Set up backup sets without the UI: mount a `/config` directory containing a
`backup-sets.yaml` (or `.yml`/`.json`) and the container imports them on startup
(idempotent, upsert by name). Export the file from the UI to get the format. You
still sign in interactively once. See the volume `(3)` comment in
[`docker-compose.yml`](docker-compose.yml).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TZ` | `UTC` | Timezone for scheduled runs |
| `DB_PATH` | `/data/backup.db` | SQLite database path |
| `LOCAL_ROOT` | `/sources` | Folder shown in the left pane |
| `CONFIG_DIR` | `/config` | Directory scanned for declarative `backup-sets.*` |
| `PROTON_DRIVE_CACHE_DIR` | `/data/proton` | Holds the session file `auth-session.json` (persist this) |
| `HOME` | `/data/proton` | HOME for the app, kept on the writable `/data` volume so a read-only root and a non-root user both work |
| `GITHUB_REPO` | `traktuner/docker-proton-drive-backup` | Repo for the in-app update check |
| `PDB_ENABLE_DOWNLOAD` | *(unset)* | `1` enables `GET /api/drive/download` (test/diagnostics; exposes Drive content to anyone who can reach the port) |

`PROTON_DRIVE_CLI`, `PROTON_DRIVE_CREDENTIALS_STORE`, `PROTON_DRIVE_LOG_LEVEL` and
`BUN_JSC_forceRAMSize` belonged to the CLI releases and are ignored. The SDK version
is pinned in `package.json` and updated by a workflow ([docs/SDK-UPDATE.md](docs/SDK-UPDATE.md)).

## Memory

One Node.js process does everything, so memory is predictable: about 60 MiB idle,
signed out or in. During a run, memory is bounded by design — a fixed number of
files in flight (**Settings → Uploads → parallel uploads**, at most 5 — the SDK's own
limit, which also caps file data in flight at 40 MiB; per large file the SDK buffers
at most 15 encrypted 4 MiB blocks), each streamed from
disk in 1 MiB chunks into the SDK's 4 MiB encryption blocks; the local scan runs
in a separate thread with one batch in flight; the catalog lives in SQLite, not in
memory. A fast disk and a slow uplink do not make memory grow: the scan simply
waits for uploads.

Levers: fewer parallel uploads; **skip thumbnails** per set (thumbnails decode each
image, one at a time). `BUN_JSC_forceRAMSize` from the CLI releases is no longer
used.

## Hardening

The [`docker-compose.yml`](docker-compose.yml) ships safe defaults (`no-new-privileges`,
`cap_drop: ALL`) and documents two stronger, opt-in modes. Both are booted on every
release by the deployment smoke matrix ([`test/deployment/smoke.sh`](test/deployment/smoke.sh)),
so an advertised mode can't ship broken.

**Read-only root filesystem.** The only path the app must write is the `/data`
volume (DB, Proton session, cache). Enable it with the two tmpfs mounts the
Next.js runtime needs:

```yaml
    read_only: true
    tmpfs:
      - /tmp
      - /app/.next/cache
```

`/config` (declarative import) is read-only input — omit it or mount it `:ro`; it is
never written.

**Run as a non-root user.** Two supported ways:

*(a) `user:` — you run the container as that UID.* The image runs as any UID; the
only requirement is that the **host** directory bound to `/data` is already writable
by it (the app writes the DB and session there); `/sources` stays read-only:

```bash
sudo chown -R 1000:1000 ./data
```

```yaml
    user: "1000:1000"
```

`HOME` lives on `/data`, so this composes with `read_only: true`.

*(b) `PUID`/`PGID` — the container fixes ownership for you.* Handy when you can't
chown the bind mount yourself: the container starts as root, `chown`s `/data` to the
given IDs, then drops to that unprivileged user (via `setpriv`) before running the
app. Do **not** combine it with `user:` or `read_only` (it must start privileged to
chown and drop):

```yaml
    environment:
      - PUID=1000
      - PGID=1000
```

| Var | Default | Purpose |
|---|---|---|
| `PUID` | *(unset)* | If set (as root), chown `/data` and drop to this user id |
| `PGID` | *(unset)* | Group id paired with `PUID` |

(Note: some hosts with NFSv4 ACLs can hit a Docker-daemon `chmod … operation not
permitted` error when creating the bind-mount *source* — that is a host/daemon
interaction, not the container; pre-create the mount directories with the right
ownership.)

## Limit upload speed

**Settings → Uploads → Limit upload speed** caps how fast backups read files for
upload (KB/s, shared by all parallel uploads). It needs no extra capability — the
`cap_add: [NET_ADMIN]` the CLI releases required can be removed — never slows the
web UI, and applies within a second, also to a running backup.

## API

All routes are unauthenticated (see [Security](#security)).

| Method | Route | |
|---|---|---|
| POST | `/api/auth/login` | start login, returns `signInUrl` |
| GET | `/api/auth/status` | `{ authenticated, loginState, signInUrl, error }` |
| POST | `/api/auth/logout` | log out |
| GET | `/api/local/list?path=` | list local files under `LOCAL_ROOT` |
| GET | `/api/drive/list?path=` | list a Proton Drive folder |
| POST | `/api/drive/folder` | create a Drive folder |
| GET/POST | `/api/backup-sets` | list / create backup sets |
| PATCH/DELETE | `/api/backup-sets/:id` | update / delete a set |
| POST | `/api/backup-sets/:id/source-paths` | safely add source roots to a stopped set |
| POST | `/api/backup-sets/:id/run` · `/cancel` · `/pause` | run / cancel / pause a set (`run?confirmSources=1` confirms an emptied or re-mounted Mirror source once) |
| POST | `/api/backup-sets/:id/verify` · `/dry-run` | reconcile with Drive (`?content=1`: also compare SHA-1 of every file) / preview |
| POST | `/api/auth/confirm` | confirm the signed-in account for the backup sets |
| GET | `/api/drive/revisions?path=` | revisions of a Drive file |
| GET | `/api/drive/download?revision=` | download a revision — disabled unless `PDB_ENABLE_DOWNLOAD=1` |
| GET | `/api/version` | app, image and SDK version |
| GET/POST | `/api/settings/mirror-safety` | read / update the global Mirror deletion threshold |

## Development

```bash
npm install        # Node 26 (built-in node:sqlite; no native build)
npm run dev        # http://localhost:3000 (builds the SDK bundle first)
npm run build      # SDK bundle + production build (standalone output)
npm run typecheck  # app + the SDK boundary against the pinned SDK types
npm test           # SDK pin check + vitest (engine regression suite on a fake Drive)
npm run test:smoke # boot every advertised deployment mode (needs an image)
npm run test:upgrade # published 0.x image → this image, see test/upgrade
npm run sdk:update -- <version>   # see docs/SDK-UPDATE.md
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the typecheck and
vitest suite on every push/PR, then the Docker deployment smoke matrix
([`test/deployment/smoke.sh`](test/deployment/smoke.sh)) — it starts the container in
every advertised mode (default, hardened, read-only, non-root, read-only + non-root)
and fails if any mode doesn't start and initialise, and the upgrade acceptance
test from the last published 0.x image ([`test/upgrade/upgrade.sh`](test/upgrade/upgrade.sh)).
Against real Proton Drive (dedicated test account): [`test/live/live.sh`](test/live/live.sh)
and [`test/live/takeover.sh`](test/live/takeover.sh).

## Project structure

```
src/
  app/
    onboarding/page.tsx   # login flow
    files/page.tsx        # dual-pane builder
    api/…                 # route handlers
  components/
    FilePane.tsx          # reusable local/drive browser
    BackupSets.tsx        # backup-set list + run/delete
    AuthProvider.tsx      # reactive session state + reconnect banner
  server/
    proton/runtime.ts     # THE SDK boundary (only file importing the SDK)
    proton/types.ts       # the small contract the rest of the app uses
    proton/vendor/        # pinned upstream account module + UPSTREAM.json
    drive.ts              # runtime loader, paths, login, account binding
    engine.ts             # backup engine (add/backup/mirror), dry run, verify
    scheduler.ts          # in-process schedule ticker
    local.ts              # local filesystem browsing + scanner thread
    db.ts                 # SQLite (node:sqlite) + schema migration
    runner.ts             # executes a backup set
Dockerfile · docker-compose.yml · docker-entrypoint.sh
```

## Notable changes

Newest first. Image tags are `<appVersion>-<revision>` (0.x tags followed the
bundled CLI version); these are app-level highlights, not per-tag notes.

- **1.0: Proton Drive SDK instead of the CLI** - one process instead of one CLI
  process per operation; every changed file is read once (the CLI read it twice,
  images three times); an unchanged run over a million files takes seconds of CPU
  instead of minutes and writes nothing; uploads reconcile with Drive so a crash can
  never create a duplicate revision; mirror deletions are identity-checked, never
  trash folders with foreign content and detect offline NAS shares; the upload
  speed limit needs no NET_ADMIN; changes to the set's Drive folder are detected.
  Upgrade and rollback keep `/data` as it is ([docs/UPGRADE.md](docs/UPGRADE.md)).

- **Bounded memory** - the CLI's Bun runtime is told to size its heap for 512 MiB
  per process instead of the whole container limit (`BUN_JSC_forceRAMSize`); the
  first-run seed uploads one top-level subtree per CLI process and records the
  catalog after each, so an OOM kill or restart mid-seed resumes instead of
  restarting; pending upload batches and captured CLI output are capped in the
  server. See [Memory](#memory). Also at scale: the mirror deletion pass and
  dry-run compute the top-most stale entries in linear time (was quadratic), and
  folders with tens of thousands of direct files upload in argv-sized chunks
  instead of failing the run with `E2BIG`.
- **Configurable Mirror deletion threshold** - the global 30% safety gate can be
  changed or disabled in Settings, while missing-source and upload-failure gates
  remain mandatory (issue #56).
- **Safe source additions for existing sets** - select extra local folders, open
  the stopped set's editor, and add them without resetting its upload catalog.
  Existing sources cannot be removed from this workflow, overlapping roots are
  rejected, and queued/running sets remain locked, so unchanged files never
  re-upload and Mirror cannot interpret an edit as a deletion (issue #51).
- **Multi-arch image** - now built for `linux/arm64` as well as `linux/amd64`.
- **Session reconnect UX** - a persistent banner and live status indicator when
  the Proton session expires; reconnect happens in place without losing your work.
  Backup runs stop cleanly with a clear message if the session dies mid-run.
- **Mirror deletion safety** - the deletion pass is skipped when any upload failed
  in the run, so a changed-but-failed file's Drive copy is never trashed.
- **CLI 0.8.0 conflict strategies** - changed files use the explicit
  `create-new-revision` strategy, while folder conflicts continue to use `merge`.
- **Delta backup engine** - streams the source tree, uploads only new/changed
  files, scales to millions of files; structure-preserving Drive layout; mirror
  deletion guards and a Drive verify/reconcile pass.

## Troubleshooting

- **"Proton session expired" right after upgrading from 0.x** - Proton did not
  accept the old session; click **Reconnect** and sign in once. Sets are untouched.
- **Backups wait for "Confirm the Proton account"** - see [docs/UPGRADE.md](docs/UPGRADE.md).
- **Left pane empty** - mount your folders into `/sources`.
- **A Mirror run says a source is missing or empty** - check the NAS mount on the
  host; nothing was deleted. If you emptied the folder on purpose, use **Apply
  deletions** in the set's row.
- **Container OOM-killed during a backup** - lower Settings → Uploads → parallel
  uploads and/or skip thumbnails for photo sets; see [Memory](#memory).
- **Diagnostics:** `GET /api/version` shows the app version, image tag, SDK
  version, upstream commit and the exact `x-pm-appversion` sent to Proton.

## License

[MIT](LICENSE) © traktuner.

The image bundles the Proton Drive SDK, `@protontech/crypto` and Proton's account
module (MIT, © Proton AG; see `dist-proton/runtime.mjs.LEGAL.txt` and
`src/server/proton/vendor/account/LICENSE.md`). Using Proton's services is subject
to Proton's terms; see the SDK's usage guidelines for third-party apps.

## Trademark

"Proton", "Proton Drive", "Proton Mail" and related names and logos are trademarks
of **Proton AG**. This project is not affiliated with, endorsed by, or sponsored by
Proton AG. The names are used solely to identify the upstream software this tool
works with.
