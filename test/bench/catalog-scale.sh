#!/usr/bin/env bash
# Large-catalog benchmark: N local files (default 1,000,000) already backed up
# (catalog filled the way the CLI-era engine fills it), then
#   run 1: unchanged follow-up Mirror run    (the daily case)
#   run 2: the same after changing 10 files  (small delta)
# for each image, under the same CPU/RAM limits. Drive is the shared fake
# (test/upgrade/fake), so the numbers show the app's own cost: walk, catalog,
# memory — the unchanged run does not touch Drive in either version anyway.
#
#   test/bench/catalog-scale.sh [N]   (env: OLD_IMAGE NEW_IMAGE CPUS MEM WORK)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
. "$ROOT/test/bench/lib.sh"
N=${1:-1000000}
OLD_IMAGE=${OLD_IMAGE:-ghcr.io/traktuner/docker-proton-drive-backup:0.9.0-21}
NEW_IMAGE=${NEW_IMAGE:-pdb:sdk}
CPUS=${CPUS:-2}
MEM=${MEM:-2g}
W=${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/pdb-scale-XXXXXX")}
PORT=13090

if [ ! -f "$W/sources/.done-$N" ]; then
  echo "generating $N files…"
  python3 -I - "$W/sources/bulk" "$N" <<'EOF'
import os, sys
root, n = sys.argv[1], int(sys.argv[2])
per = 1000
for d in range((n + per - 1) // per):
    p = os.path.join(root, f"d{d:04d}")
    os.makedirs(p, exist_ok=True)
    for i in range(min(per, n - d * per)):
        fp = os.path.join(p, f"f{i:04d}.dat")
        with open(fp, "wb") as f:
            f.write(b"x" * 16)
        os.utime(fp, (1700000000, 1700000000))
EOF
  touch "$W/sources/.done-$N"
fi

seed_catalog() { # rows exactly like the CLI-era seed writes them (no node id, no digest)
  local db=$1 set=$2
  sqlite3 "$db" >/dev/null <<EOF
PRAGMA journal_mode=WAL;
-- The CLI-era image creates this table lazily on first use; same DDL.
CREATE TABLE IF NOT EXISTS backup_catalog (set_id TEXT NOT NULL, rel TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER, mtime_ms INTEGER, sha1 TEXT, seen_at INTEGER NOT NULL, PRIMARY KEY (set_id, rel));
CREATE INDEX IF NOT EXISTS idx_catalog_seen ON backup_catalog (set_id, seen_at);
BEGIN;
INSERT OR IGNORE INTO backup_catalog (set_id, rel, kind, seen_at) VALUES ('$set', 'Bulk', 'dir', 1), ('$set', 'Bulk/bulk', 'dir', 1);
WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i < ($N - 1) / 1000)
  INSERT INTO backup_catalog (set_id, rel, kind, seen_at) SELECT '$set', printf('Bulk/bulk/d%04d', i), 'dir', 1 FROM c;
WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i < $N - 1)
  INSERT INTO backup_catalog (set_id, rel, kind, size, mtime_ms, sha1, seen_at)
  SELECT '$set', printf('Bulk/bulk/d%04d/f%04d.dat', i / 1000, i % 1000), 'file', 16, 1700000000000, NULL, 1 FROM c;
COMMIT;
EOF
}

bench_image() {
  local label=$1 image=$2 d="$W/run-$1"
  rm -rf "$d"; mkdir -p "$d/data/proton" "$d/fake-drive"
  # Fake Drive: target "/Backups" with the set folder "Bulk" and every folder the
  # seed created (files are not needed: neither version reads them back).
  python3 -I - "$d/fake-drive/state.json" "$N" <<'PY'
import json, sys
n = int(sys.argv[2])
nodes = {"root": {"uid": "root", "parentUid": None, "name": "my-files", "kind": "folder", "revisions": [], "trashed": False}}
def add(uid, parent, name):
    nodes[uid] = {"uid": uid, "parentUid": parent, "name": name, "kind": "folder", "revisions": [], "trashed": False}
add("t", "root", "Backups"); add("s", "t", "Bulk"); add("b", "s", "bulk")
for i in range((n + 999) // 1000):
    add(f"d{i}", "b", f"d{i:04d}")
json.dump({"nodes": nodes}, open(sys.argv[1], "w"))
PY
  echo '{"cachePassword":"cp","userKeyPassword":"u","session":{"uid":"s","accessToken":"at-0","refreshToken":"rt-0"}}' >"$d/data/proton/auth-session.json"
  local ctr="pdbscale-$label"
  docker rm -f "$ctr" >/dev/null 2>&1 || true
  # Start once to create the schema with THIS image's code, then seed the catalog.
  docker run -d --name "$ctr" --cpus "$CPUS" --memory "$MEM" -p "127.0.0.1:$PORT:3000" \
    -v "$d/data:/data" -v "$W/sources:/sources:ro" -v "$ROOT/test/upgrade/fake:/fake:ro" -v "$d/fake-drive:/fake-drive" \
    -e PROTON_DRIVE_CLI=/fake/proton-drive -e PROTON_RUNTIME=/fake/runtime.mjs -e FAKE_REFRESH=0 "$image" >/dev/null
  for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
  local id
  id=$(curl -fsS -X POST -H 'content-type: application/json' -d '{"name":"Bulk","sourcePaths":["/bulk"],"targetPath":"/Backups","mode":"mirror"}' "http://127.0.0.1:$PORT/api/backup-sets" | jq -r .backupSet.id)
  docker stop "$ctr" >/dev/null
  seed_catalog "$d/data/backup.db" "$id"
  docker start "$ctr" >/dev/null
  for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
  # The SDK release asks once which account the existing sets belong to (a fresh
  # DB here is not an upgrade); the CLI-era image has no such step (404, ignored).
  curl -sS -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/auth/confirm" >/dev/null || true
  sleep 3
  local idle; idle=$(mib "$(mem_cur "$ctr")")
  local r1; r1=$(run_and_measure "$ctr" "http://127.0.0.1:$PORT/api" "$id")
  for i in 1 2 3 4 5 6 7 8 9 10; do printf 'changed %s\n' "$i" >"$W/sources/bulk/d$(printf %04d $((i * 37)))/f0001.dat"; done
  local r2; r2=$(run_and_measure "$ctr" "http://127.0.0.1:$PORT/api" "$id")
  for i in 1 2 3 4 5 6 7 8 9 10; do printf 'x%.0s' $(seq 1 16) >"$W/sources/bulk/d$(printf %04d $((i * 37)))/f0001.dat"; touch -d @1700000000 "$W/sources/bulk/d$(printf %04d $((i * 37)))/f0001.dat"; done
  local msg; msg=$(curl -fsS "http://127.0.0.1:$PORT/api/backup-sets" | jq -r '.backupSets[0].lastMessage')
  docker rm -f "$ctr" >/dev/null
  echo "$label|$idle|$r1|$r2|$msg"
}

echo "image|idle_mib|run1: wall_s cpu_s peak_mib anon_peak_mib cur_mib read_mib status|run2: same|last message"
for which in ${IMAGES:-old new}; do
  case $which in old) bench_image old "$OLD_IMAGE" ;; new) bench_image new "$NEW_IMAGE" ;; esac
done
