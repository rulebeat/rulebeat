import { eq, desc } from 'drizzle-orm';
import { db } from './db/client';
import { scheduleRuns } from './db/tables';
import { many, one, run } from './db/exec';
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

export async function startRun(opts: StartRunOptions): Promise<ScheduleRun> {
  const id = crypto.randomUUID();
  const startedAt = (opts.now ?? new Date()).toISOString();

  await run(db.insert(scheduleRuns).values({
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
  }));

  await pruneOldRuns(opts.scheduleId);

  return rowToRun((await one(db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id))))!);
}

export async function finishRun(id: string, patch: {
  status: ScheduleRunStatus;
  totalFindings: number;
  newFindings: number;
  newFindingFingerprints: string[];
  error?: string;
  durationMs: number;
  notifyStatus?: NotifyStatus;
  /** Injected by the demo generator to stamp a replayed run at its simulated date. */
  now?: Date;
}): Promise<void> {
  await run(db.update(scheduleRuns).set({
    finishedAt: (patch.now ?? new Date()).toISOString(),
    status: patch.status,
    totalFindings: patch.totalFindings,
    newFindings: patch.newFindings,
    newFindingFingerprints: JSON.stringify(patch.newFindingFingerprints),
    error: patch.error ?? null,
    durationMs: patch.durationMs,
    notifyStatus: patch.notifyStatus ?? 'none',
  }).where(eq(scheduleRuns.id, id)));
}

/** Marks a run's notification outbox entry closed — the attempt was made, whatever its per-channel
 * outcome (tracked separately in notification_deliveries). Called by both the live dispatch path and
 * the startup recovery pass, so there is exactly one place that decides "this entry is done." */
export async function markNotifySent(id: string): Promise<void> {
  await run(db.update(scheduleRuns).set({ notifyStatus: 'sent' }).where(eq(scheduleRuns.id, id)));
}

/** Durably appends one category's new-finding fingerprints and totals to a still-running run's row,
 * immediately after that category's findings were synced into the durable `findings` table — not just
 * once at the end in finishRun(). Closes the gap where a crash between categories left findings that
 * were already durable in `findings` with no fingerprint ever recorded against the run, so recovery
 * had nothing to notify from (spec 025). */
export async function recordCategoryProgress(id: string, delta: {
  totalFindings: number;
  newFindings: number;
  newFindingFingerprints: string[];
}): Promise<void> {
  const row = await one(db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)));
  if (!row) return;

  const existingFingerprints = row.newFindingFingerprints ? JSON.parse(row.newFindingFingerprints) as string[] : [];
  const mergedFingerprints = Array.from(new Set([...existingFingerprints, ...delta.newFindingFingerprints]));

  await run(db.update(scheduleRuns).set({
    totalFindings: row.totalFindings + delta.totalFindings,
    newFindings: row.newFindings + delta.newFindings,
    newFindingFingerprints: JSON.stringify(mergedFingerprints),
  }).where(eq(scheduleRuns.id, id)));
}

/** Runs for a single schedule (used by the Schedules tab's "last run" column). */
export async function listRuns(scheduleId: string, limit = 20): Promise<ScheduleRun[]> {
  return (await many(db.select().from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, scheduleId))
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(limit)))
    .map(rowToRun);
}

/** Every run across every schedule AND manual "Run Scan" executions — the unified Run History. */
export async function listAllRuns(limit = 50): Promise<ScheduleRun[]> {
  return (await many(db.select().from(scheduleRuns)
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(limit)))
    .map(rowToRun);
}

export async function getRun(id: string): Promise<ScheduleRun | null> {
  const row = await one(db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)));
  return row ? rowToRun(row) : null;
}

export async function getLatestRun(scheduleId: string): Promise<ScheduleRun | null> {
  return (await listRuns(scheduleId, 1))[0] ?? null;
}

/** Every row still `status: 'running'` — at process start, that can only mean a previous process
 *  died mid-scan (this process hasn't started a run yet). Feeds `recoverInterruptedRuns()`. */
export async function listRunningRuns(): Promise<ScheduleRun[]> {
  return (await many(db.select().from(scheduleRuns).where(eq(scheduleRuns.status, 'running')))).map(rowToRun);
}

/** Every row still `notifyStatus: 'pending'` — its notification batch was due but never confirmed
 *  dispatched. Feeds `recoverPendingNotifications()`. */
export async function listPendingNotificationRuns(): Promise<ScheduleRun[]> {
  return (await many(db.select().from(scheduleRuns).where(eq(scheduleRuns.notifyStatus, 'pending')))).map(rowToRun);
}

async function pruneOldRuns(scheduleId: string): Promise<void> {
  const rows = await many(db.select({ id: scheduleRuns.id }).from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, scheduleId))
    .orderBy(desc(scheduleRuns.startedAt)));

  const toDelete = rows.slice(MAX_RUNS_PER_BUCKET);
  for (const row of toDelete) {
    await run(db.delete(scheduleRuns).where(eq(scheduleRuns.id, row.id)));
  }
}
