#!/usr/bin/env bash
# Live round trip against REAL Proton Drive, with a DEDICATED test account.
#
#   test/live/live.sh                 # uses ./data of WORK (default: a temp dir)
#   KEEP=1 test/live/live.sh          # keep the Drive test folder afterwards
#
# Steps (each asserted):
#   1. start the SDK image; if not signed in, print the sign-in link and wait
#      (open it in a browser, sign in with the TEST account);
#   2. create a test folder "pdb-live-<timestamp>" and a Backup set into it;
#   3. back up 3 files (binary, text, empty) → 3 uploaded;
#   4. change one file → exactly 1 uploaded, as a new revision of the same node;
#   5. download BOTH revisions and compare SHA-256 with the local versions;
#   6. restart the container → run again → 0 uploaded, 0 new revisions;
#   7. move the test folder to the Drive trash (unless KEEP=1).
# Nothing outside the test folder is touched.
set -euo pipefail
ROOT=${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
IMAGE=${IMAGE:-pdb:sdk}
PORT=${PORT:-13100}
W=${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/pdb-live-XXXXXX")}
API="http://127.0.0.1:$PORT/api"
CTR=pdblive
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
eq() { [ "$1" = "$2" ] || { echo "    expected '$2', got '$1'" >&2; return 1; }; }
api() { curl -sS -m 120 "$@"; }
start() {
  docker rm -f "$CTR" >/dev/null 2>&1 || true
  docker run -d --name "$CTR" -p "127.0.0.1:$PORT:3000" -e PDB_ENABLE_DOWNLOAD=1 \
    -v "$W/data:/data" -v "$W/sources:/sources:ro" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do api "$API/health" >/dev/null 2>&1 && return 0; sleep 1; done
  docker logs "$CTR" | tail -20; return 1
}
run_set() {
  api -X POST "$API/backup-sets/$1/run" >/dev/null
  for _ in $(seq 1 1200); do
    sleep 1
    local st; st=$(api "$API/backup-sets" | jq -r --arg i "$1" '.backupSets[] | select(.id==$i) | .lastStatus')
    [ "$st" != running ] && { echo "$st"; return; }
  done
  echo timeout
}
msg() { api "$API/backup-sets" | jq -r --arg i "$1" '.backupSets[] | select(.id==$i) | .lastMessage'; }

mkdir -p "$W/data" "$W/sources/live"
start
if [ "$(api "$API/auth/status?force=1" | jq -r .authenticated)" != true ]; then
  URL=$(api -X POST "$API/auth/login" | jq -r .signInUrl)
  echo; echo "Sign in with the TEST account (link valid ~10 min):"; echo "  $URL"; echo
  for _ in $(seq 1 600); do [ "$(api "$API/auth/status" | jq -r .authenticated)" = true ] && break; sleep 1; done
fi
check "signed in" eq "$(api "$API/auth/status?force=1" | jq -r .authenticated)" true
ACC=$(api "$API/auth/status")
echo "  account: $(echo "$ACC" | jq -r .account.email)  binding: $(echo "$ACC" | jq -r .binding)"
[ "$(echo "$ACC" | jq -r .binding)" = confirm ] && api -X POST -H 'content-type: application/json' -d '{}' "$API/auth/confirm" >/dev/null

TS=$(date +%Y%m%d-%H%M%S)
FOLDER="pdb-live-$TS"
check "test folder created" bash -c "curl -fsS -X POST -H 'content-type: application/json' -d '{\"parentPath\":\"/\",\"name\":\"$FOLDER\"}' '$API/drive/folder' >/dev/null"
head -c 3145728 /dev/urandom >"$W/sources/live/blob.bin"     # 3 MiB, spans blocks
printf 'hello proton %s\n' "$TS" >"$W/sources/live/note.txt"
: >"$W/sources/live/empty.txt"
SHA_V1=$(sha256sum "$W/sources/live/blob.bin" | cut -d' ' -f1)
SET=$(api -X POST -H 'content-type: application/json' \
  -d "{\"name\":\"live-$TS\",\"sourcePaths\":[\"/live\"],\"targetPath\":\"/$FOLDER\",\"mode\":\"backup\",\"skipThumbnails\":true}" \
  "$API/backup-sets" | jq -r .backupSet.id)
SUB=$(api "$API/backup-sets" | jq -r --arg i "$SET" '.backupSets[] | select(.id==$i) | .targetSubfolder')
REMOTE="/$FOLDER/$SUB/live/blob.bin"

check "first run succeeds" eq "$(run_set "$SET")" success
check "3 files uploaded" bash -c "[[ \"$(msg "$SET")\" == '3 uploaded'* ]]"
REV1=$(api "$API/drive/revisions?path=$(jq -rn --arg p "$REMOTE" '$p|@uri')")
NODE=$(echo "$REV1" | jq -r .node.uid)

head -c 2097152 /dev/urandom >"$W/sources/live/blob.bin"
touch -d '+5 seconds' "$W/sources/live/blob.bin"
SHA_V2=$(sha256sum "$W/sources/live/blob.bin" | cut -d' ' -f1)
check "second run succeeds" eq "$(run_set "$SET")" success
check "exactly 1 file uploaded" bash -c "[[ \"$(msg "$SET")\" == '1 uploaded'* ]]"
REVS=$(api "$API/drive/revisions?path=$(jq -rn --arg p "$REMOTE" '$p|@uri')")
check "same Drive node" eq "$(echo "$REVS" | jq -r .node.uid)" "$NODE"
check "two revisions" eq "$(echo "$REVS" | jq '.revisions | length')" 2
for i in 0 1; do
  RID=$(echo "$REVS" | jq -r ".revisions[$i].uid")
  GOT=$(api "$API/drive/download?revision=$(jq -rn --arg p "$RID" '$p|@uri')" | sha256sum | cut -d' ' -f1)
  WANT=$([ $i = 0 ] && echo "$SHA_V2" || echo "$SHA_V1")
  check "revision $((2 - i)) restores byte-identical (SHA-256)" eq "$GOT" "$WANT"
done

start
check "run after restart succeeds" eq "$(run_set "$SET")" success
check "nothing uploaded after restart" bash -c "[[ \"$(msg "$SET")\" == '0 uploaded'* ]]"
check "still two revisions" eq "$(api "$API/drive/revisions?path=$(jq -rn --arg p "$REMOTE" '$p|@uri')" | jq '.revisions | length')" 2

if [ "${KEEP:-0}" != 1 ]; then
  api -X DELETE "$API/backup-sets/$SET" >/dev/null
  check "test folder moved to Drive trash" bash -c "curl -fsS -X POST -H 'content-type: application/json' -d '{\"path\":\"/$FOLDER\"}' '$API/drive/trash' >/dev/null"
fi
docker rm -f "$CTR" >/dev/null
echo "passed=$PASS failed=$FAIL workdir=$W"
[ "$FAIL" -eq 0 ]
