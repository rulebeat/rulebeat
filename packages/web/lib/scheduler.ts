import { listDueSchedules, setNextRun, computeNextRun, type Schedule } from './db/schedules';
import { executeTarget, type RunTarget } from './run-executor';
import type { ScheduleRun } from './schedule-runs';
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

export function startScheduler(): void {
  if (process.env.RULEBEAT_DISABLE_SCHEDULER === '1') return;
  // Demo mode is read-only (see lib/demo.ts) — a ticking scheduler would mutate the curated
  // synthetic estate every visitor is meant to see the same version of.
  if (isDemoMode()) return;
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
    const now = new Date().toISOString();
    const due = listDueSchedules(now);
    for (const schedule of due) {
      try {
        await runOnce(schedule);
      } catch {
        // runOnce already records failures in schedule_runs; never let one bad
        // schedule stop the loop from processing the rest.
      }
    }
  } finally {
    busy = false;
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

async function runOnce(schedule: Schedule): Promise<void> {
  const startedAtIso = new Date().toISOString();
  await executeTarget(
    { targetType: schedule.targetType, targetValues: schedule.targetValues },
    { triggeredBy: 'schedule', scheduleId: schedule.id },
  );
  const nextRunAt = computeNextRun(schedule, new Date())?.toISOString() ?? null;
  setNextRun(schedule.id, nextRunAt, startedAtIso);
}
