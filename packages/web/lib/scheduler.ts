import type { TenantContext } from '@rulebeat/core';
import { listDueSchedules, claimDueSchedule, advanceScheduleAfterRun, computeNextRun, type Schedule } from './db/schedules';
import { executeTarget, type RunTarget } from './run-executor';
import type { ScheduleRun } from './schedule-runs';
import { recoverInterruptedRuns, recoverPendingNotifications } from './startup-recovery';
import { isDemoMode } from './demo';

const TICK_INTERVAL_MS = 30_000;

// A simple busy flag (not a promise chain) — ticks that fire while a run is in progress
// are dropped rather than queued, so a long-running scan can never stack up a backlog of
// pending ticks. Due schedules simply get picked up on the next tick after the busy flag clears.
let busy = false;

type SchedulerGlobals = {
  __rulebeatSchedulerStarted?: boolean;
  __rulebeatSchedulerLastTickAt?: string;
};

function schedulerGlobals(): SchedulerGlobals {
  return globalThis as typeof globalThis & SchedulerGlobals;
}

export async function startScheduler(): Promise<void> {
  if (process.env.RULEBEAT_DISABLE_SCHEDULER === '1') return;
  // Demo mode is read-only (see lib/demo.ts) — a ticking scheduler would mutate the curated
  // synthetic estate every visitor is meant to see the same version of.
  if (await isDemoMode()) return;
  const g = schedulerGlobals();
  if (g.__rulebeatSchedulerStarted) return;
  g.__rulebeatSchedulerStarted = true;

  const tick = () => { void tickOnce(); };
  setInterval(tick, TICK_INTERVAL_MS);
  tick();
}

export function getSchedulerStatus(): {
  enabled: boolean;
  started: boolean;
  lastTickAt: string | null;
  secondsSinceTick: number | null;
} {
  const g = schedulerGlobals();
  const lastTickAt = g.__rulebeatSchedulerLastTickAt ?? null;
  return {
    enabled: process.env.RULEBEAT_DISABLE_SCHEDULER !== '1',
    started: g.__rulebeatSchedulerStarted ?? false,
    lastTickAt,
    secondsSinceTick: lastTickAt
      ? Math.round((Date.now() - new Date(lastTickAt).getTime()) / 1000)
      : null,
  };
}

async function tickOnce(): Promise<void> {
  schedulerGlobals().__rulebeatSchedulerLastTickAt = new Date().toISOString();
  if (busy) return;
  busy = true;
  try {
    await sweepStaleWork();
    await runDueSchedules();
  } finally {
    busy = false;
  }
}

/**
 * The same two recovery passes instrumentation.ts runs at startup, repeated every tick. Startup
 * alone stopped being enough once recovery learned to leave a run with a fresh heartbeat alone
 * (issue #88): the container this one replaced may die mid-scan after this one has already
 * started, and its run would otherwise stay 'running', and its notifications unsent, until
 * somebody restarted again. Both passes are one SELECT each when there is nothing to do.
 */
async function sweepStaleWork(): Promise<void> {
  try {
    await recoverInterruptedRuns();
    await recoverPendingNotifications();
  } catch (err) {
    console.error('[scheduler] stale-run sweep failed:', err);
  }
}

/**
 * Runs every schedule due at `now`, claiming each one before running it. One tick of one process;
 * exported so a test can drive two of them against one database at once, which is exactly what a
 * rolling deploy does. `ctx` is injected by tests only, the same way run-executor.ts takes it.
 */
export async function runDueSchedules(opts: { now?: Date; ctx?: TenantContext } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const due = await listDueSchedules(now.toISOString());
  for (const schedule of due) {
    try {
      await runOnce(schedule, opts);
    } catch {
      // runOnce already records failures in schedule_runs; never let one bad
      // schedule stop the loop from processing the rest.
    }
  }
}

/** Also used by the "Run now" API. If a tick is currently running, wait for it to clear
 *  first so a manual trigger can never overlap with an automatic run. */
export async function executeSchedule(schedule: Schedule): Promise<void> {
  while (busy) await new Promise(r => setTimeout(r, 250));
  busy = true;
  try {
    await runOnce(schedule);
  } finally {
    busy = false;
  }
}

/** Ad-hoc "Run Scan" trigger from the Scans page — shares the same busy-flag serialization as
 *  scheduled runs so a manual run can never overlap with an automatic one, and goes through the
 *  exact same executeTarget() core so it shows up in Run History identically to a schedule fire. */
export async function runManualTarget(target: RunTarget): Promise<ScheduleRun> {
  while (busy) await new Promise(r => setTimeout(r, 250));
  busy = true;
  try {
    return await executeTarget(target, { triggeredBy: 'manual' });
  } finally {
    busy = false;
  }
}

/**
 * Claim, run, re-advance (issue #88). The claim moves `next_run_at` to the next occurrence before
 * the scan starts, from the value this process saw, so a second process seeing the same due row
 * loses the claim and skips. The cost is deliberate and documented in the FAQ: a process that dies
 * mid-scan no longer re-runs the schedule at the next start; the run is reported as interrupted
 * once its heartbeat goes stale, and the schedule waits for its next occurrence.
 *
 * `now` and `ctx` are for tests (and the demo generator's shape of the same idea): a real tick
 * passes neither.
 */
async function runOnce(schedule: Schedule, opts: { now?: Date; ctx?: TenantContext } = {}): Promise<void> {
  const startedAt = opts.now ?? new Date();
  const claimedNextRunAt = computeNextRun(schedule, startedAt)?.toISOString() ?? null;
  const claimed = await claimDueSchedule(schedule, claimedNextRunAt, startedAt.toISOString());
  if (!claimed) return;

  await executeTarget(
    { targetType: schedule.targetType, targetValues: schedule.targetValues },
    { triggeredBy: 'schedule', scheduleId: schedule.id, ctx: opts.ctx },
  );

  // A scan longer than its own interval must not run again the instant it ends: move on to the
  // first occurrence after the finish, unless an operator moved the schedule meanwhile.
  const finishedAt = opts.now ?? new Date();
  const afterRun = computeNextRun(schedule, finishedAt)?.toISOString() ?? null;
  await advanceScheduleAfterRun(schedule.id, claimedNextRunAt, afterRun);
}
