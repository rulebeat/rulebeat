import { db } from './client';
import { schedules } from './tables';
import { eq } from 'drizzle-orm';
import { many, one, run } from './exec';
import { listCategories } from './categories';
import { loadRules } from '../rules';
import { deleteLinksForSchedule } from './schedule-notification-channels';

export type ScheduleTargetType = 'all' | 'categories' | 'tags' | 'rules';
export type RecurrenceType = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly';
export type ScheduleEndType = 'never' | 'on_date';

export interface Schedule {
  id: string;
  name: string;
  targetType: ScheduleTargetType;
  targetValues: string[];
  recurrenceType: RecurrenceType;
  interval: number;
  daysOfWeek: number[] | null; // 0=Sun..6=Sat, weekly only
  dayOfMonth: number | null;   // 1-31, monthly only
  startAt: string;             // ISO datetime — anchors date, time-of-day, and interval alignment
  endType: ScheduleEndType;
  endDate: string | null;      // ISO date
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToSchedule(row: typeof schedules.$inferSelect): Schedule {
  return {
    id: row.id,
    name: row.name,
    targetType: row.targetType as ScheduleTargetType,
    targetValues: JSON.parse(row.targetValues) as string[],
    recurrenceType: row.recurrenceType as RecurrenceType,
    interval: row.interval,
    daysOfWeek: row.daysOfWeek ? JSON.parse(row.daysOfWeek) as number[] : null,
    dayOfMonth: row.dayOfMonth,
    startAt: row.startAt,
    endType: row.endType as ScheduleEndType,
    endDate: row.endDate,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await many(db.select().from(schedules));
  return rows.map(rowToSchedule);
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const row = await one(db.select().from(schedules).where(eq(schedules.id, id)));
  return row ? rowToSchedule(row) : null;
}

export async function listDueSchedules(nowIso: string): Promise<Schedule[]> {
  return (await listSchedules()).filter(s => s.enabled && s.nextRunAt !== null && s.nextRunAt <= nowIso);
}

// ── Validation ────────────────────────────────────────────────────────────────

async function validateTarget(targetType: ScheduleTargetType, targetValues: string[]): Promise<string | null> {
  if (targetType === 'all') return null;
  if (targetValues.length === 0) return 'At least one target is required.';
  if (targetType === 'categories') {
    const known = new Set((await listCategories()).map(c => c.id));
    const unknown = targetValues.find(v => !known.has(v));
    if (unknown) return `Unknown category: "${unknown}"`;
  }
  if (targetType === 'rules') {
    const known = new Set((await loadRules()).map(r => r.id));
    const unknown = targetValues.find(v => !known.has(v));
    if (unknown) return `Unknown rule: "${unknown}"`;
  }
  // 'tags' are free-form — any string is acceptable, rules simply won't match if the tag doesn't exist
  return null;
}

function validateRecurrence(data: {
  recurrenceType: RecurrenceType;
  interval: number;
  daysOfWeek: number[] | null;
  dayOfMonth: number | null;
  startAt: string;
  endType: ScheduleEndType;
  endDate: string | null;
}): string | null {
  if (!data.startAt || isNaN(new Date(data.startAt).getTime())) return 'A valid start date/time is required.';
  if (data.recurrenceType !== 'once' && (!Number.isInteger(data.interval) || data.interval < 1)) {
    return 'Interval must be a whole number of 1 or more.';
  }
  if (data.recurrenceType === 'weekly' && (!data.daysOfWeek || data.daysOfWeek.length === 0)) {
    return 'At least one day of the week is required.';
  }
  if (data.recurrenceType === 'weekly' && data.daysOfWeek?.some(d => d < 0 || d > 6)) {
    return 'Days of week must be between 0 (Sunday) and 6 (Saturday).';
  }
  if (data.recurrenceType === 'monthly' && (!data.dayOfMonth || data.dayOfMonth < 1 || data.dayOfMonth > 31)) {
    return 'Day of month must be between 1 and 31.';
  }
  if (data.endType === 'on_date') {
    if (!data.endDate || isNaN(new Date(data.endDate).getTime())) return 'A valid end date is required.';
    if (new Date(data.endDate).getTime() < new Date(data.startAt).getTime()) return 'End date must be after the start date.';
  }
  return null;
}

// ── Recurrence engine — pure date math, no cron ────────────────────────────────

function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function withTime(date: Date, h: number, m: number): Date {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/** Computes the next occurrence strictly after `from`, or null if the recurrence
 *  has no more occurrences (a one-off that already ran, or past its end date). */
export function computeNextRun(s: Pick<Schedule, 'recurrenceType' | 'interval' | 'daysOfWeek' | 'dayOfMonth' | 'startAt' | 'endType' | 'endDate'>, from: Date): Date | null {
  const start = new Date(s.startAt);
  const h = start.getHours();
  const m = start.getMinutes();

  let next: Date | null = null;

  if (s.recurrenceType === 'once') {
    next = start > from ? start : null;
  } else if (s.recurrenceType === 'hourly') {
    const intervalMs = s.interval * 3_600_000;
    const elapsed = from.getTime() - start.getTime();
    let n = Math.floor(Math.max(0, elapsed) / intervalMs);
    let candidate = new Date(start.getTime() + n * intervalMs);
    if (candidate <= from) { n++; candidate = new Date(start.getTime() + n * intervalMs); }
    next = candidate;
  } else if (s.recurrenceType === 'daily') {
    const daysSinceStart = Math.floor((stripTime(from).getTime() - stripTime(start).getTime()) / 86_400_000);
    let n = Math.floor(Math.max(0, daysSinceStart) / s.interval);
    let candidate = withTime(addDays(stripTime(start), n * s.interval), h, m);
    if (candidate <= from) { n++; candidate = withTime(addDays(stripTime(start), n * s.interval), h, m); }
    next = candidate;
  } else if (s.recurrenceType === 'weekly') {
    const days = s.daysOfWeek?.length ? s.daysOfWeek : [start.getDay()];
    const startWeekStart = stripTime(start);
    const daysSinceStart = Math.max(0, Math.floor((stripTime(from).getTime() - startWeekStart.getTime()) / 86_400_000));
    const weeksSinceStart = Math.floor(daysSinceStart / 7);
    let periodIndex = Math.max(0, Math.floor(weeksSinceStart / s.interval) - 1); // scan starts one period early, safe
    let found: Date | null = null;
    for (let guard = 0; guard < 1000 && !found; guard++, periodIndex++) {
      const windowStart = addDays(startWeekStart, periodIndex * s.interval * 7);
      for (const day of days) {
        const offset = (day - windowStart.getDay() + 7) % 7;
        const candidate = withTime(addDays(windowStart, offset), h, m);
        if (candidate > from && (!found || candidate < found)) found = candidate;
      }
    }
    next = found;
  } else if (s.recurrenceType === 'monthly') {
    const startMonthIndex = start.getFullYear() * 12 + start.getMonth();
    const monthsSinceStart = (from.getFullYear() - start.getFullYear()) * 12 + (from.getMonth() - start.getMonth());
    let n = Math.floor(Math.max(0, monthsSinceStart) / s.interval);
    const candidateAt = (idx: number) => {
      // Resolve year/month by integer arithmetic first — never call Date.setMonth() on a Date that
      // still carries a day (e.g. 31) the target month may not have, which rolls the month forward.
      const totalMonths = startMonthIndex + idx * s.interval;
      const year = Math.floor(totalMonths / 12);
      const month = ((totalMonths % 12) + 12) % 12;
      const day = Math.min(s.dayOfMonth ?? start.getDate(), daysInMonth(new Date(year, month, 1)));
      return withTime(new Date(year, month, day), h, m);
    };
    let candidate = candidateAt(n);
    if (candidate <= from) { n++; candidate = candidateAt(n); }
    next = candidate;
  }

  if (next && s.endType === 'on_date' && s.endDate) {
    const cutoff = new Date(s.endDate);
    cutoff.setHours(23, 59, 59, 999);
    if (next > cutoff) return null;
  }

  return next;
}

// ── CRUD ────────────────────────────────────────────────────────────────────────

export interface ScheduleInput {
  name: string;
  targetType: ScheduleTargetType;
  targetValues: string[];
  recurrenceType: RecurrenceType;
  interval: number;
  daysOfWeek: number[] | null;
  dayOfMonth: number | null;
  startAt: string;
  endType: ScheduleEndType;
  endDate: string | null;
  enabled?: boolean;
}

/** Raw, untrusted request body shape for POST/PUT — every field optional until validated. */
export interface ScheduleBody {
  name?: string;
  targetType?: ScheduleTargetType;
  targetValues?: string[];
  recurrenceType?: RecurrenceType;
  interval?: number;
  daysOfWeek?: number[] | null;
  dayOfMonth?: number | null;
  startAt?: string;
  endType?: ScheduleEndType;
  endDate?: string | null;
  enabled?: boolean;
}

export async function createSchedule(data: ScheduleInput): Promise<{ schedule: Schedule } | { error: string }> {
  if (!data.name.trim()) return { error: 'Name is required.' };

  const targetError = await validateTarget(data.targetType, data.targetValues);
  if (targetError) return { error: targetError };

  const recurrenceError = validateRecurrence(data);
  if (recurrenceError) return { error: recurrenceError };

  const enabled = data.enabled ?? true;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const nextRunAt = enabled ? computeNextRun(data, new Date())?.toISOString() ?? null : null;

  await run(db.insert(schedules).values({
    id,
    name: data.name.trim(),
    targetType: data.targetType,
    targetValues: JSON.stringify(data.targetType === 'all' ? [] : data.targetValues),
    recurrenceType: data.recurrenceType,
    interval: data.interval,
    daysOfWeek: data.daysOfWeek ? JSON.stringify(data.daysOfWeek) : null,
    dayOfMonth: data.dayOfMonth,
    startAt: data.startAt,
    endType: data.endType,
    endDate: data.endDate,
    enabled,
    nextRunAt,
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
  }));

  return { schedule: (await getSchedule(id))! };
}

export async function updateSchedule(id: string, data: Partial<ScheduleInput>): Promise<{ schedule: Schedule } | { error: string } | null> {
  const existing = await getSchedule(id);
  if (!existing) return null;

  const merged: ScheduleInput = {
    name: data.name ?? existing.name,
    targetType: data.targetType ?? existing.targetType,
    targetValues: data.targetValues ?? existing.targetValues,
    recurrenceType: data.recurrenceType ?? existing.recurrenceType,
    interval: data.interval ?? existing.interval,
    daysOfWeek: data.daysOfWeek !== undefined ? data.daysOfWeek : existing.daysOfWeek,
    dayOfMonth: data.dayOfMonth !== undefined ? data.dayOfMonth : existing.dayOfMonth,
    startAt: data.startAt ?? existing.startAt,
    endType: data.endType ?? existing.endType,
    endDate: data.endDate !== undefined ? data.endDate : existing.endDate,
    enabled: data.enabled ?? existing.enabled,
  };

  if (!merged.name.trim()) return { error: 'Name cannot be empty.' };

  const targetError = await validateTarget(merged.targetType, merged.targetValues);
  if (targetError) return { error: targetError };

  const recurrenceError = validateRecurrence(merged);
  if (recurrenceError) return { error: recurrenceError };

  const nextRunAt = merged.enabled ? computeNextRun(merged, new Date())?.toISOString() ?? null : null;

  await run(db.update(schedules).set({
    name: merged.name.trim(),
    targetType: merged.targetType,
    targetValues: JSON.stringify(merged.targetType === 'all' ? [] : merged.targetValues),
    recurrenceType: merged.recurrenceType,
    interval: merged.interval,
    daysOfWeek: merged.daysOfWeek ? JSON.stringify(merged.daysOfWeek) : null,
    dayOfMonth: merged.dayOfMonth,
    startAt: merged.startAt,
    endType: merged.endType,
    endDate: merged.endDate,
    enabled: merged.enabled,
    nextRunAt,
    updatedAt: new Date().toISOString(),
  }).where(eq(schedules.id, id)));

  return { schedule: (await getSchedule(id))! };
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const existing = await getSchedule(id);
  if (!existing) return false;
  await deleteLinksForSchedule(id);
  await run(db.delete(schedules).where(eq(schedules.id, id)));
  return true;
}

/** Advances a schedule after a run. A null nextRunAt means the recurrence has no more
 *  occurrences (a one-off that just fired, or a recurring schedule past its end date) —
 *  the schedule is disabled rather than left enabled with nothing left to do. */
export async function setNextRun(id: string, nextRunAt: string | null, lastRunAt?: string): Promise<void> {
  await run(db.update(schedules).set({
    nextRunAt,
    ...(nextRunAt === null && { enabled: false }),
    ...(lastRunAt !== undefined && { lastRunAt }),
    updatedAt: new Date().toISOString(),
  }).where(eq(schedules.id, id)));
}
