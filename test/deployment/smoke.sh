#!/usr/bin/env bash
#
# Deployment smoke matrix — the "advertised but doesn't start" guard.
#
# Builds (or reuses) the image and boots the container in EVERY advertised
# deployment mode, asserting it actually starts and initialises. This is the test
# that would have caught #19 (read-only root aborts on `mkdir /config`) and #20
# (running as a non-root `user:`), so a documented-but-broken deployment mode can
# never ship silently again.
#
# For each mode the container must:
#   1. reach a healthy GET /api/health          — the server process booted
#   2. serve GET /api/backup-sets with HTTP 200  — the SQLite DB + instrumentation
#      actually initialised. This is deliberately stronger than /api/health, which
#      returns a static {"ok":true} WITHOUT touching /data and would report healthy
#      even if /data were unwritable and boot-time init had failed.
#   3. emit NO "Read-only file system" / EROFS in its logs — no stray write hit the
#      read-only root (covers a stray $HOME or Next.js runtime write).
#
# Usage:  test/deployment/smoke.sh [IMAGE]
#   IMAGE defaults to $SMOKE_IMAGE or proton-drive-backup:smoke. If the image is not
#   already present it is built from the repo. Env knobs: SMOKE_PORT, SMOKE_WAIT.
#
# Requires: docker, curl. Non-root modes chown the data dir to uid 1000, which needs
# the caller to be root (CI runners are) — otherwise those modes are skipped with a
# clear warning rather than a false failure.
set -euo pipefail

IMAGE="${1:-${SMOKE_IMAGE:-proton-drive-backup:smoke}}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST_PORT="${SMOKE_PORT:-3999}"
WAIT_SECS="${SMOKE_WAIT:-90}"
NONROOT_UID=1000
NONROOT_GID=1000

