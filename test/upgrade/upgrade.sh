#!/usr/bin/env bash
# Upgrade acceptance test: an existing CLI-era installation → the SDK release.
#
#   test/upgrade/upgrade.sh                       # 0.9.0-21 → pdb:sdk
#   OLD_IMAGE=ghcr.io/…:0.6.0-6 test/upgrade/upgrade.sh
#
# What it proves, with the REAL published old image and the REAL new image:
#   A. the old release builds a realistic install: 3 sets (mirror/backup/add),
#      schedules, excludes, run history and a catalog written by ITS OWN engine;
#   B. upgrading only the image (same compose file, same /data) keeps every set,
#      schedule, exclude, run and catalog row; migrates the DB once with a
#      consistent snapshot; takes over the session (account bound automatically);
#   C. the first run after the upgrade uploads NOTHING, creates no revision and
#      deletes nothing; changing one file gives exactly ONE new revision of the
#      SAME Drive node; a due schedule runs exactly once;
#   D. rollback to the old image works AFTER the new one refreshed the token and
#      uploaded a revision, and rolling forward again is still a no-op;
#   E. killing the container in the middle of the migration (large catalog) and
#      restarting twice ends in a consistent, migrated database.
# Only the Drive backend is a fake (test/upgrade/fake: a CLI for the old image,
# an SDK runtime for the new one, sharing one remote state), so the run needs no
# Proton account. tests/live covers the real Proton session separately.
set -euo pipefail

