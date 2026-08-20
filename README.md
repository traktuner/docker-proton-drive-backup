# Proton Drive Backup

A self-hosted web app that turns the official **proton-drive CLI** into a classic
left → right backup tool: browse local folders on the left, your Proton Drive on
the right, and define "backup sets" that upload the former into the latter.

> [!IMPORTANT]
> **Not affiliated with Proton.** This is an independent, community-built project.
> It is **not** made, endorsed, sponsored, or supported by Proton AG. "Proton",
> "Proton Drive" and related marks are trademarks of Proton AG, used here only
> nominatively to describe what this tool interoperates with. For the official
> product and support, see [proton.me](https://proton.me).

## Why the CLI (and not the SDK)?

The [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk) explicitly does
**not** include authentication, login flows or session management - you'd have to
reimplement Proton's SRP/SSO login and key handling yourself. The official CLI is
the SDK *plus* all of that, maintained by Proton. So this app wraps the CLI and
gets the SDK's capabilities for free.

## How it works

- **Single Next.js container** serving the web UI and invoking the CLI.
- Every Drive operation runs the CLI **one-shot** (`proton-drive … -j`) and parses
  the JSON - no fragile interactive REPL.
- **Login** spawns `proton-drive auth login`, captures the printed sign-in URL,
  shows it in the UI, and polls until you finish signing in any browser. No
  localhost callback needed, so it works for a remote/headless server.
- **Secrets** use the CLI's file-based store via `PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file`
  (CLI 0.6.0+, replacing the removed `PROTON_DRIVE_UNSAFE_SECRETS=1`), so the container
  never needs libsecret/gnome-keyring/D-Bus. The session is written under
  `PROTON_DRIVE_CACHE_DIR` (`/data/proton`) and survives restarts.
- Backup sets are stored in SQLite (`/data/backup.db`).
- An in-process scheduler runs scheduled sets on the container's local time.

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

The proton-drive CLI can only store its session two ways: the OS keyring
(libsecret - unavailable/unreliable in a container), `pass` (requires GPG/pass
setup), or a **plaintext file** (`PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file`,
the default in this image). It has no built-in encryption option. So the
session token lives unencrypted in `/data/proton/auth-session.json`.

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

Mount each share you want to back up as its own subfolder under `/sources`
(e.g. `- /mnt/nas/photos:/sources/photos:ro`); they show up as top-level folders
in the left pane.

## Supported architectures

The image is published for **`linux/amd64`** and **`linux/arm64`**. To check a
host: `uname -m` must report `x86_64` or `aarch64`. There is **no 32-bit ARM**
build - the Proton Drive CLI ships no `armhf`/`armv7` binary, so devices that
report `armv7l` cannot run this at all.

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

A changed file in **Backup**/**Mirror** mode is written as a **new revision** in
Proton Drive (so the previous version stays in your Drive version history and is
restorable), not re-uploaded as a brand-new file. This uses the CLI 0.8.0
`create-new-revision` file conflict strategy.

**Mirror safety:** the deletion pass is skipped (and flagged) if a configured
source path is missing on disk, if any upload failed during the run, or if more
than ~30% of the catalog would be removed at once. Re-run after fixing the cause
to apply pending deletions.

## What gets skipped (a backup is never stopped by one bad file)

A backup **never pauses or aborts** because of an individual file. If a single
file can't be backed up, it is **skipped** and the rest of the run continues; the
skipped files are listed per run in the set's **"N files skipped"** panel (with the
reason), so nothing is ever lost silently. A file is skipped when:

- **Its name is unsupported by Proton Drive.** Proton limits each file/folder name
  to **255 characters**. In practice a local file can't exceed this (Linux caps a
  name at 255 bytes), and names with special characters (e.g. `Movie [1080p].mkv`)
  are handled automatically — but if the CLI ever rejects a name, that one file is
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
tick. Scheduled runs are paused while signed out.

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
| `PROTON_DRIVE_CLI` | `/usr/local/bin/proton-drive` | CLI binary path |
| `PROTON_DRIVE_CACHE_DIR` | `/data/proton` | Session + cache + logs (persist this) |
| `PROTON_DRIVE_CREDENTIALS_STORE` | `unsafe_file` | File-based secret store (required in Docker; CLI 0.6.0+) |
| `PROTON_DRIVE_LOG_LEVEL` | `ERROR` | CLI log verbosity |
| `HOME` | `/data/proton` | HOME for the app + CLI, kept on the writable `/data` volume so a read-only root and a non-root user both work |
| `GITHUB_REPO` | `traktuner/docker-proton-drive-backup` | Repo for the in-app update check |

The CLI version is pinned via the `PROTON_CLI_VERSION` build arg in the Dockerfile
and bumped automatically (see "Notable changes").

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

The Proton Drive CLI has **no** bandwidth flag, and the app doesn't own its byte
stream, so the only reliable way to cap upload speed is to shape traffic in the
kernel with `tc` — which needs the **`NET_ADMIN`** capability. It's therefore
opt-in and a deliberate, documented exception to `cap_drop: ALL`:

```yaml
    cap_drop: [ALL]
    cap_add: [NET_ADMIN]   # only for "Limit upload speed"
```

Then set the limit in **Settings → Uploads → Limit upload speed** (KB/s). Without
`NET_ADMIN` the control shows as unavailable rather than silently doing nothing.

Notes: the cap is approximate, shared across all parallel uploads, applied to the
whole container's egress **only while a backup runs** (removed afterwards so
browsing isn't throttled), and takes effect on the next run. A minimum of 50 KB/s
is enforced so the shaper can't starve the CLI's own API calls. `trickle` was
evaluated and rejected — its `LD_PRELOAD` interception is unreliable against the
CLI's bundled runtime and can silently fail to limit anything.

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
| POST | `/api/backup-sets/:id/run` · `/cancel` · `/verify` | run / cancel / verify a set |

## Development

```bash
npm install      # needs Node 24 (better-sqlite3 native build)
npm run dev      # http://localhost:3000
npm run build    # production build (standalone output)
npm run typecheck # tsc --noEmit
npm test         # vitest — server logic + deployment static guards
npm run test:smoke # build the image and boot every advertised deployment mode
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the typecheck and
vitest suite on every push/PR, then the Docker deployment smoke matrix
([`test/deployment/smoke.sh`](test/deployment/smoke.sh)) — it starts the container in
every advertised mode (default, hardened, read-only, non-root, read-only + non-root)
and fails if any mode doesn't start and initialise. That is the guard that makes an
"advertised but doesn't start" deployment impossible to merge.

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
    cli.ts                # one-shot CLI runner + login manager + auth probe
    engine.ts             # delta backup engine (add/backup/mirror)
    scheduler.ts          # in-process schedule ticker
    local.ts              # local filesystem browsing
    db.ts                 # SQLite (better-sqlite3)
    runner.ts             # executes a backup set
Dockerfile · docker-compose.yml · docker-entrypoint.sh
```

## Notable changes

Newest first. Image tags follow the bundled `proton-drive` CLI version
(`<cliVersion>-<revision>`); these are app-level highlights, not per-tag notes.

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

- **Login shows no URL / `ERR_SECRETS_PLATFORM_ERROR` / "Cannot spawn a message bus
  without a machine-id"** - ensure `PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file` is
  set (it is by default in the image). This avoids the keyring/D-Bus requirement.
  (On CLI 0.6.0+ the old `PROTON_DRIVE_UNSAFE_SECRETS=1` was removed and replaced
  by `PROTON_DRIVE_CREDENTIALS_STORE` with values `keychain` (default) /
  `unsafe_file` / `pass`.)
- **Left pane empty** - mount your folders into `/sources`.
- **Check the CLI works:** `docker exec -it proton-drive-backup proton-drive version`

## License

[MIT](LICENSE) © traktuner.

The bundled `proton-drive` CLI binary is downloaded from Proton at build time and
remains under **Proton's own license and terms** - the MIT license covers only the
code in this repository, not that binary.

## Trademark

"Proton", "Proton Drive", "Proton Mail" and related names and logos are trademarks
of **Proton AG**. This project is not affiliated with, endorsed by, or sponsored by
Proton AG. The names are used solely to identify the upstream software this tool
works with.
