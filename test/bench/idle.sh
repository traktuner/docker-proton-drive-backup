#!/usr/bin/env bash
# Idle cost of the WHOLE container with 0, 1 and 3 browser tabs open.
# A "tab" replays what the UI does while idle: on load /api/version,
# /api/backup-sets, /api/auth/status, /api/quota; then every 60 s a forced
# /api/auth/status?force=1 (AuthProvider) and /api/quota (StorageBar).
#
#   test/bench/idle.sh <image> [label]     env: SESSION (auth-session.json to use →
#                                          signed-in idle), PHASE_S (default 180)
# Prints: label | tabs | cpu_s per phase | mem_avg_mib | mem_max_mib | anon_avg_mib
set -euo pipefail
ROOT=${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
. "$ROOT/test/bench/lib.sh"
IMAGE=$1
LABEL=${2:-$1}
PHASE=${PHASE_S:-180}
PORT=${PORT:-13120}
W=$(mktemp -d "${TMPDIR:-/tmp}/pdb-idle-XXXXXX")
CTR=pdbidle
mkdir -p "$W/data/proton" "$W/sources"
[ -n "${SESSION:-}" ] && cp "$SESSION" "$W/data/proton/auth-session.json"
docker rm -f "$CTR" >/dev/null 2>&1 || true
docker run -d --name "$CTR" --cpus 2 --memory 2g -p "127.0.0.1:$PORT:3000" -v "$W/data:/data" -v "$W/sources:/sources:ro" ${EXTRA_ARGS:-} "$IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
sleep 20
tab() {
  local b="http://127.0.0.1:$PORT/api"
  curl -s "$b/version" "$b/backup-sets" "$b/auth/status" "$b/quota" >/dev/null
  while true; do sleep 60; curl -s "$b/auth/status?force=1" "$b/quota" >/dev/null; done
}
phase() {
  local tabs=$1 pids=() c0 c1 sum=0 max=0 asum=0 n=0 v a
  for _ in $(seq 1 "$tabs"); do tab & pids+=($!); done
  c0=$(cpu_us "$CTR")
  for _ in $(seq 1 $((PHASE / 2))); do
    v=$(mem_cur "$CTR"); a=$(anon "$CTR")
    sum=$((sum + v)); asum=$((asum + a)); n=$((n + 1)); [ "$v" -gt "$max" ] && max=$v
    sleep 2
  done
  c1=$(cpu_us "$CTR")
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  echo "$LABEL|$tabs|$(secs $((c1 - c0)))|$(mib $((sum / n)))|$(mib $max)|$(mib $((asum / n)))"
}
echo "label|tabs|cpu_s/${PHASE}s|mem_avg_mib|mem_max_mib|anon_avg_mib"
phase 0
phase 1
phase 3
docker rm -f "$CTR" >/dev/null
