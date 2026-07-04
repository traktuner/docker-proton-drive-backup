import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { getUploadConfig } from './upload-config';

/**
 * Best-effort UPLOAD bandwidth cap via Linux `tc` (a TBF qdisc on the container's
 * egress interface).
 *
 * Why tc and not something lighter: the proton-drive CLI has no `--bwlimit`, and we
 * don't own its byte stream (it does its own TLS transfer), so an app-level token
 * bucket is impossible. `tc` shapes bytes at the kernel interface regardless of the
 * binary — the only reliable, proven mechanism. Its cost is that it needs
 * CAP_NET_ADMIN, which the app's `cap_drop: ALL` hardening removes. So this is
 * strictly OPT-IN: the operator must add `cap_add: [NET_ADMIN]`. When the capability
 * (or `tc`) is absent, every function no-ops and reports WHY, so the UI can show the
 * control as unavailable instead of silently failing to limit anything.
 *
 * The qdisc shapes the WHOLE interface, so we install it only for the duration of a
 * backup run (runner applies it at the start and clears it at the end).
 */

// CAP_NET_ADMIN is capability bit 12 (include/uapi/linux/capability.h) → mask 0x1000.
const CAP_NET_ADMIN_MASK = 0x1000;

const TC_PATHS = ['/sbin/tc', '/usr/sbin/tc', '/bin/tc', '/usr/bin/tc'];
const IP_PATHS = ['/sbin/ip', '/usr/sbin/ip', '/bin/ip', '/usr/bin/ip'];

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** True if CAP_NET_ADMIN is in this process's EFFECTIVE capability set. */
export function hasNetAdmin(): boolean {
  return capEffHasNetAdmin(readCapEff());
}

/** Read the raw CapEff hex from /proc/self/status (empty string if unavailable). */
function readCapEff(): string {
  try {
    const m = fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s*([0-9a-fA-F]+)/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** Pure: does a CapEff hex string carry the NET_ADMIN bit? Exported for tests. */
export function capEffHasNetAdmin(capEffHex: string): boolean {
  if (!capEffHex) return false;
  // Bit 12 is always within the low 32 bits, so parse just the last 8 hex digits —
  // that stays inside JS's safe-integer range no matter how wide the full mask is.
  const low = parseInt(capEffHex.slice(-8), 16);
  if (!Number.isFinite(low)) return false;
  return (low & CAP_NET_ADMIN_MASK) !== 0;
}

export interface TrafficStatus {
  /** Whether an upload speed limit can actually be enforced right now. */
  capable: boolean;
  /** Human-readable reason it can't be (empty when capable) — surfaced in the UI. */
  reason: string;
}

/** Upload config plus whether a speed limit can actually be enforced (for the UI). */
export function uploadsView() {
  const st = trafficStatus();
  return { ...getUploadConfig(), canShape: st.capable, shapeReason: st.reason };
}

/** Whether tc-based shaping is available (tc present + NET_ADMIN effective). */
export function trafficStatus(): TrafficStatus {
  if (process.platform !== 'linux') return { capable: false, reason: 'Traffic shaping is only available on Linux.' };
  if (!firstExisting(TC_PATHS)) return { capable: false, reason: 'The `tc` tool (iproute2) is not available in this image.' };
  if (!hasNetAdmin())
    return {
      capable: false,
      reason: 'The container lacks the NET_ADMIN capability. Add `cap_add: [NET_ADMIN]` to enable speed limiting.',
    };
  return { capable: true, reason: '' };
}

/** KB/s → kbit/s (tc's rate unit is bits). Exported for tests. */
export function kbpsToKbit(kbps: number): number {
  return Math.max(1, Math.round(kbps * 8));
}

/** Pure: the `tc` argv that installs a TBF cap of `kbps` KB/s on `iface`. */
export function buildTbfArgs(iface: string, kbps: number): string[] {
  const rateKbit = kbpsToKbit(kbps);
  // Burst scales with the rate (with a floor) so the bucket refills smoothly at both
  // small and large caps; latency bounds the queue so it can't buffer unboundedly.
  const burstKbit = Math.max(32, Math.round(rateKbit / 10));
  // `replace` is idempotent: adds the root qdisc or swaps an existing one.
  return ['qdisc', 'replace', 'dev', iface, 'root', 'tbf', 'rate', `${rateKbit}kbit`, 'burst', `${burstKbit}kbit`, 'latency', '50ms'];
}

/** Pure: the `tc` argv that removes any root qdisc from `iface` (unlimited). */
export function buildClearArgs(iface: string): string[] {
  return ['qdisc', 'del', 'dev', iface, 'root'];
}

function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr });
    };
    try {
      const proc = spawn(bin, args);
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', (e) => {
        stderr += e.message;
        finish(-1);
      });
      proc.on('close', (c) => finish(c ?? -1));
    } catch (e) {
      stderr += e instanceof Error ? e.message : String(e);
      finish(-1);
    }
  });
}

/** Detect the egress interface (the default route's device); falls back to eth0. */
async function defaultIface(): Promise<string> {
  const ip = firstExisting(IP_PATHS);
  if (!ip) return 'eth0';
  const { code, stdout } = await run(ip, ['-o', 'route', 'show', 'default']);
  if (code !== 0) return 'eth0';
  const m = stdout.match(/\bdev\s+(\S+)/);
  return m ? m[1] : 'eth0';
}

/**
 * Apply (kbps>0) or clear (kbps<=0) the upload speed cap. Best-effort: returns
 * `{applied:false, reason}` when the NET_ADMIN capability or tc is missing (so the
 * caller can log/surface it), never throws.
 */
export async function applyUploadLimit(kbps: number): Promise<{ applied: boolean; reason: string }> {
  const st = trafficStatus();
  if (!st.capable) return { applied: false, reason: st.reason };
  const tc = firstExisting(TC_PATHS)!;
  const iface = await defaultIface();
  const args = kbps > 0 ? buildTbfArgs(iface, kbps) : buildClearArgs(iface);
  const { code, stderr } = await run(tc, args);
  if (code === 0) return { applied: true, reason: '' };
  // Clearing a non-existent qdisc exits non-zero ("No such file or directory") — fine.
  if (kbps <= 0) return { applied: true, reason: '' };
  return { applied: false, reason: stderr.trim() || `tc exited with code ${code}` };
}