ROOT=${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
OLD_IMAGE=${OLD_IMAGE:-ghcr.io/traktuner/docker-proton-drive-backup:0.9.0-21}
NEW_IMAGE=${NEW_IMAGE:-pdb:sdk}
PORT=${PORT:-13080}
W=${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/pdb-upgrade-XXXXXX")}
TAG=pdb-upgrade-test:current
API="http://127.0.0.1:$PORT/api"
PASS=0
FAIL=0
RESULTS=()

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { PASS=$((PASS + 1)); RESULTS+=("PASS  $*"); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); RESULTS+=("FAIL  $*"); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check() { local desc=$1; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }
eq() { [ "$1" = "$2" ] || { echo "    expected '$2', got '$1'" >&2; return 1; }; }

dc() { (cd "$W" && docker compose -p pdbupgrade -f docker-compose.yml -f compose.fake.yml "$@"); }
db() { sqlite3 -readonly "$W/data/backup.db" "$1"; }
api() { curl -sS -m 30 "$@"; }
wait_up() {
  for _ in $(seq 1 90); do api "$API/health" >/dev/null 2>&1 && return 0; sleep 1; done
  dc logs --tail 50; return 1
}
use_image() { docker tag "$1" "$TAG"; dc up -d --force-recreate >/dev/null 2>&1; wait_up; }
set_id() { api "$API/backup-sets" | jq -r --arg n "$1" '.backupSets[] | select(.name==$n) | .id'; }
run_set() { # run and wait until the set leaves 'running'
  local id; id=$(set_id "$1")
  api -X POST "$API/backup-sets/$id/run" >/dev/null
  for _ in $(seq 1 120); do
    sleep 1
    local st; st=$(api "$API/backup-sets" | jq -r --arg i "$id" '.backupSets[] | select(.id==$i) | .lastStatus')
    [ "$st" != running ] && { echo "$st"; return 0; }
  done
  echo timeout
}
ops() { # count fake-Drive operations of a kind by a client since a mark
  local who=$1 kind=$2 since=${3:-0}
  tail -n +"$((since + 1))" "$W/fake-drive/ops.log" 2>/dev/null | jq -s --arg w "$who" --arg k "$kind" '[.[] | select(.who==$w and .kind==$k)] | length'
}
mark() { wc -l <"$W/fake-drive/ops.log" 2>/dev/null || echo 0; }

# ---------------------------------------------------------------- setup ---
log "Workdir $W  (old: $OLD_IMAGE  new: $NEW_IMAGE)"
# The published image is pulled like a user would; the new one must be built locally.
docker image inspect "$OLD_IMAGE" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$OLD_IMAGE" >/dev/null
docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || { echo "build $NEW_IMAGE first (docker build -t $NEW_IMAGE .)" >&2; exit 2; }
mkdir -p "$W/data" "$W/sources" "$W/fake-drive"
# The documented compose file, unchanged except host port, name and image tag.
sed -e "s#\"3000:3000\"#\"127.0.0.1:$PORT:3000\"#" \
    -e "s#container_name: proton-drive-backup#container_name: pdbupgrade#" \
    -e "s#image: ghcr.io/traktuner/docker-proton-drive-backup:latest#image: $TAG#" \
    "$ROOT/docker-compose.yml" >"$W/docker-compose.yml"
cat >"$W/compose.fake.yml" <<EOF
services:
  proton-drive:
    volumes:
      - $ROOT/test/upgrade/fake:/fake:ro
      - ./fake-drive:/fake-drive
    environment:
      - PROTON_DRIVE_CLI=/fake/proton-drive   # read by the CLI-era image
      - PROTON_RUNTIME=/fake/runtime.mjs       # read by the SDK image
EOF

# A realistic source tree: nested photo years, documents with awkward names,
# empty files and folders, hidden files and things the excludes skip.
for y in 2021 2022 2023; do for m in 01 02 03 04 05 06; do
  d="$W/sources/photos/$y/$m"; mkdir -p "$d"
  for i in 1 2 3 4; do head -c $((2000 + RANDOM)) /dev/urandom >"$d/IMG_${y}${m}_$i.jpg"; done
done; done
echo junk >"$W/sources/photos/Thumbs.db"
mkdir -p "$W/sources/photos/tmp" && echo t >"$W/sources/photos/tmp/a.tmp"
mkdir -p "$W/sources/docs/Verträge & Rechnungen" "$W/sources/docs/empty folder"
for f in "Brief [2024].pdf" "Ümlaut ñ 日本.txt" "a b c.md" "notes.txt"; do echo "doc $f" >"$W/sources/docs/Verträge & Rechnungen/$f"; done
: >"$W/sources/docs/empty.txt"
mkdir -p "$W/sources/archive/2019"; for i in $(seq 1 20); do echo "archive $i" >"$W/sources/archive/2019/f$i.log"; done
find "$W/sources" -exec touch -d '2024-01-01 12:00' {} +

# ------------------------------------------------- A. the old installation ---
log "A. Build an installation with $OLD_IMAGE"
use_image "$OLD_IMAGE"
api -X POST "$API/auth/login" >/dev/null
for _ in $(seq 1 20); do [ "$(api "$API/auth/status" | jq -r .authenticated)" = true ] && break; sleep 1; done
check "old image signed in (CLI session file written)" test -s "$W/data/proton/auth-session.json"
api -X POST -H 'content-type: application/json' -d '{"parentPath":"/","name":"Backups"}' "$API/drive/folder" >/dev/null
mk() { api -X POST -H 'content-type: application/json' -d "$1" "$API/backup-sets" | jq -r .backupSet.id; }
mk '{"name":"Photos","sourcePaths":["/photos"],"targetPath":"/Backups","mode":"mirror","schedule":"daily","scheduleHour":2,"scheduleMinute":0,"excludes":["*.tmp","Thumbs.db"]}' >/dev/null
mk '{"name":"Docs","sourcePaths":["/docs"],"targetPath":"/Backups","mode":"backup","schedule":"hourly","scheduleMinute":15}' >/dev/null
mk '{"name":"Archive","sourcePaths":["/archive"],"targetPath":"/","mode":"add","schedule":"weekly","scheduleDow":0,"scheduleHour":4}' >/dev/null
api -X POST -H 'content-type: application/json' -d '{"concurrency":3}' "$API/settings/uploads" >/dev/null
for s in Photos Docs Archive; do check "old: first run of $s succeeds" eq "$(run_set $s)" success; done
echo "changed" >>"$W/sources/docs/notes-new.txt"
for s in Photos Docs; do check "old: delta run of $s succeeds" eq "$(run_set $s)" success; done
dc stop >/dev/null 2>&1
# Make the hourly "Docs" schedule due across the upgrade (last run 2 h ago).
sqlite3 "$W/data/backup.db" "UPDATE backup_sets SET last_run_at = $(( ($(date +%s) - 7200) * 1000 )) WHERE name='Docs'"
cp -a "$W/data" "$W/data.pre-upgrade"
SETS_BEFORE=$(db "SELECT id||'|'||name||'|'||mode||'|'||schedule||'|'||schedule_hour||'|'||schedule_minute||'|'||schedule_dow||'|'||COALESCE(excludes,'') FROM backup_sets ORDER BY id")
CAT_BEFORE=$(db "SELECT set_id||':'||COUNT(*) FROM backup_catalog GROUP BY set_id ORDER BY set_id")
RUNS_BEFORE=$(db "SELECT COUNT(*) FROM backup_runs")
REV_BEFORE=$(jq '[.nodes[] | .revisions | length] | add' "$W/fake-drive/state.json")
DOCS_RUNS_BEFORE=$(db "SELECT COUNT(*) FROM backup_runs r JOIN backup_sets s ON s.id=r.set_id WHERE s.name='Docs'")
echo "  sets=$(echo "$SETS_BEFORE" | wc -l) catalog=[$CAT_BEFORE] runs=$RUNS_BEFORE revisions=$REV_BEFORE"

# --------------------------------------------------------- B. the upgrade ---
log "B. Upgrade: same compose file, same /data, only the image changes"
M0=$(mark)
use_image "$NEW_IMAGE"
check "migration ran once" bash -c "docker logs pdbupgrade 2>&1 | grep -c 'schema migrated 0 -> 3' | grep -qx 1"
check "pre-migration snapshot is a consistent, unmigrated DB" bash -c "[ \"\$(sqlite3 -readonly '$W/data/backup.db.pre-sdk.bak' 'PRAGMA integrity_check; PRAGMA user_version;' | tr '\n' ' ')\" = 'ok 0 ' ]"
check "schema version is 3" eq "$(db 'PRAGMA user_version')" 3
check "all sets, schedules and excludes unchanged" eq "$(db "SELECT id||'|'||name||'|'||mode||'|'||schedule||'|'||schedule_hour||'|'||schedule_minute||'|'||schedule_dow||'|'||COALESCE(excludes,'') FROM backup_sets ORDER BY id")" "$SETS_BEFORE"
check "catalog rows unchanged" eq "$(db "SELECT set_id||':'||COUNT(*) FROM backup_catalog GROUP BY set_id ORDER BY set_id")" "$CAT_BEFORE"
check "run history kept" bash -c "[ $(db 'SELECT COUNT(*) FROM backup_runs') -ge $RUNS_BEFORE ]"
AUTH=$(api "$API/auth/status")
check "session taken over (no new sign-in)" eq "$(echo "$AUTH" | jq -r .authenticated)" true
check "account bound automatically on takeover" eq "$(echo "$AUTH" | jq -r .binding)" ok
check "untouched CLI session kept as auth-session.pre-sdk.json (0600)" bash -c "cmp -s '$W/data.pre-upgrade/proton/auth-session.json' '$W/data/proton/auth-session.pre-sdk.json' && [ \"\$(stat -c %a '$W/data/proton/auth-session.pre-sdk.json')\" = 600 ]"

log "C. First runs after the upgrade"
# The scheduler's first tick is 10 s after boot; the due "Docs" slot must run once.
for _ in $(seq 1 45); do
  [ "$(db "SELECT COUNT(*) FROM backup_runs r JOIN backup_sets s ON s.id=r.set_id WHERE s.name='Docs'")" -gt "$DOCS_RUNS_BEFORE" ] && break; sleep 1
done
for s in Photos Archive; do check "new: run of $s succeeds" eq "$(run_set $s)" success; done
check "zero uploads after upgrade" eq "$(( $(ops sdk uploadNew "$M0") + $(ops sdk uploadRevision "$M0") ))" 0
check "zero deletions after upgrade" eq "$(ops sdk trash "$M0")" 0
check "zero folders created after upgrade" eq "$(ops sdk createFolder "$M0")" 0
check "no new Drive revisions at all" eq "$(jq '[.nodes[] | .revisions | length] | add' "$W/fake-drive/state.json")" "$REV_BEFORE"
check "the due hourly schedule ran (once so far)" eq "$(db "SELECT COUNT(*) FROM backup_runs r JOIN backup_sets s ON s.id=r.set_id WHERE s.name='Docs'")" $((DOCS_RUNS_BEFORE + 1))
echo "  waiting 70 s for the next scheduler tick…"; sleep 70
check "…and did not run a second time" eq "$(db "SELECT COUNT(*) FROM backup_runs r JOIN backup_sets s ON s.id=r.set_id WHERE s.name='Docs'")" $((DOCS_RUNS_BEFORE + 1))

TARGET="$W/sources/photos/2022/03/IMG_202203_2.jpg"
UID_BEFORE=$(jq -r '.nodes as $n | [$n[] | select(.name=="IMG_202203_2.jpg" and (.trashed|not))][0].uid' "$W/fake-drive/state.json")
head -c 77 /dev/urandom >>"$TARGET"
M1=$(mark)
check "new: run after changing ONE file succeeds" eq "$(run_set Photos)" success
check "exactly one new revision" eq "$(ops sdk uploadRevision "$M1")" 1
check "…of the same Drive node" eq "$(tail -n +"$((M1 + 1))" "$W/fake-drive/ops.log" | jq -r 'select(.kind=="uploadRevision") | .uid')" "$UID_BEFORE"
check "…and no new file, no deletion" eq "$(( $(ops sdk uploadNew "$M1") + $(ops sdk trash "$M1") ))" 0
check "session token was refreshed by the new image" bash -c "jq -e '.session.accessToken != \"at-0\" and .cachePassword == \"cp\"' '$W/data/proton/auth-session.json' >/dev/null"
check "session file stays private (0600)" eq "$(stat -c %a "$W/data/proton/auth-session.json")" 600

# --------------------------------------------------------- D. rollback ---
log "D. Roll back to $OLD_IMAGE after a token refresh and an SDK upload"
dc stop >/dev/null 2>&1
M2=$(mark)
use_image "$OLD_IMAGE"
check "old image accepts the refreshed session" eq "$(api "$API/auth/status?force=1" | jq -r .authenticated)" true
for s in Photos Docs Archive; do check "old: run of $s after rollback succeeds" eq "$(run_set $s)" success; done
check "old image re-uploads nothing after rollback" eq "$(( $(ops cli uploadNew "$M2") + $(ops cli uploadRevision "$M2") + $(ops cli trash "$M2") ))" 0
dc stop >/dev/null 2>&1
M3=$(mark)
use_image "$NEW_IMAGE"
for s in Photos Docs Archive; do check "new: run of $s after rolling forward succeeds" eq "$(run_set $s)" success; done
check "rolling forward again uploads nothing" eq "$(( $(ops sdk uploadNew "$M3") + $(ops sdk uploadRevision "$M3") + $(ops sdk trash "$M3") ))" 0
dc down >/dev/null 2>&1

# ------------------------------------------- E. interrupted migration ---
log "E. Kill the container during the migration of a 1M-row catalog, restart twice"
rm -rf "$W/data" && cp -a "$W/data.pre-upgrade" "$W/data"
PH=$(db "SELECT id FROM backup_sets WHERE name='Photos'")
sqlite3 "$W/data/backup.db" "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 1000000)
  INSERT INTO backup_catalog (set_id, rel, kind, size, mtime_ms, sha1, seen_at) SELECT '$PH', 'Photos/bulk/' || (i/1000) || '/f' || i, 'file', i, 1700000000000, NULL, 1 FROM c;"
ROWS=$(db "SELECT COUNT(*) FROM backup_catalog")
docker tag "$NEW_IMAGE" "$TAG"
for delay in 1.0 2.0; do
  dc up -d --force-recreate >/dev/null 2>&1; sleep "$delay"; docker kill -s KILL pdbupgrade >/dev/null 2>&1 || true
  echo "  killed after ${delay}s: user_version=$(db 'PRAGMA user_version') snapshot=$(ls "$W/data" | grep -c 'pre-sdk.bak$' || true) tmp=$(ls "$W/data" | grep -c 'pre-sdk.bak.tmp' || true)"
done
dc up -d >/dev/null 2>&1; wait_up
check "after two kills and a restart the DB is migrated" eq "$(db 'PRAGMA user_version')" 3
check "integrity_check ok" eq "$(db 'PRAGMA integrity_check')" ok
check "no catalog row lost" eq "$(db 'SELECT COUNT(*) FROM backup_catalog')" "$ROWS"
check "snapshot complete (no half-written temp file left)" bash -c "[ -s '$W/data/backup.db.pre-sdk.bak' ] && ! ls '$W/data' | grep -q 'pre-sdk.bak.tmp' && [ \"\$(sqlite3 -readonly '$W/data/backup.db.pre-sdk.bak' 'PRAGMA integrity_check')\" = ok ]"
dc down >/dev/null 2>&1

log "Summary ($OLD_IMAGE → $NEW_IMAGE)"
printf '%s\n' "${RESULTS[@]}"
echo "passed=$PASS failed=$FAIL workdir=$W"
[ "$FAIL" -eq 0 ]
