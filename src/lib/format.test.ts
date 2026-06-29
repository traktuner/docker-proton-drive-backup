import { describe, it, expect } from 'vitest';
import { formatBytes } from '@/lib/format';

describe('formatBytes', () => {
  it('compact (default): 1 decimal below 10 with a unit, else 0', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('precise: 2 below 10, 1 below 100, else 0', () => {
    expect(formatBytes(1024, 'precise')).toBe('1.00 KB');
    expect(formatBytes(15 * 1024, 'precise')).toBe('15.0 KB');
    expect(formatBytes(150 * 1024, 'precise')).toBe('150 KB');
  });

  it('caps at the largest unit (TB)', () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.0 TB');
  });
});