blue() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
green() { printf '\033[1;32mPASS:\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"

# Build unless the image already exists (CI can pass a prebuilt tag to skip this).
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  blue "Building image $IMAGE from $REPO_ROOT"
  docker build -t "$IMAGE" "$REPO_ROOT"
else
  blue "Reusing existing image $IMAGE"
fi

WORK="$(mktemp -d)"
CURRENT_CTR=""
cleanup() {
  [ -n "$CURRENT_CTR" ] && docker rm -f "$CURRENT_CTR" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# The ADVERTISED deployment matrix.  Fields: name | extra `docker run` args | nonroot
# Keep every mode advertised in docker-compose.yml represented here — the
# consistency vitest test (test/deployment/consistency.test.ts) enforces that link.
# ---------------------------------------------------------------------------
run_mode() {
  local name="$1" extra="$2" nonroot="${3:-0}" expect_uid="${4:-}" expect_canshape="${5:-}"
  local ctr="pdb-smoke-${name}"
  local ddir="$WORK/$name/data" sdir="$WORK/$name/sources"

  blue "Mode: $name  (args: ${extra:-<none>})"
  mkdir -p "$ddir" "$sdir"
  printf 'hello from smoke test\n' > "$sdir/sample.txt"

  # Modes that pre-chown the data dir (nonroot) OR verify the in-container owner
  # (PUID/PGID) need the runner to be root; skip cleanly otherwise.
  if { [ "$nonroot" = "1" ] || [ -n "$expect_uid" ]; } && [ "$(id -u)" != "0" ]; then
    printf '\033[1;33mSKIP:\033[0m %s — need root (chown / uid verification)\n' "$name" >&2
    return 0
  fi
  if [ "$nonroot" = "1" ]; then
    # A `user:`-launched container must be able to WRITE /data (DB, session, cache).
    chown -R "${NONROOT_UID}:${NONROOT_GID}" "$ddir"
  fi

  docker rm -f "$ctr" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker run -d --name "$ctr" $extra \
    -v "$ddir:/data" -v "$sdir:/sources:ro" \
    -p "$HOST_PORT:3000" "$IMAGE" >/dev/null
  CURRENT_CTR="$ctr"

  # (1) wait for the server to answer /api/health
  local base="http://localhost:$HOST_PORT" healthy=0 i
  for ((i = 0; i < WAIT_SECS; i++)); do
    if ! docker ps --format '{{.Names}}' | grep -qx "$ctr"; then
      echo "----- docker logs ($name) -----" >&2; docker logs "$ctr" >&2 || true
      fail "$name: container exited during startup"
    fi
    if curl -fsS "$base/api/health" >/dev/null 2>&1; then healthy=1; break; fi
    sleep 1
  done
  [ "$healthy" = "1" ] || { docker logs "$ctr" >&2 || true; fail "$name: /api/health never became healthy within ${WAIT_SECS}s"; }

  # (2) prove real initialisation — DB-backed route must return 200 with a list
  local body
  body="$(curl -fsS "$base/api/backup-sets" 2>/dev/null)" \
    || { docker logs "$ctr" >&2 || true; fail "$name: GET /api/backup-sets failed (DB/instrumentation did not initialise)"; }
  echo "$body" | grep -q '"backupSets"' \
    || { echo "body: $body" >&2; fail "$name: /api/backup-sets did not return a backupSets list"; }

  # (3) no read-only violations in the logs
  if docker logs "$ctr" 2>&1 | grep -Eiq 'read-only file system|EROFS'; then
    echo "----- docker logs ($name) -----" >&2; docker logs "$ctr" >&2 || true
    fail "$name: container logged a read-only filesystem error"
  fi

  # (4) PUID/PGID: prove the process actually DROPPED — the DB it just wrote must be
  # owned by the requested uid, not root. (The entrypoint chowned /data and re-exec'd
  # via setpriv.)
  if [ -n "$expect_uid" ]; then
    local owner
    owner="$(docker exec "$ctr" stat -c '%u' /data/backup.db 2>/dev/null || echo '?')"
    [ "$owner" = "$expect_uid" ] \
      || { docker logs "$ctr" >&2 || true; fail "$name: /data/backup.db owned by uid '$owner', expected '$expect_uid' — privilege drop did not take effect"; }
  fi

  # (5) Speed-limit capability (issue #23): with NET_ADMIN the app must report it can
  # shape traffic; without it, must report it cannot (so the UI never lies).
  if [ -n "$expect_canshape" ]; then
    local cs
    cs="$(curl -fsS "$base/api/settings/uploads" 2>/dev/null | grep -o '"canShape":[a-z]*' | cut -d: -f2)"
    [ "$cs" = "$expect_canshape" ] \
      || { docker logs "$ctr" >&2 || true; fail "$name: /api/settings/uploads canShape='$cs', expected '$expect_canshape'"; }
  fi

  green "$name — started, initialised (/api/backup-sets 200), no read-only errors${expect_uid:+, dropped to uid $expect_uid}${expect_canshape:+, canShape=$expect_canshape}"
  docker rm -f "$ctr" >/dev/null 2>&1 || true
  CURRENT_CTR=""
}

blue "Deployment smoke matrix against $IMAGE"
run_mode "default"            ""                                                            0 "" "false"
run_mode "hardened"           "--security-opt no-new-privileges:true --cap-drop ALL"
run_mode "read-only"          "--read-only --tmpfs /tmp --tmpfs /app/.next/cache"
run_mode "non-root"           "--user ${NONROOT_UID}:${NONROOT_GID}" 1
run_mode "read-only-non-root" "--read-only --tmpfs /tmp --tmpfs /app/.next/cache --user ${NONROOT_UID}:${NONROOT_GID}" 1
# PUID/PGID convenience layer: root container that chowns /data and drops itself.
run_mode "puid-pgid"          "-e PUID=${NONROOT_UID} -e PGID=${NONROOT_GID}" 0 "${NONROOT_UID}"
# Speed-limit opt-in: NET_ADMIN must flip canShape true (tc/iproute2 present + cap).
run_mode "net-admin"          "--cap-add NET_ADMIN" 0 "" "true"

printf '\n\033[1;32mAll deployment smoke modes passed.\033[0m\n'
