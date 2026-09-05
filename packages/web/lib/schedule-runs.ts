import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from './db/client';
import { scheduleRuns } from './db/tables';
import { many, one, run } from './db/exec';
import { INSTANCE_ID } from './instance-id';
import type { ScheduleTargetType } from './db/schedules';

// Raised from the original per-schedule audit-log cap (50) to match scan-history retention (90)
// now that this table also backs the user-facing Run History list, not just internal bookkeeping.
const MAX_RUNS_PER_BUCKET = 90;

export type ScheduleRunStatus = 'running' | 'success' | 'partial' | 'error';
export type RunTriggeredBy = 'manual' | 'schedule';
export type NotifyStatus = 'none' | 'pending' | 'sending' | 'sent';

/**
 * How long a run may go without a heartbeat, or a notification claim without being closed, before
 * another process may treat its owner as dead and take over (issue #88). Heartbeats land every
 * 30 seconds (run-executor.ts), and one notification dispatch is bounded by a few attempts of a
 * few seconds each, so five minutes is far outside anything a live process does and still short
 * enough that a crashed container's run is reported, and its notifications sent, on the next tick.
 */
export const STALE_AFTER_MS = 5 * 60_000;

/** The ISO instant before which a heartbeat or claim counts as stale, as of `now`. */
export function staleBefore(now: Date = new Date()): string {
  return new Date(now.getTime() - STALE_AFTER_MS).toISOString();
}

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
  /** When the current 'sending' claim was taken; null until a dispatch claims the row. */
  notifyClaimedAt: string | null;
  /** Last proof of life from the process running this row; null on rows from before the column existed. */
  heartbeatAt: string | null;
  /** lib/instance-id.ts's id of the process that started the run; null on rows from before the column. */
  ownerId: string | null;
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
    notifyClaimedAt: row.notifyClaimedAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    ownerId: row.ownerId ?? null,
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
    notifyClaimedAt: null,
    // The first heartbeat is the start itself, so a row is never 'running' with no proof of life.
    heartbeatAt: startedAt,
    ownerId: INSTANCE_ID,
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

/** The outbox rows nobody has finished dispatching: never claimed ('pending'), or claimed by a
 *  process that stopped before closing the entry (a 'sending' claim older than `staleBefore`, or
 *  one with no claim time at all). */
function notifyDueCondition(staleBeforeIso: string) {
  return or(
    eq(scheduleRuns.notifyStatus, 'pending'),
    and(
      eq(scheduleRuns.notifyStatus, 'sending'),
      or(isNull(scheduleRuns.notifyClaimedAt), lt(scheduleRuns.notifyClaimedAt, staleBeforeIso)),
    ),
  );
}

/**
 * Claims a run's notification batch for this process: one conditional UPDATE that moves the row to
 * 'sending' only while it is still due (see `notifyDueCondition`). Of any number of processes
 * trying at once, exactly one sees a row change and gets `true`; the rest get `false` and must not
 * dispatch (issue #88). At-least-once, never twice from two live processes: a claim whose owner
 * died is taken over only after STALE_AFTER_MS.
 */
export async function claimNotifyDispatch(id: string, opts: { now?: Date } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const claimed = await many(
    db.update(scheduleRuns)
      .set({ notifyStatus: 'sending', notifyClaimedAt: now.toISOString() })
      .where(and(eq(scheduleRuns.id, id), notifyDueCondition(staleBefore(now))))
      .returning({ id: scheduleRuns.id }),
  );
  return claimed.length > 0;
}

/** Refreshes a running row's proof of life. A no-op once the run has finished, so a timer that
 *  fires a beat late can never resurrect a closed row. */
export async function heartbeatRun(id: string, now: Date = new Date()): Promise<void> {
  await run(
    db.update(scheduleRuns)
      .set({ heartbeatAt: now.toISOString() })
      .where(and(eq(scheduleRuns.id, id), eq(scheduleRuns.status, 'running'))),
  );
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

/** Every row still `status: 'running'` whose owner has stopped proving it is alive: a heartbeat
 *  older than `staleBefore`, or none at all (rows from before the column existed, which the
 *  upgrade leaves NULL). A row with a fresh heartbeat belongs to a live process, most likely the
 *  container this one is replacing, and is not an orphan. Feeds `recoverInterruptedRuns()`. */
export async function listStaleRunningRuns(staleBeforeIso: string): Promise<ScheduleRun[]> {
  return (await many(
    db.select().from(scheduleRuns).where(and(
      eq(scheduleRuns.status, 'running'),
      or(isNull(scheduleRuns.heartbeatAt), lt(scheduleRuns.heartbeatAt, staleBeforeIso)),
    )),
  )).map(rowToRun);
}

/** Every row whose notification batch is still due, per `notifyDueCondition`. Feeds
 *  `recoverPendingNotifications()`; each row is then claimed individually before dispatch. */
export async function listNotificationRunsToRecover(staleBeforeIso: string): Promise<ScheduleRun[]> {
  return (await many(db.select().from(scheduleRuns).where(notifyDueCondition(staleBeforeIso)))).map(rowToRun);
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
