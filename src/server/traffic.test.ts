import { describe, it, expect } from 'vitest';
import {
  capEffHasNetAdmin,
  kbpsToKbit,
  buildTbfArgs,
  buildClearArgs,
  trafficStatus,
  uploadsView,
} from '@/server/traffic';

// CAP_NET_ADMIN is bit 12 → mask 0x1000.
describe('capEffHasNetAdmin — parses the /proc/self/status CapEff bitmask (issue #23)', () => {
  it('detects the NET_ADMIN bit when set', () => {
    expect(capEffHasNetAdmin('0000000000001000')).toBe(true); // exactly bit 12
    expect(capEffHasNetAdmin('00000000a80435fb')).toBe(true); // docker default + NET_ADMIN (cap_add)
    expect(capEffHasNetAdmin('000001ffffffffff')).toBe(true); // all caps
  });

  it('returns false when NET_ADMIN is absent', () => {
    expect(capEffHasNetAdmin('0000000000000000')).toBe(false); // no caps
    // Docker's DEFAULT cap set (0xa80425fb) deliberately EXCLUDES NET_ADMIN — this is
    // exactly why the speed limit needs an explicit cap_add.
    expect(capEffHasNetAdmin('00000000a80425fb')).toBe(false);
    expect(capEffHasNetAdmin('0000000000000fff')).toBe(false); // bits 0–11 only, not 12
    expect(capEffHasNetAdmin('0000000000000800')).toBe(false); // bit 11, not 12
  });

  it('is defensive against empty/garbage input', () => {
    expect(capEffHasNetAdmin('')).toBe(false);
    expect(capEffHasNetAdmin('nothex')).toBe(false);
  });
});

describe('kbpsToKbit', () => {
  it('converts KB/s to kbit/s (×8), with a floor of 1', () => {
    expect(kbpsToKbit(100)).toBe(800);
    expect(kbpsToKbit(1)).toBe(8);
    expect(kbpsToKbit(0)).toBe(1); // never emits a 0 rate
  });
});

describe('buildTbfArgs / buildClearArgs — the tc command line', () => {
  it('builds a TBF qdisc at the requested rate with a scaled burst', () => {
    const args = buildTbfArgs('eth0', 500); // 500 KB/s → 4000 kbit, burst 400 kbit
    expect(args.slice(0, 6)).toEqual(['qdisc', 'replace', 'dev', 'eth0', 'root', 'tbf']);
    expect(args).toContain('rate');
    expect(args).toContain('4000kbit');
    expect(args).toContain('burst');
    expect(args).toContain('400kbit');
    expect(args).toContain('50ms');
  });

  it('scales burst with the rate (rate/10)', () => {
    const args = buildTbfArgs('eth0', 50); // 400 kbit rate, burst = 40 kbit
    expect(args).toContain('400kbit'); // rate
    expect(args).toContain('40kbit'); // burst
  });

  it('floors the burst at 32 kbit for tiny rates', () => {
    // Below the 50 KB/s config floor (pure fn), rate/10 < 32 → burst floored to 32.
    const args = buildTbfArgs('eth0', 10); // 80 kbit rate, burst floored to 32 kbit
    expect(args).toContain('80kbit'); // rate
    expect(args).toContain('32kbit'); // burst floored
  });

  it('uses the given interface and `replace` (idempotent add/swap)', () => {
    expect(buildTbfArgs('ens3', 1000)).toContain('ens3');
    expect(buildTbfArgs('ens3', 1000)[1]).toBe('replace');
  });

  it('clear removes the root qdisc from the interface', () => {
    expect(buildClearArgs('eth0')).toEqual(['qdisc', 'del', 'dev', 'eth0', 'root']);
  });
});

describe('trafficStatus / uploadsView (capability-aware)', () => {
  it('reports NOT capable off-Linux (the test host), with a reason', () => {
    // Vitest runs on the dev host (darwin in CI-for-mac / linux without NET_ADMIN);
    // either way capable must be false and reason non-empty so the UI can explain it.
    const st = trafficStatus();
    expect(st.capable).toBe(false);
    expect(st.reason.length).toBeGreaterThan(0);
  });

  it('uploadsView merges the config with the capability flags', () => {
    const v = uploadsView();
    expect(typeof v.concurrency).toBe('number');
    expect(typeof v.limitKBps).toBe('number');
    expect(v.canShape).toBe(false); // not enforceable on the test host
    expect(typeof v.shapeReason).toBe('string');
  });
});
