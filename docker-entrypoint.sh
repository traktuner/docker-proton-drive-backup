#!/bin/sh
set -e

# Persistent dirs for the SQLite DB, the proton-drive session/cache, the mount
# point for the folders you want to back up, and the optional declarative config.
mkdir -p /data /data/proton /sources /config

exec "$@"
