import { eq, desc } from 'drizzle-orm';
import { db } from './db/client';
import { scheduleRuns } from './db/schema';
import type { ScheduleTargetType } from './db/schedules';

// Raised from the original per-schedule audit-log cap (50) to match scan-history retention (90)
// now that this table also backs the user-facing Run History list, not just internal bookkeeping.
const MAX_RUNS_PER_BUCKET = 90;

export type ScheduleRunStatus = 'running' | 'success' | 'partial' | 'error';
export type RunTriggeredBy = 'manual' | 'schedule';
export type NotifyStatus = 'none' | 'pending' | 'sent';

export interface ScheduleRun {
  id: string;
  scheduleId: string; // '' for manual (non-scheduled) runs
  triggeredBy: RunTriggeredBy;
  targetType: ScheduleTargetType | null;   // null for runs recorded before this column existed
  targetValues: string[];
  startedAt: string;
  finishedAt: string | null;
  status: ScheduleRunStatus;
  categories: string[];
  totalFindings: number;
  newFindings: number;
  newFindingFingerprints: string[];
  error: string | null;
  durationMs: number | null;
  notifyStatus: NotifyStatus;
}

type Row = typeof scheduleRuns.$inferSelect;

function rowToRun(row: Row): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    triggeredBy: (row.triggeredBy as RunTriggeredBy | undefined) ?? (row.scheduleId ? 'schedule' : 'manual'),
    targetType: (row.targetType as ScheduleTargetType | null) ?? null,
    targetValues: row.targetValues ? JSON.parse(row.targetValues) as string[] : [],
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    status: row.status as ScheduleRunStatus,
    categories: JSON.parse(row.categories) as string[],
    totalFindings: row.totalFindings,
    newFindings: row.newFindings,
    newFindingFingerprints: row.newFindingFingerprints ? JSON.parse(row.newFindingFingerprints) as string[] : [],
    error: row.error,
    durationMs: row.durationMs,
    notifyStatus: (row.notifyStatus as NotifyStatus | undefined) ?? 'none',
  };
}

export interface StartRunOptions {
  scheduleId: string; // '' for manual runs
  triggeredBy: RunTriggeredBy;
  categories: string[];
  targetType?: ScheduleTargetType;
  targetValues?: string[];
  /** Injected by the demo generator to stamp a replayed run at its simulated date. */
  now?: Date;
}

export function startRun(opts: StartRunOptions): ScheduleRun {
  const id = crypto.randomUUID();
  const startedAt = (opts.now ?? new Date()).toISOString();

  db.insert(scheduleRuns).values({
    id,
    scheduleId: opts.scheduleId,
    triggeredBy: opts.triggeredBy,
    targetType: opts.targetType ?? null,
    targetValues: opts.targetValues ? JSON.stringify(opts.targetValues) : null,
    startedAt,
    finishedAt: null,
    status: 'running',
    categories: JSON.stringify(opts.categories),
    totalFindings: 0,
    newFindings: 0,
    newFindingFingerprints: null,
    error: null,
    durationMs: null,
    notifyStatus: 'none',
  }).run();

  pruneOldRuns(opts.scheduleId);

  return rowToRun(db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).get()!);
}

export function finishRun(id: string, patch: {
  status: ScheduleRunStatus;
  totalFindings: number;
  newFindings: number;
  newFindingFingerprints: string[];
  error?: string;
  durationMs: number;
  notifyStatus?: NotifyStatus;
  /** Injected by the demo generator to stamp a replayed run at its simulated date. */
  now?: Date;
}): void {
  db.update(scheduleRuns).set({
    finishedAt: (patch.now ?? new Date()).toISOString(),
    status: patch.status,
    totalFindings: patch.totalFindings,
    newFindings: patch.newFindings,
    newFindingFingerprints: JSON.stringify(patch.newFindingFingerprints),
    error: patch.error ?? null,
    durationMs: patch.durationMs,
    notifyStatus: patch.notifyStatus ?? 'none',
  }).where(eq(scheduleRuns.id, id)).run();
}

/** Marks a run's notification outbox entry closed — the attempt was made, whatever its per-channel
 * outcome (tracked separately in notification_deliveries). Called by both the live dispatch path and
 * the startup recovery pass, so there is exactly one place that decides "this entry is done." */
export function markNotifySent(id: string): void {
  db.update(scheduleRuns).set({ notifyStatus: 'sent' }).where(eq(scheduleRuns.id, id)).run();
}

/** Durably appends one category's new-finding fingerprints and totals to a still-running run's row,
 * immediately after that category's findings were synced into the durable `findings` table — not just
 * once at the end in finishRun(). Closes the gap where a crash between categories left findings that
 * were already durable in `findings` with no fingerprint ever recorded against the run, so recovery
 * had nothing to notify from (spec 025). */
export function recordCategoryProgress(id: string, delta: {
  totalFindings: number;
  newFindings: number;
  newFindingFingerprints: string[];
}): void {
  const row = db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).get();
  if (!row) return;

  const existingFingerprints = row.newFindingFingerprints ? JSON.parse(row.newFindingFingerprints) as string[] : [];
  const mergedFingerprints = Array.from(new Set([...existingFingerprints, ...delta.newFindingFingerprints]));

  db.update(scheduleRuns).set({
    totalFindings: row.totalFindings + delta.totalFindings,
    newFindings: row.newFindings + delta.newFindings,
    newFindingFingerprints: JSON.stringify(mergedFingerprints),
  }).where(eq(scheduleRuns.id, id)).run();
}

/** Runs for a single schedule (used by the Schedules tab's "last run" column). */
export function listRuns(scheduleId: string, limit = 20): ScheduleRun[] {
  return db.select().from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, scheduleId))
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(limit)
    .all()
    .map(rowToRun);
}

/** Every run across every schedule AND manual "Run Scan" executions — the unified Run History. */
export function listAllRuns(limit = 50): ScheduleRun[] {
  return db.select().from(scheduleRuns)
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(limit)
    .all()
    .map(rowToRun);
}

export function getRun(id: string): ScheduleRun | null {
  const row = db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).get();
  return row ? rowToRun(row) : null;
}

export function getLatestRun(scheduleId: string): ScheduleRun | null {
  return listRuns(scheduleId, 1)[0] ?? null;
}

/** Every row still `status: 'running'` — at process start, that can only mean a previous process
 *  died mid-scan (this process hasn't started a run yet). Feeds `recoverInterruptedRuns()`. */
export function listRunningRuns(): ScheduleRun[] {
  return db.select().from(scheduleRuns).where(eq(scheduleRuns.status, 'running')).all().map(rowToRun);
}

/** Every row still `notifyStatus: 'pending'` — its notification batch was due but never confirmed
 *  dispatched. Feeds `recoverPendingNotifications()`. */
export function listPendingNotificationRuns(): ScheduleRun[] {
  return db.select().from(scheduleRuns).where(eq(scheduleRuns.notifyStatus, 'pending')).all().map(rowToRun);
}

function pruneOldRuns(scheduleId: string): void {
  const rows = db.select({ id: scheduleRuns.id }).from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, scheduleId))
    .orderBy(desc(scheduleRuns.startedAt))
    .all();

  const toDelete = rows.slice(MAX_RUNS_PER_BUCKET);
  for (const row of toDelete) {
    db.delete(scheduleRuns).where(eq(scheduleRuns.id, row.id)).run();
  }
}
