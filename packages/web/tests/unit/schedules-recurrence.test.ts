/**
 * Codex review Phase 5, item 1 (RB-QA-016 / RB-QA-017): `computeNextRun()` had two live bugs.
 *
 * A one-time schedule's `once` branch returned its `startAt` unconditionally instead of only when
 * `startAt` is strictly after `from` — so after `runOnce()` writes that same past timestamp back via
 * `await setNextRun()`, `await listDueSchedules()` keeps selecting it and the scheduler's 30s tick can fire it
 * again indefinitely.
 *
 * The monthly branch computed the target month by calling `addMonths()` on a Date that still carried
 * the *original* day-of-month, then clamped afterward — so a schedule starting January 31st asked
 * JS's `Date` for "January 31st plus one month", which rolls over to March 2nd/3rd (February has no
 * 31st), and the day was clamped against *that* rolled-over month instead of the intended February.
 * A monthly schedule anchored near month-end could silently skip the short month entirely.
 *
 * `computeNextRun()` reads every date through *local* getters (`getFullYear`/`getMonth`/`getDate`/
 * `getHours`), never UTC ones — so these tests construct and assert dates the same way (local
 * component constructors, local getters) rather than through UTC instants, to stay deterministic
 * regardless of the host machine's timezone.
 */
import { describe, expect, it } from 'vitest';
import { computeNextRun, type Schedule } from '@/lib/db/schedules';

type RecurrenceInput = Pick<
  Schedule,
  'recurrenceType' | 'interval' | 'daysOfWeek' | 'dayOfMonth' | 'startAt' | 'endType' | 'endDate'
>;

function local(year: number, month: number, day: number, hour = 9, minute = 0): Date {
  return new Date(year, month, day, hour, minute, 0, 0);
}

function base(overrides: Partial<RecurrenceInput>): RecurrenceInput {
  return {
    recurrenceType: 'once',
    interval: 1,
    daysOfWeek: null,
    dayOfMonth: null,
    startAt: local(2026, 0, 1).toISOString(),
    endType: 'never',
    endDate: null,
    ...overrides,
  };
}

describe('computeNextRun · once', () => {
  it('returns the start time when it has not happened yet', async () => {
    const start = local(2026, 5, 1);
    const s = base({ recurrenceType: 'once', startAt: start.toISOString() });
    const next = computeNextRun(s, local(2026, 4, 1));
    expect(next?.getTime()).toBe(start.getTime());
  });

  it('returns null once the one-off has already fired, so it cannot run again', async () => {
    const start = local(2026, 0, 1);
    const s = base({ recurrenceType: 'once', startAt: start.toISOString() });
    // `runOnce()` calls computeNextRun(schedule, new Date()) *after* the run — `from` is now after start.
    const next = computeNextRun(s, new Date(start.getTime() + 1000));
    expect(next).toBeNull();
  });

  it('returns null evaluated exactly at the start instant (not strictly after)', async () => {
    const start = local(2026, 0, 1);
    const s = base({ recurrenceType: 'once', startAt: start.toISOString() });
    const next = computeNextRun(s, start);
    expect(next).toBeNull();
  });
});

describe('computeNextRun · monthly, short-month clamping', () => {
  it('does not skip February for a schedule anchored on the 31st', async () => {
    const start = local(2026, 0, 31);
    const s = base({ recurrenceType: 'monthly', interval: 1, dayOfMonth: 31, startAt: start.toISOString() });
    const next = computeNextRun(s, local(2026, 0, 31, 10));
    // 2026 is not a leap year — February's last day is the 28th.
    expect(next?.getMonth()).toBe(1); // February
    expect(next?.getDate()).toBe(28);
  });

  it('clamps to the 29th in a leap-year February', async () => {
    const start = local(2027, 11, 31);
    const s = base({ recurrenceType: 'monthly', interval: 1, dayOfMonth: 31, startAt: start.toISOString() });
    const next = computeNextRun(s, local(2028, 0, 31, 10));
    expect(next?.getFullYear()).toBe(2028);
    expect(next?.getMonth()).toBe(1); // February
    expect(next?.getDate()).toBe(29);
  });

  it('walks every month from a 31st-anchored schedule without ever throwing the month backward', async () => {
    const start = local(2026, 0, 31);
    const s = base({ recurrenceType: 'monthly', interval: 1, dayOfMonth: 31, startAt: start.toISOString() });
    let from = local(2026, 0, 1);
    const monthsSeen: number[] = [];
    for (let i = 0; i < 14; i++) {
      const next = computeNextRun(s, from);
      expect(next).not.toBeNull();
      monthsSeen.push(next!.getFullYear() * 12 + next!.getMonth());
      from = next!;
    }
    // Every consecutive pair must be exactly one calendar month apart — no skipped month.
    for (let i = 1; i < monthsSeen.length; i++) {
      expect(monthsSeen[i] - monthsSeen[i - 1]).toBe(1);
    }
  });

  it('clamps a 30th-anchored schedule for 30-day months without skipping', async () => {
    const start = local(2026, 0, 30);
    const s = base({ recurrenceType: 'monthly', interval: 1, dayOfMonth: 30, startAt: start.toISOString() });
    // Jan 30 -> Feb (clamped to 28) -> should still land in Feb, not skip to March.
    const next = computeNextRun(s, local(2026, 0, 30, 10));
    expect(next?.getMonth()).toBe(1);
    expect(next?.getDate()).toBe(28);
  });
});
