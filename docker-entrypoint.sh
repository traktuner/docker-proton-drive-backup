#!/bin/sh
set -e

# Persistent dirs for the SQLite DB + the proton-drive session/cache, plus the
# read-only source mount. Created best-effort, PER directory: a read-only root
# filesystem (the hardened compose) or a read-only bind of any of these must never
# abort startup. `mkdir -p` on an already-present mount is a harmless no-op.
#
# /config (the OPTIONAL declarative-import volume) is deliberately NOT created: the
# app only ever READS it (autoImportFromConfigDir tolerates its absence), so
# creating it is pointless AND fails on a read-only root when it isn't mounted —
# which is exactly what aborted startup in the hardened config (issue #19).
for d in /data /data/proton /sources; do
  mkdir -p "$d" 2>/dev/null || true
done

# PUID/PGID convenience layer (issue #20). If we start as ROOT and PUID or PGID is
# set, take ownership of the writable /data volume and re-exec DROPPED to that
# unprivileged user — for hosts where you can't chown the bind-mount source
# yourself. If you instead run with a compose `user:` we're already non-root here,
# so this branch is skipped entirely (that path needs the host /data to be writable
# by your UID — see README → Hardening). setpriv (util-linux, always in the image)
# performs the drop; gosu is honoured too if an operator added it.
DROP=""
if [ "$(id -u)" = "0" ] && [ -n "${PUID:-}${PGID:-}" ]; then
  _uid="${PUID:-1000}"
  _gid="${PGID:-1000}"
  chown -R "$_uid:$_gid" /data 2>/dev/null || true
  if command -v setpriv >/dev/null 2>&1; then
    DROP="setpriv --reuid=$_uid --regid=$_gid --clear-groups"
  elif command -v gosu >/dev/null 2>&1; then
    DROP="gosu $_uid:$_gid"
  else
    echo "[entrypoint] WARNING: PUID/PGID set but neither setpriv nor gosu is available; staying root" >&2
  fi
  [ -n "$DROP" ] && echo "[entrypoint] dropping privileges to ${_uid}:${_gid} (PUID/PGID)"
fi

# Restrict the session dir (holds the plaintext token) to its owner. Best-effort:
# never abort startup if a non-root `user:` or a chmod-less bind mount (SMB/NTFS)
# can't apply it - then the hardening just doesn't take effect there.
chmod 700 /data/proton 2>/dev/null || true
chmod 600 /data/proton/auth-session.json 2>/dev/null || true

# HOME must point at a WRITABLE dir so any stray dotfile a dependency or the CLI
# writes never hits a read-only root fs (matters under read_only:true and when
# running as a non-root `user:`). Default to the writable, persistent proton cache
# dir (the Dockerfile bakes the same value as ENV); honour an operator-set HOME.
# The proton session itself does NOT live here — it's in PROTON_DRIVE_CACHE_DIR —
# so this is purely a safety net, not the session store.
export HOME="${HOME:-/data/proton}"

# $DROP is intentionally unquoted so it word-splits into the setpriv/gosu prefix;
# it is empty in the normal (root or compose-`user:`) case → just `exec "$@"`.
# shellcheck disable=SC2086
exec $DROP "$@"
