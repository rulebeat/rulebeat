import type { Rule } from '@rulebeat/core';
import { executeTarget } from '../../lib/run-executor';
import { assertNoQueryFailures, createFakeContext } from './fake-context';
import type { Estate } from './estate';
import type { SyntheticApp } from './identity-fixtures';
import type { RuleFixture } from './rule-fixture';

/** Total simulated days. Kept well under the 90-run-per-schedule and 90-row-per-category retention
 *  caps (lib/schedule-runs.ts, lib/scan-history.ts) — one run and one scan-history row per category
 *  per day, so 90 would be the hard ceiling; 60 leaves headroom and still gives two months of
 *  trend/posture-snapshot history to show off. */
export const TOTAL_DAYS = 60;

/** Simulated calendar day → the timestamp that day's run is stamped with. Day `TOTAL_DAYS - 1` is
 *  "today" (a fixed 09:00 so every run of the generator lands on the same time-of-day); earlier
 *  days count backward from there. Deliberately not tied to the day's *real* wall-clock time, so
 *  the whole replay reads as one deterministic history regardless of what time this script runs. */
function dateForDay(day: number, totalDays: number): Date {
  const base = new Date();
  base.setHours(9, 0, 0, 0);
  const daysAgo = totalDays - 1 - day;
  return new Date(base.getTime() - daysAgo * 86_400_000);
}

export interface ReplayOptions {
  estate: Estate;
  rules: Rule[];
  fixturesByRuleId: Map<string, RuleFixture>;
  identityApps: SyntheticApp[];
  scheduleId: string;
  totalDays?: number;
  onDay?: (day: number, totalDays: number) => void;
}

/** Runs `executeTarget()` once per simulated day, oldest first, each against a fake context scoped
 *  to that day — the same shared execution path a real scheduled scan uses, so every downstream
 *  table (findings, finding_events, scan_history, posture_snapshots, schedule_runs) fills in
 *  exactly as it would from 60 days of a real 'all'-target daily schedule. */
export async function replay(opts: ReplayOptions): Promise<void> {
  const { estate, rules, fixturesByRuleId, identityApps, scheduleId } = opts;
  const totalDays = opts.totalDays ?? TOTAL_DAYS;

  for (let day = 0; day < totalDays; day++) {
    const ctx = createFakeContext({ estate, rules, fixturesByRuleId, identityApps, day, totalDays });
    const now = dateForDay(day, totalDays);

    const run = await executeTarget(
      { targetType: 'all', targetValues: [] },
      { triggeredBy: 'schedule', scheduleId, ctx, now },
    );

    if (run.error) {
      throw new Error(`Demo generator: simulated day ${day} (${now.toISOString()}) failed: ${run.error}`);
    }
    assertNoQueryFailures(ctx, day);
    opts.onDay?.(day, totalDays);
  }
}
