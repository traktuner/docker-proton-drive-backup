#!/bin/sh
set -e

# Persistent dirs for the SQLite DB, the proton-drive session/cache, the mount
# point for the folders you want to back up, and the optional declarative config.
mkdir -p /data /data/proton /sources /config

# Restrict the session dir (holds the plaintext token) to its owner. Best-effort:
# never abort startup if a non-root `user:` or a chmod-less bind mount (SMB/NTFS)
# can't apply it - then the hardening just doesn't take effect there.
chmod 700 /data/proton 2>/dev/null || true
chmod 600 /data/proton/auth-session.json 2>/dev/null || true

exec "$@"
