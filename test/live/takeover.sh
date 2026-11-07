#!/usr/bin/env bash
# The upgrade path against REAL Proton (dedicated TEST account):
#
#   1. the published CLI image signs in (prints a link: sign in with the TEST
#      account in a browser) and backs up a small tree with ITS engine;
#   2. only the image changes to the SDK release, same /data:
#      - is the CLI session accepted under the app's own x-pm-appversion?
#      - the first run uploads nothing, a changed file becomes ONE revision;
#   3. rollback to the CLI image after the SDK release refreshed/used the session:
#      the CLI must still be signed in and upload nothing.
# Results are printed; a rejected session is reported (then the user signs in
# once in the new UI — the jobs are untouched either way).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OLD_IMAGE=${OLD_IMAGE:-ghcr.io/traktuner/docker-proton-drive-backup:0.9.0-21}
NEW_IMAGE=${NEW_IMAGE:-pdb:sdk}
PORT=${PORT:-13110}
W=${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/pdb-takeover-XXXXXX")}
API="http://127.0.0.1:$PORT/api"
CTR=pdbtakeover
api() { curl -sS -m 120 "$@"; }
start() {
  docker rm -f "$CTR" >/dev/null 2>&1 || true
  docker run -d --name "$CTR" -p "127.0.0.1:$PORT:3000" -e PDB_ENABLE_DOWNLOAD=1 -v "$W/data:/data" -v "$W/sources:/sources:ro" "$1" >/dev/null
  for _ in $(seq 1 60); do api "$API/health" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
run_set() {
  api -X POST "$API/backup-sets/$1/run" >/dev/null
  for _ in $(seq 1 1200); do
    sleep 1
    local st; st=$(api "$API/backup-sets" | jq -r --arg i "$1" '.backupSets[] | select(.id==$i) | .lastStatus')
    [ "$st" != running ] && { api "$API/backup-sets" | jq -r --arg i "$1" '.backupSets[] | select(.id==$i) | "\(.lastStatus): \(.lastMessage)"'; return; }
  done
}
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

mkdir -p "$W/data" "$W/sources/tree/sub"
for i in $(seq 1 12); do head -c $((4096 * i)) /dev/urandom >"$W/sources/tree/f$i.bin"; done
for i in 1 2 3; do echo "doc $i" >"$W/sources/tree/sub/d$i.txt"; done

say "1. CLI release: sign in and back up"
start "$OLD_IMAGE"
if [ "$(api "$API/auth/status?force=1" | jq -r .authenticated)" != true ]; then
  api -X POST "$API/auth/login" >/dev/null; sleep 2
  echo "Sign in with the TEST account (link valid ~10 min):"; echo "  $(api "$API/auth/status" | jq -r .signInUrl)"
  for _ in $(seq 1 600); do [ "$(api "$API/auth/status" | jq -r .authenticated)" = true ] && break; sleep 1; done
fi
echo "CLI signed in: $(api "$API/auth/status?force=1" | jq -r .authenticated)"
TS=$(date +%Y%m%d-%H%M%S)
api -X POST -H 'content-type: application/json' -d "{\"parentPath\":\"/\",\"name\":\"pdb-takeover-$TS\"}" "$API/drive/folder" >/dev/null
SET=$(api -X POST -H 'content-type: application/json' -d "{\"name\":\"takeover-$TS\",\"sourcePaths\":[\"/tree\"],\"targetPath\":\"/pdb-takeover-$TS\",\"mode\":\"mirror\",\"skipThumbnails\":true}" "$API/backup-sets" | jq -r .backupSet.id)
echo "CLI run 1: $(run_set "$SET")"
echo "CLI run 2: $(run_set "$SET")"
docker stop "$CTR" >/dev/null
cp -a "$W/data/proton/auth-session.json" "$W/session.cli.json"

say "2. SDK release on the same /data"
start "$NEW_IMAGE"
AUTH=$(api "$API/auth/status?force=1")
echo "SDK status: $(echo "$AUTH" | jq -c '{authenticated, binding, account: .account.email}')"
if [ "$(echo "$AUTH" | jq -r .authenticated)" = true ]; then
  echo "SDK run (unchanged): $(run_set "$SET")"
  head -c 9999 /dev/urandom >"$W/sources/tree/f3.bin"
  echo "SDK run (1 changed): $(run_set "$SET")"
  REMOTE="/pdb-takeover-$TS/$(api "$API/backup-sets" | jq -r --arg i "$SET" '.backupSets[] | select(.id==$i) | .targetSubfolder')/tree/f3.bin"
  echo "revisions of f3.bin: $(api "$API/drive/revisions?path=$(jq -rn --arg p "$REMOTE" '$p|@uri')" | jq '.revisions | length')"
  cmp -s "$W/session.cli.json" "$W/data/proton/auth-session.json" && echo "session file unchanged" || echo "session file updated by the SDK release (token refresh)"
  docker stop "$CTR" >/dev/null

  say "3. Roll back to the CLI release"
  start "$OLD_IMAGE"
  echo "CLI signed in after rollback: $(api "$API/auth/status?force=1" | jq -r .authenticated)"
  echo "CLI run after rollback: $(run_set "$SET")"
else
  echo "The CLI session was NOT accepted by the SDK release (see docker logs $CTR):"
  docker logs "$CTR" 2>&1 | grep -i proton | tail -5
fi
docker rm -f "$CTR" >/dev/null
echo "workdir=$W (Drive folder pdb-takeover-$TS left for inspection; trash it when done)"
