import { backupSets, type BackupSet } from './db';
import { runBackupSet } from './runner';
import { isAuthenticated } from './cli';

/**
 * Minimal in-process scheduler. Ticks once a minute and runs any backup set
 * whose schedule is due. Times use the container's local time - set the TZ env
 * var to control it (defaults to UTC). Started from src/instrumentation.ts.
 */
const g = globalThis as unknown as { __pdSchedulerStarted?: boolean };

export function startScheduler() {
  if (g.__pdSchedulerStarted) return;
  g.__pdSchedulerStarted = true;
  reconcileInterrupted(); // resume runs killed mid-flight by the previous shutdown
  setInterval(tick, 60_000);
  setTimeout(tick, 10_000); // first check shortly after boot (catches up missed runs)
  console.log('[scheduler] started (tz=%s)', process.env.TZ || 'UTC');
}

/**
 * A set still marked 'running' at boot was interrupted by a restart (its process
 * died). Flag it interrupted and clear its last run time so the occurrence check
 * sees the current scheduled slot as unattempted and re-runs it. Manual
 * (unscheduled) runs just show as interrupted; the user can re-run them.
 */
function reconcileInterrupted() {
  for (const s of backupSets.all()) {
    if (s.lastStatus === 'running') {
      console.log('[scheduler] marking interrupted backup set %s (%s)', s.name, s.id);
      backupSets.markInterrupted(s.id);
    }
  }
}

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const due = backupSets
      .all()
      .filter((s) => s.schedule !== 'off' && s.lastStatus !== 'running' && isDue(s, now));
    if (due.length === 0) return;

    if (!(await isAuthenticated())) {
      for (const s of due) {
        backupSets.updateStatus(s.id, 'error', 'Skipped: not signed in to Proton Drive', false);
      }
      return;
    }
    for (const s of due) {
      console.log('[scheduler] running backup set %s (%s)', s.name, s.id);
      await runBackupSet(s.id); // serialized via the CLI mutex anyway
    }
  } catch (e) {
    console.error('[scheduler] tick error', e);
  } finally {
    ticking = false;
  }
}

/**
 * The most recent scheduled slot at or before `now` (epoch ms), or null if none
 * has occurred yet. This is what makes catch-up robust: a set is due whenever it
 * hasn't run since its last slot, no matter how long the container was off.
 *  - hourly: the top of the current clock hour.
 *  - daily:  today at HH:MM if reached, else yesterday at HH:MM.
 *  - weekly: the most recent matching weekday at HH:MM (up to 7 days back).
 */
export function lastOccurrence(s: BackupSet, now: Date): number | null {
  if (s.schedule === 'hourly') {
    const d = new Date(now);
    d.setMinutes(s.scheduleMinute, 0, 0);
    if (d.getTime() > now.getTime()) d.setHours(d.getHours() - 1); // this hour's slot not reached yet
    return d.getTime();
  }
  if (s.schedule === 'daily') {
    const t = atTime(now, s.scheduleHour, s.scheduleMinute);
    if (t.getTime() <= now.getTime()) return t.getTime();
    t.setDate(t.getDate() - 1);
    return t.getTime();
  }
  if (s.schedule === 'weekly') {
    for (let i = 0; i <= 7; i++) {
      const t = atTime(now, s.scheduleHour, s.scheduleMinute);
      t.setDate(t.getDate() - i);
      if (t.getDay() === s.scheduleDow && t.getTime() <= now.getTime()) return t.getTime();
    }
  }
  return null;
}

/**
 * Due if the set has NOT started a run since its most recent scheduled slot.
 * Using the run-start time (not success) keeps this loop-free: a cancelled or
 * failed attempt still counts as "attempted this slot", so it won't re-fire every
 * tick - it waits for the next slot. Interrupted (zombie 'running') runs are
 * handled separately at startup via reconcileInterrupted().
 */
export function isDue(s: BackupSet, now: Date): boolean {
  if (s.schedule === 'off' || s.lastStatus === 'running') return false;
  const occ = lastOccurrence(s, now);
  if (occ == null) return false;
  return (s.lastRunAt ?? 0) < occ;
}

function atTime(now: Date, h: number, m: number): Date {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Next scheduled run time in epoch ms, or null if not scheduled. */
export function computeNextRun(s: BackupSet, now = new Date()): number | null {
  if (s.schedule === 'off') return null;
  if (s.schedule === 'hourly') {
    const d = new Date(now);
    d.setMinutes(s.scheduleMinute, 0, 0);
    if (d.getTime() <= now.getTime()) d.setHours(d.getHours() + 1); // next :MM slot
    return d.getTime();
  }
  // daily / weekly: next occurrence of hour:minute (on the right weekday).
  const d = atTime(now, s.scheduleHour, s.scheduleMinute);
  if (s.schedule === 'daily') {
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // weekly
  let delta = (s.scheduleDow - now.getDay() + 7) % 7;
  if (delta === 0 && d.getTime() <= now.getTime()) delta = 7;
  d.setDate(d.getDate() + delta);
  return d.getTime();
}
