const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Human-readable byte size. `mode` preserves the two decimal rules the UI has
 * always used, so output is byte-for-byte identical to the previous per-component
 * helpers:
 *  - 'compact' (default): 1 decimal below 10 (with a unit above B), else 0.
 *  - 'precise': 2 below 10, 1 below 100, else 0.
 */
export function formatBytes(n: number, mode: 'compact' | 'precise' = 'compact'): string {
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const decimals =
    mode === 'precise' ? (v < 10 && i > 0 ? 2 : v < 100 ? 1 : 0) : v < 10 && i > 0 ? 1 : 0;
  return `${v.toFixed(decimals)} ${UNITS[i]}`;
}
