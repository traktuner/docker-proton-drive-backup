#!/usr/bin/env bash
# Real-workload benchmark against Proton Drive (dedicated TEST account), one image
# at a time, identical data and settings:
#
#   SESSION_IN=…/auth-session.json test/bench/live-bench.sh <label> <image> <cli|sdk|pr89>
#
# Scenarios (each on the same container, in this order):
#   small     first backup of many small files (DATASET/small, default 2000 × 4–64 KiB)
#   unchanged follow-up run without changes
#   delta     20 files changed
#   mirror    50 files deleted locally → mirror run (moves them to the Drive trash)
#   verify    verify against Drive (CLI/PR89: their Verify; SDK: Verify)
#   large     first backup of one large file (DATASET/large, default 256 MiB)
# Per scenario: wall time, container CPU time, peak memory (incl. page cache),
# peak anonymous memory, bytes read via read() by all processes, bytes sent on the
# network, and Proton API requests where the image can count them (SDK release).
# The refreshed session is written to SESSION_OUT so the next image starts from the
# current tokens (refresh tokens are single-use). Settings: 3 parallel uploads,
# thumbnails off (the data has no images), 2 CPUs / 2 GiB, no network shaping.
set -euo pipefail
ROOT=${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
. "$ROOT/test/bench/lib.sh"
LABEL=$1 IMAGE=$2 KIND=$3
DATASET=${DATASET:-/tmp/pdb-bench-data}
SMALL_N=${SMALL_N:-2000}
LARGE_MIB=${LARGE_MIB:-256}
PORT=${PORT:-13130}
W=$(mktemp -d "${TMPDIR:-/tmp}/pdb-live-bench-XXXXXX")
API="http://127.0.0.1:$PORT/api"
CTR=pdbbench
TS=$(date +%Y%m%d-%H%M%S)

if [ ! -f "$DATASET/.ready-$SMALL_N-$LARGE_MIB" ]; then
  rm -rf "$DATASET"; mkdir -p "$DATASET/small" "$DATASET/large"
  for i in $(seq 1 "$SMALL_N"); do d="$DATASET/small/d$((i % 40))"; mkdir -p "$d"; head -c $((4096 + (i * 7919) % 61440)) /dev/urandom >"$d/f$i.bin"; done
  head -c $((LARGE_MIB * 1048576)) /dev/urandom >"$DATASET/large/big.bin"
  touch "$DATASET/.ready-$SMALL_N-$LARGE_MIB"
fi
cp -a "$DATASET/small" "$W/small"   # the delta/mirror scenarios modify this copy
mkdir -p "$W/data/proton"

case $KIND in
  cli | sdk) cp "$SESSION_IN" "$W/data/proton/auth-session.json" ;;
  pr89) mkdir -p "$W/keys" "$W/data/proton-sdk"; chmod 700 "$W/keys" ;;
esac
EXTRA=()
[ "$KIND" = pr89 ] && EXTRA=(-v "$W/keys:/keys")
docker rm -f "$CTR" >/dev/null 2>&1 || true
docker run -d --name "$CTR" --cpus 2 --memory 2g -p "127.0.0.1:$PORT:3000" \
  -v "$W/data:/data" -v "$W/small:/sources/small:ro" -v "$DATASET/large:/sources/large:ro" "${EXTRA[@]}" "$IMAGE" >/dev/null
if [ "$KIND" = pr89 ]; then
  # PR #89 keeps its session in `pass` (GPG). Import the same session there.
  docker exec "$CTR" sh -ec 'gpg --batch --pinentry-mode loopback --passphrase "" --quick-generate-key "bench" future-default default 0 >/dev/null 2>&1; pass init bench >/dev/null'
  docker exec -i "$CTR" pass insert -m -f ch.proton.drive/drive-sdk-cli/auth-session <"$SESSION_IN" >/dev/null
  docker restart "$CTR" >/dev/null
