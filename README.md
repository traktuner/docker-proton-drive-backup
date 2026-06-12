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
- **Secrets** use the CLI's file-based store via `PROTON_DRIVE_UNSAFE_SECRETS=1`,
  so the container never needs libsecret/gnome-keyring/D-Bus. The session is
  written under `PROTON_DRIVE_CACHE_DIR` (`/data/proton`) and survives restarts.
- Backup sets are stored in SQLite (`/data/backup.db`).

### Session security

The proton-drive CLI can only store its session two ways: the OS keyring
(libsecret - unavailable/unreliable in a container) or a **plaintext file**
(`PROTON_DRIVE_UNSAFE_SECRETS=1`). It has no built-in encryption option. So the
session token lives unencrypted in `/data/proton/auth-session.json`.

Because the app must start and use the session unattended, it can't meaningfully
encrypt it at rest by itself (any key it could use would also have to sit on the
same host). The robust mitigation is **storage-layer encryption of the `/data`
volume** - e.g. an encrypted ZFS dataset on TrueNAS or a LUKS volume. The `/data`
volume is otherwise root-only; treat it like any other secret store.

## Quick start

```bash
docker compose up -d --build
# then open http://localhost:3005
```

Mount the folders you want to back up into `/sources` (they appear in the left
pane). The default compose file maps `./sources` → `/sources` and `./data` →
`/data`.

```yaml
services:
  proton-drive:
    container_name: proton-drive
    build: .
    ports:
      - "3005:3000"
    volumes:
      - ./data:/data        # session + SQLite DB (keep to stay logged in)
      - ./sources:/sources  # folders to back up -> left pane
    restart: unless-stopped
```

## Using it

1. Open the UI → **Connect Proton Drive** → finish sign-in in the opened tab (or
   copy the URL to another device). You're redirected once the session is live.
2. On the **Files** page: tick local files/folders on the left, navigate to (or
   create) a target folder on the right, give the set a name, pick a conflict
   strategy, and **Create backup set**.
3. Hit **Run** on a set to upload now. Status (running/success/error) updates live.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DB_PATH` | `/data/backup.db` | SQLite database path |
| `LOCAL_ROOT` | `/sources` | Folder shown in the left pane |
| `PROTON_DRIVE_CLI` | `/usr/local/bin/proton-drive` | CLI binary path |
| `PROTON_DRIVE_CACHE_DIR` | `/data/proton` | Session + cache + logs (persist this) |
| `PROTON_DRIVE_UNSAFE_SECRETS` | `1` | File-based secret store (required in Docker) |
| `PROTON_DRIVE_LOG_LEVEL` | `ERROR` | CLI log verbosity |

The CLI version is pinned via the `PROTON_CLI_VERSION` build arg in the Dockerfile.

## API

| Method | Route | |
|---|---|---|
| POST | `/api/auth/login` | start login, returns `signInUrl` |
| GET | `/api/auth/status` | `{ authenticated, loginState, signInUrl }` |
| POST | `/api/auth/logout` | log out |
| GET | `/api/local/list?path=` | list local files under `LOCAL_ROOT` |
| GET | `/api/drive/list?path=` | list a Proton Drive folder |
| POST | `/api/drive/folder` | create a Drive folder |
| GET/POST | `/api/backup-sets` | list / create backup sets |
| DELETE | `/api/backup-sets/:id` | delete a set |
| POST | `/api/backup-sets/:id/run` | run a set now |

## Development

```bash
npm install      # needs Node 20 (better-sqlite3 native build)
npm run dev      # http://localhost:3000
npm run build    # production build (standalone output)
```

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
  server/
    cli.ts                # one-shot CLI runner + login manager + auth probe
    local.ts              # local filesystem browsing
    db.ts                 # SQLite (better-sqlite3)
    runner.ts             # executes a backup set
Dockerfile · docker-compose.yml · docker-entrypoint.sh
```

## Troubleshooting

- **Login shows no URL / `ERR_SECRETS_PLATFORM_ERROR`** - ensure
  `PROTON_DRIVE_UNSAFE_SECRETS=1` is set (it is by default in the image). This is
  what avoids the keyring/D-Bus requirement.
- **Left pane empty** - mount your folders into `/sources`.
- **Check the CLI works:** `docker exec -it proton-drive proton-drive version`

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
