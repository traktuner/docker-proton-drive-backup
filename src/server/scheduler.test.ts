import { describe, it, expect } from 'vitest';
import { isDue, lastOccurrence, computeNextRun } from '@/server/scheduler';
import type { BackupSet } from '@/server/db';

// All assertions assume TZ=UTC (set in test/setup.ts). Fixed `now` values are
// chosen so the date math is deterministic and independent of the wall clock.

// Build a minimal BackupSet with sane defaults; override per case.
function makeSet(overrides: Partial<BackupSet> = {}): BackupSet {
  return {
    id: 'set-1',
    name: 'Test',
    sourcePaths: ['/sources/x'],
    targetPath: '/',
    targetSubfolder: 'Test',
    mode: 'add',
    schedule: 'off',
    scheduleHour: 0,
    scheduleMinute: 0,
    scheduleDow: 0,
    excludes: [],
    skipThumbnails: false,
    watch: false,
    lastRunAt: null,
    lastStatus: 'never',
    lastMessage: null,
    createdAt: 0,
    ...overrides,
  } as BackupSet;
}

// Convenience: epoch ms for a UTC instant.
function utc(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
): number {
  return Date.UTC(y, mo - 1, d, h, mi, s, 0);
}

describe('scheduler date functions (TZ=UTC)', () => {
  describe("schedule 'off'", () => {
    it('is never due and lastOccurrence is null', () => {
      const s = makeSet({ schedule: 'off' });
      const now = new Date(utc(2026, 6, 29, 12, 0));
      expect(lastOccurrence(s, now)).toBeNull();
      expect(isDue(s, now)).toBe(false);
    });

    it('computeNextRun is null', () => {
      const s = makeSet({ schedule: 'off' });
      const now = new Date(utc(2026, 6, 29, 12, 0));
      expect(computeNextRun(s, now)).toBeNull();
    });
  });

  describe('hourly', () => {
    it('lastOccurrence is the top-of-hour slot using scheduleMinute (this hour reached)', () => {
      // now = 12:45, slot minute = 15 -> 12:15 already passed this hour
      const s = makeSet({ schedule: 'hourly', scheduleMinute: 15 });
      const now = new Date(utc(2026, 6, 29, 12, 45));
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 29, 12, 15));
    });

    it('lastOccurrence falls back to previous hour when this hour\'s slot not reached', () => {
      // now = 12:05, slot minute = 30 -> 12:30 not reached -> 11:30
      const s = makeSet({ schedule: 'hourly', scheduleMinute: 30 });
      const now = new Date(utc(2026, 6, 29, 12, 5));
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 29, 11, 30));
    });

    it('is due when lastRunAt is before the most recent slot', () => {
      const s = makeSet({
        schedule: 'hourly',
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 29, 11, 30), // ran at 11:30, slot 12:00 passed
      });
      const now = new Date(utc(2026, 6, 29, 12, 10));
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 29, 12, 0));
      expect(isDue(s, now)).toBe(true);
    });

    it('is due when it has never run (lastRunAt null)', () => {
      const s = makeSet({ schedule: 'hourly', scheduleMinute: 0, lastRunAt: null });
      const now = new Date(utc(2026, 6, 29, 12, 10));
      expect(isDue(s, now)).toBe(true);
    });

    it('is not due right after a run within the current slot', () => {
      const s = makeSet({
        schedule: 'hourly',
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 29, 12, 5), // ran at 12:05, slot 12:00
      });
      const now = new Date(utc(2026, 6, 29, 12, 10));
      expect(isDue(s, now)).toBe(false);
    });

    it('computeNextRun is the next :MM slot when current slot already passed', () => {
      // now = 12:45, slot minute 15 -> 12:15 passed -> next is 13:15
      const s = makeSet({ schedule: 'hourly', scheduleMinute: 15 });
      const now = new Date(utc(2026, 6, 29, 12, 45));
      expect(computeNextRun(s, now)).toBe(utc(2026, 6, 29, 13, 15));
    });

    it('computeNextRun is this hour\'s slot when still in the future', () => {
      // now = 12:05, slot minute 30 -> 12:30 still ahead
      const s = makeSet({ schedule: 'hourly', scheduleMinute: 30 });
      const now = new Date(utc(2026, 6, 29, 12, 5));
      expect(computeNextRun(s, now)).toBe(utc(2026, 6, 29, 12, 30));
    });

    it('computeNextRun rolls to next hour when slot equals now exactly (<=)', () => {
      // now = 12:30:00, slot minute 30 -> equal -> rolls to 13:30
      const s = makeSet({ schedule: 'hourly', scheduleMinute: 30 });
      const now = new Date(utc(2026, 6, 29, 12, 30, 0));
      expect(computeNextRun(s, now)).toBe(utc(2026, 6, 29, 13, 30));
    });
  });

  describe('daily', () => {
    it("lastOccurrence is today's HH:MM when already reached", () => {
      const s = makeSet({ schedule: 'daily', scheduleHour: 9, scheduleMinute: 30 });
      const now = new Date(utc(2026, 6, 29, 12, 0)); // past 09:30 today
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 29, 9, 30));
    });

    it("lastOccurrence is yesterday's HH:MM when today's slot not yet reached", () => {
      const s = makeSet({ schedule: 'daily', scheduleHour: 18, scheduleMinute: 0 });
      const now = new Date(utc(2026, 6, 29, 9, 0)); // before 18:00 today
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 28, 18, 0));
    });

    it('is due when past HH:MM today and not run since the slot', () => {
      const s = makeSet({
        schedule: 'daily',
        scheduleHour: 9,
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 28, 9, 0), // ran yesterday's slot only
      });
      const now = new Date(utc(2026, 6, 29, 10, 0));
      expect(isDue(s, now)).toBe(true);
    });

    it("is not due once it has run today's slot", () => {
      const s = makeSet({
        schedule: 'daily',
        scheduleHour: 9,
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 29, 9, 1), // already ran today's 09:00 slot
      });
      const now = new Date(utc(2026, 6, 29, 10, 0));
      expect(isDue(s, now)).toBe(false);
    });

    it("is not due before today's slot when yesterday's slot was already run", () => {
      const s = makeSet({
        schedule: 'daily',
        scheduleHour: 18,
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 28, 18, 5), // ran yesterday's slot
      });
      const now = new Date(utc(2026, 6, 29, 9, 0)); // before today's 18:00
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 28, 18, 0));
      expect(isDue(s, now)).toBe(false);
    });

    it('computeNextRun is tomorrow when today\'s slot already passed', () => {
      const s = makeSet({ schedule: 'daily', scheduleHour: 9, scheduleMinute: 0 });
      const now = new Date(utc(2026, 6, 29, 12, 0));
      expect(computeNextRun(s, now)).toBe(utc(2026, 6, 30, 9, 0));
    });

    it('computeNextRun is today when slot still ahead', () => {
      const s = makeSet({ schedule: 'daily', scheduleHour: 18, scheduleMinute: 0 });
      const now = new Date(utc(2026, 6, 29, 9, 0));
      expect(computeNextRun(s, now)).toBe(utc(2026, 6, 29, 18, 0));
    });
  });

  describe('weekly', () => {
    // 2026-06-29 is a Monday (getDay() === 1).
    it('sanity: the chosen reference date is a Monday in UTC', () => {
      expect(new Date(utc(2026, 6, 29)).getUTCDay()).toBe(1);
    });

    it('lastOccurrence is the most recent matching weekday at HH:MM', () => {
      // weekday = Monday (1), slot 08:00. now = Mon 10:00 -> today 08:00.
      const s = makeSet({
        schedule: 'weekly',
        scheduleDow: 1,
        scheduleHour: 8,
        scheduleMinute: 0,
      });
      const now = new Date(utc(2026, 6, 29, 10, 0)); // Monday
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 29, 8, 0));
    });

    it('lastOccurrence walks back to previous matching weekday', () => {
      // weekday = Sunday (0), slot 08:00. now = Mon -> last Sunday (2026-06-28).
      const s = makeSet({
        schedule: 'weekly',
        scheduleDow: 0,
        scheduleHour: 8,
        scheduleMinute: 0,
      });
      const now = new Date(utc(2026, 6, 29, 10, 0)); // Monday
      expect(new Date(utc(2026, 6, 28)).getUTCDay()).toBe(0); // Sunday
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 28, 8, 0));
    });

    it('lastOccurrence on matching weekday before the time falls to a week earlier', () => {
      // weekday = Monday, slot 18:00, now = Mon 09:00 -> previous Monday (06-22).
      const s = makeSet({
        schedule: 'weekly',
        scheduleDow: 1,
        scheduleHour: 18,
        scheduleMinute: 0,
      });
      const now = new Date(utc(2026, 6, 29, 9, 0)); // Monday
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 22, 18, 0));
    });

    it('is due on the matching weekday at/after HH:MM when not run since', () => {
      const s = makeSet({
        schedule: 'weekly',
        scheduleDow: 1, // Monday
        scheduleHour: 8,
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 22, 8, 0), // ran last week's slot
      });
      const now = new Date(utc(2026, 6, 29, 10, 0)); // Monday after 08:00
      expect(isDue(s, now)).toBe(true);
    });

    it('is not due once this week\'s slot has run', () => {
      const s = makeSet({
        schedule: 'weekly',
        scheduleDow: 1,
        scheduleHour: 8,
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 29, 8, 1), // ran this Monday's slot
      });
      const now = new Date(utc(2026, 6, 29, 10, 0));
      expect(isDue(s, now)).toBe(false);
    });

    it('computeNextRun is the next matching weekday at HH:MM (mid-week)', () => {
      // weekday = Wednesday (3), now = Monday -> +2 days to Wed.
      const s = makeSet({
        schedule: 'weekly',
        scheduleDow: 3,
        scheduleHour: 8,
        scheduleMinute: 0,
      });
      const now = new Date(utc(2026, 6, 29, 10, 0)); // Monday
      expect(new Date(utc(2026, 7, 1)).getUTCDay()).toBe(3); // Wednesday
      expect(computeNextRun(s, now)).toBe(utc(2026, 7, 1, 8, 0));
    });

    it("computeNextRun rolls to next week when today is the day but slot passed", () => {
      // weekday = Monday, now = Mon 10:00, slot 08:00 already passed -> +7 days.
      const s = makeSet({
        schedule: 'weekly',
        scheduleDow: 1,
        scheduleHour: 8,
        scheduleMinute: 0,
      });
      const now = new Date(utc(2026, 6, 29, 10, 0)); // Monday
      expect(computeNextRun(s, now)).toBe(utc(2026, 7, 6, 8, 0));
    });

    it('computeNextRun is today when the matching weekday slot is still ahead', () => {
      // weekday = Monday, now = Mon 09:00, slot 18:00 still ahead -> today.
      const s = makeSet({
        schedule: 'weekly',
        scheduleDow: 1,
        scheduleHour: 18,
        scheduleMinute: 0,
      });
      const now = new Date(utc(2026, 6, 29, 9, 0)); // Monday
      expect(computeNextRun(s, now)).toBe(utc(2026, 6, 29, 18, 0));
    });
  });

  describe('running / paused statuses', () => {
    it("isDue is false when lastStatus is 'running' even if the slot passed", () => {
      const s = makeSet({
        schedule: 'daily',
        scheduleHour: 9,
        scheduleMinute: 0,
        lastStatus: 'running',
        lastRunAt: utc(2026, 6, 28, 9, 0),
      });
      const now = new Date(utc(2026, 6, 29, 12, 0));
      expect(isDue(s, now)).toBe(false);
    });

    it("isDue is false when lastStatus is 'paused' (must not auto-resume)", () => {
      const s = makeSet({
        schedule: 'daily',
        scheduleHour: 9,
        scheduleMinute: 0,
        lastStatus: 'paused',
        lastRunAt: utc(2026, 6, 28, 9, 0),
      });
      const now = new Date(utc(2026, 6, 29, 12, 0));
      expect(isDue(s, now)).toBe(false);
    });

    it("isDue is true for an error status that otherwise qualifies", () => {
      const s = makeSet({
        schedule: 'daily',
        scheduleHour: 9,
        scheduleMinute: 0,
        lastStatus: 'error',
        lastRunAt: utc(2026, 6, 28, 9, 0),
      });
      const now = new Date(utc(2026, 6, 29, 12, 0));
      expect(isDue(s, now)).toBe(true);
    });
  });

  describe('catch-up', () => {
    it('a daily set not run for days is due now', () => {
      const s = makeSet({
        schedule: 'daily',
        scheduleHour: 3,
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 20, 3, 0), // 9 days ago
      });
      const now = new Date(utc(2026, 6, 29, 12, 0));
      expect(lastOccurrence(s, now)).toBe(utc(2026, 6, 29, 3, 0));
      expect(isDue(s, now)).toBe(true);
    });

    it('a weekly set not run for weeks is due on its next matching weekday', () => {
      const s = makeSet({
        schedule: 'weekly',
        scheduleDow: 1, // Monday
        scheduleHour: 8,
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 1, 8, 0), // weeks ago
      });
      const now = new Date(utc(2026, 6, 29, 10, 0)); // Monday after 08:00
      expect(isDue(s, now)).toBe(true);
    });

    it('an hourly set not run for many hours is due now', () => {
      const s = makeSet({
        schedule: 'hourly',
        scheduleMinute: 0,
        lastRunAt: utc(2026, 6, 29, 5, 0), // 7+ hours ago
      });
      const now = new Date(utc(2026, 6, 29, 12, 30));
      expect(isDue(s, now)).toBe(true);
    });
  });
});