fi
for _ in $(seq 1 90); do curl -fsS "$API/health" >/dev/null 2>&1 && break; sleep 1; done
AUTHED=$(curl -fsS "$API/auth/status?force=1" | jq -r .authenticated)
[ "$AUTHED" = true ] || { echo "$LABEL: not signed in with the provided session"; docker logs "$CTR" | tail -20; exit 1; }
curl -s -X POST -H 'content-type: application/json' -d '{}' "$API/auth/confirm" >/dev/null || true
curl -s -X POST -H 'content-type: application/json' -d '{"concurrency":3}' "$API/settings/uploads" >/dev/null
curl -fsS -X POST -H 'content-type: application/json' -d "{\"parentPath\":\"/\",\"name\":\"pdb-bench-$LABEL-$TS\"}" "$API/drive/folder" >/dev/null
mk() { curl -fsS -X POST -H 'content-type: application/json' -d "$1" "$API/backup-sets" | jq -r .backupSet.id; }
SMALL=$(mk "{\"name\":\"small\",\"sourcePaths\":[\"/small\"],\"targetPath\":\"/pdb-bench-$LABEL-$TS\",\"mode\":\"mirror\",\"skipThumbnails\":true}")
LARGE=$(mk "{\"name\":\"large\",\"sourcePaths\":[\"/large\"],\"targetPath\":\"/pdb-bench-$LABEL-$TS\",\"mode\":\"backup\",\"skipThumbnails\":true}")
tx() { docker exec "$CTR" cat /proc/net/dev | awk '/eth0|ens|enp/ {print $10; exit}'; }
reqs() { curl -fsS "$API/diagnostics" 2>/dev/null | jq -r '.requests.total // "n/a"' 2>/dev/null || echo n/a; }
measure() { # <scenario> <set-id>
  local t0 r0 m
  t0=$(tx); r0=$(reqs)
  m=$(run_and_measure "$CTR" "$API" "$2")
  local r1; r1=$(reqs)
  local rq=n/a; [ "$r0" != n/a ] && [ "$r1" != n/a ] && rq=$((r1 - r0))
  echo "$LABEL|$1|$m|$(mib $(( $(tx) - t0 )))|$rq|$(curl -fsS "$API/backup-sets" | jq -r --arg i "$2" '.backupSets[] | select(.id==$i) | .lastMessage' | cut -c1-90)"
}
echo "image|scenario|wall_s cpu_s peak_mib anon_peak_mib cur_mib read_mib status|net_tx_mib|requests|message"
measure small "$SMALL"
measure unchanged "$SMALL"
for i in $(seq 1 20); do f=$(find "$W/small" -name "f$((i * 37)).bin" | head -1); [ -n "$f" ] && head -c 5000 /dev/urandom >>"$f"; done
measure delta "$SMALL"
find "$W/small" -name 'f*.bin' | sort | head -50 | xargs rm -f
measure mirror "$SMALL"
c0=$(cpu_us "$CTR"); t0=$(date +%s.%N); r0=$(reqs)
V=$(curl -sS -m 1800 -X POST "$API/backup-sets/$SMALL/verify" | jq -c '{checked, repaired, message}')
echo "$LABEL|verify|$(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN{printf "%.2f", b-a}') $(secs $(( $(cpu_us "$CTR") - c0 ))) - - - - -|-|$( [ "$r0" != n/a ] && echo $(( $(reqs) - r0 )) || echo n/a)|$V"
measure large "$LARGE"
echo "$LABEL|idle-after|anon $(mib "$(anon "$CTR")") MiB, current $(mib "$(mem_cur "$CTR")") MiB"
curl -fsS "$API/diagnostics" 2>/dev/null | jq -c '.requests.byEndpoint' >"$W/requests.json" 2>/dev/null || true
# Hand the (possibly refreshed) session to the next image.
case $KIND in
  cli | sdk) cp "$W/data/proton/auth-session.json" "${SESSION_OUT:-$SESSION_IN}" ;;
  pr89) docker exec "$CTR" pass show ch.proton.drive/drive-sdk-cli/auth-session >"${SESSION_OUT:-$SESSION_IN}" ;;
esac
curl -fsS -X POST -H 'content-type: application/json' -d "{\"path\":\"/pdb-bench-$LABEL-$TS\"}" "$API/drive/trash" >/dev/null 2>&1 || echo "$LABEL: trash the Drive folder pdb-bench-$LABEL-$TS manually"
docker rm -f "$CTR" >/dev/null
echo "$LABEL|workdir|$W"
