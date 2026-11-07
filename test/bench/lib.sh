#!/usr/bin/env bash
# Shared measurement helpers for test/bench/*.sh.
#
# Every number is taken from the CONTAINER's cgroup (all processes: the Node
# server, CLI child processes of the old image, a worker of the prototype), so
# the three images are compared on the same footing:
#   cpu_s      cpu.stat usage_usec delta              (user+system CPU time)
#   peak_mib   memory.peak (fresh container per run)   (peak RSS + page cache charged)
#   cur_mib    memory.current at the end
#   read_mib   rchar of all processes, from /proc/*/io (bytes read through read())
# Wall time is measured from the API call that starts the run to the moment the
# set leaves 'running'.

cg() { docker exec "$1" cat "/sys/fs/cgroup/$2" 2>/dev/null; }
cpu_us() { cg "$1" cpu.stat | awk '/^usage_usec/ {print $2}'; }
mem_peak() { cg "$1" memory.peak; }
mem_cur() { cg "$1" memory.current; }
# Sum of read() bytes of every process alive in the container right now plus the
# exited children the kernel folded into their parents (Linux accounts exited
# children's I/O into the parent's /proc/<pid>/io on reap).
rchar() {
  docker exec "$1" sh -c 'total=0; for f in /proc/[0-9]*/io; do v=$(awk "/^rchar/ {print \$2}" "$f" 2>/dev/null); [ -n "$v" ] && total=$((total + v)); done; echo $total'
}
mib() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1048576 }'; }
secs() { awk -v u="$1" 'BEGIN { printf "%.2f", u / 1000000 }'; }

# Peak of anonymous (process) memory, sampled every 0.5 s — memory.peak also
# counts page cache (file data the kernel caches), which says little about the app.
anon() { cg "$1" memory.stat | awk '/^anon / {print $2}'; }
sample_anon() { # background: writes the running max to $2 until $3 disappears
  local ctr=$1 out=$2 flag=$3 max=0 v
  while [ -e "$flag" ]; do v=$(anon "$ctr"); [ -n "$v" ] && [ "$v" -gt "$max" ] && max=$v && echo "$max" >"$out"; sleep 0.5; done
}

# run_and_measure <container> <api-base> <set-id>
#   → "wall_s cpu_s peak_mib anon_peak_mib cur_mib read_mib status"
run_and_measure() {
  local ctr=$1 api=$2 id=$3
  local c0 r0 t0 st flag; flag=$(mktemp); echo 0 >"$flag.max"
  sample_anon "$ctr" "$flag.max" "$flag" &
  c0=$(cpu_us "$ctr"); r0=$(rchar "$ctr"); t0=$(date +%s.%N)
  curl -fsS -X POST "$api/backup-sets/$id/run" >/dev/null
  for _ in $(seq 1 36000); do
    sleep 0.25
    st=$(curl -fsS "$api/backup-sets" | jq -r --arg i "$id" '.backupSets[] | select(.id==$i) | .lastStatus')
    [ "$st" != running ] && break
  done
  local t1 c1 r1
  t1=$(date +%s.%N); c1=$(cpu_us "$ctr"); r1=$(rchar "$ctr")
  rm -f "$flag"; sleep 0.6
  printf '%s %s %s %s %s %s %s\n' \
    "$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.2f", b - a }')" \
    "$(secs $((c1 - c0)))" "$(mib "$(mem_peak "$ctr")")" "$(mib "$(cat "$flag.max")")" "$(mib "$(mem_cur "$ctr")")" "$(mib $((r1 - r0)))" "$st"
  rm -f "$flag.max"
}
