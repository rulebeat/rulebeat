/**
 * Spec 030: the posture formula's tri-state contract: a rule counts as passing only when it
 * has zero active findings AND its last real scan proved it (lastRunStatus === 'success'). Zero
 * findings alone is not proof: a rule that has never run, or whose last run errored, goes into
 * unknownRules instead. Activity-kind rules (log-analytics, spec 029) have no "zero findings means
 * passing" state at all and are counted separately. See splitRuleOutcomes() and
 * countedRulesForCategory() in lib/dashboard-data.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable, postureSnapshots } from '@/lib/db/tables';
import { syncScanFindings } from '@/lib/db/findings';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { SNAPSHOT_FORMULA_VERSION } from '@/lib/db/snapshots';
import { resetDb, clearRules } from '../helpers/db';
import type { Finding } from '@/lib/types';
import { EVERYTHING_ACCESS } from '../helpers/access';

const CATEGORY = 'security';
const RULE_PASSING = 'test-rule-passing';
const RULE_UNKNOWN_FAILED = 'test-rule-unknown-failed';
const RULE_UNKNOWN_NEVER_RUN = 'test-rule-unknown-never-run';
const RULE_WITH_FINDING = 'test-rule-with-finding';
const RULE_ACTIVITY = 'test-rule-activity';

async function insertRule(id: string, overrides: { lastRunStatus?: string | null; kind?: string; queryBackend?: string } = {}): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: CATEGORY,
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom',
    lastRunStatus: overrides.lastRunStatus ?? null,
    kind: overrides.kind ?? 'state',
    queryBackend: overrides.queryBackend ?? 'resource-graph',
  }));
}

function finding(ruleId: string, resourceSuffix: string): Finding {
  const resourceId = `/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${resourceSuffix}`;
  return {
    module: CATEGORY,
    ruleId,
    fingerprint: computeFingerprint(ruleId, resourceId),
    severity: 'medium',
    category: CATEGORY,
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: resourceSuffix,
    subscriptionId: 'sub-1',
    title: 'test finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
  };
}

describe('the honest posture metric: passing / unknown / activity (spec 030)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule(RULE_PASSING, { lastRunStatus: 'success' });
    await insertRule(RULE_UNKNOWN_FAILED, { lastRunStatus: 'failed' });
    await insertRule(RULE_UNKNOWN_NEVER_RUN, { lastRunStatus: null });
    // Last run also errored, but an active finding makes it implicitly failing regardless:
    // proves unknownRules is specifically "zero findings, not proven", not "everything imperfect".
    await insertRule(RULE_WITH_FINDING, { lastRunStatus: 'failed' });
    await insertRule(RULE_ACTIVITY, { lastRunStatus: 'success', kind: 'activity', queryBackend: 'log-analytics' });

    await syncScanFindings({
      scanId: 's1',
      category: CATEGORY,
      ranRuleIds: [RULE_WITH_FINDING],
      findings: [finding(RULE_WITH_FINDING, 'vm-1')],
      finishedAt: new Date().toISOString(),
    });
  });

  it('a rule with zero findings but a failed or never-run last status counts as unknown, never passing', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);

    expect(summary.current.passingRules).toBe(1);
    expect(summary.current.unknownRules).toBe(2);
  });

  it('an activity-kind rule is excluded from totalRules/passingRules and counted in activityRuleCount', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);

    // 4 state rules (passing, unknown-failed, unknown-never-run, with-finding). The activity
    // rule is not one of them, no matter how healthy its own status looks.
    expect(summary.current.totalRules).toBe(4);
    expect(summary.current.activityRuleCount).toBe(1);
  });

  it('perCategory carries the same passing/total its pct is rounded from (spec 033)', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);
    const mod = summary.perCategory.find(m => m.category === CATEGORY);

    expect(mod).toBeDefined();
    expect(mod!.passing).toBe(1);
    expect(mod!.total).toBe(4);
    expect(mod!.pct).toBe(25);
  });

  it('perSubscription carries the same passingRules/totalRules its pct is rounded from (spec 033)', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);
    const sub = summary.perSubscription.find(s => s.subscriptionId === 'sub-1');

    expect(sub).toBeDefined();
    expect(sub!.passingRules).toBe(1);
    expect(sub!.totalRules).toBe(4);
    expect(sub!.pct).toBe(25);
  });
});

describe('spec 033: baseline honesty: a pre-honest-formula snapshot must not blend into the trend comparison', () => {
  // Comfortably before any `dateWindow: { mode: 'relative', days: 7 }` cutoff, whatever "today" is.
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const BASELINE_DATE = daysAgo(30);
  const DAYS_AGO_10 = daysAgo(10);
  const DAYS_AGO_2 = daysAgo(2);
  // A 7-day window starts 7 days ago, so the baseline is the newest point on or before the day before.
  const DAY_BEFORE_WINDOW = daysAgo(8);
  const SUB_ONE = 'sub-1';

  async function baselineRow(category: string, passingRules: number, totalRules: number, formulaVersion: number, date = BASELINE_DATE, subscriptionId = ''): Promise<void> {
    await execRun(db.insert(postureSnapshots).values({
      category,
      subscriptionId,
      date,
      posturePct: Math.round((passingRules / totalRules) * 100),
      passingRules,
      totalRules,
      unknownRules: 0,
      activityRuleCount: 0,
      formulaVersion,
      activeFindings: 0,
      severityCounts: '{}',
      updatedAt: new Date().toISOString(),
    }));
  }

  beforeEach(async () => {
    await resetDb();
    await clearRules();
  });

  it('refuses the baseline when one category has no comparable point, and names the date it needed and the earliest it could use', async () => {
    // security's only point on or before the needed day is formula 1, which equals nothing. If it
    // were dropped from the blend the delta would compare cost's rules with a different set.
    // security does have a comparable point later, so the earliest date every category can be
    // compared from is that one.
    await baselineRow('security', 10, 10, 1);
    await baselineRow('security', 1, 4, 2, DAYS_AGO_2);
    await baselineRow('cost', 1, 4, 2);
    await insertRule(RULE_PASSING, { lastRunStatus: 'success' }); // lands in `security`; gives `pct` a value.

    const summary = await computeWidgetSummary({ categories: ['security', 'cost'], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);

    expect(summary.current.pct).toBe(100);
    expect(summary.baseline, 'a partial blend was built').toBeNull();
    expect(summary.deltaPct).toBeNull();
    expect(summary.baselineGap).toEqual({ needed: DAY_BEFORE_WINDOW, earliest: DAYS_AGO_2, level: 'install' });
  });

  it('never counts a formula-1 point comparable, so a category holding only that has no earliest date', async () => {
    await baselineRow('security', 10, 10, 1);
    await baselineRow('cost', 1, 4, 2);
    await insertRule(RULE_PASSING, { lastRunStatus: 'success' });

    const summary = await computeWidgetSummary({ categories: ['security', 'cost'], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);

    expect(summary.baseline).toBeNull();
    expect(summary.deltaPct).toBeNull();
    expect(summary.baselineGap).toEqual({ needed: DAY_BEFORE_WINDOW, earliest: null, level: 'install' });
  });

  it('takes each category\'s newest comparable point, skipping a newer formula-1 point, and names the oldest date', async () => {
    await baselineRow('security', 3, 4, 2, BASELINE_DATE);
    await baselineRow('security', 10, 10, 1, DAYS_AGO_10);
    await baselineRow('cost', 1, 4, 3, DAYS_AGO_10);
    await insertRule(RULE_PASSING, { lastRunStatus: 'success' });

    const summary = await computeWidgetSummary({ categories: ['security', 'cost'], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);

    // 3/4 + 1/4 = 4/8: 50%. The live 1/1 is 100%.
    expect(summary.baseline).toEqual({ pct: 50, date: BASELINE_DATE });
    expect(summary.deltaPct).toBe(50);
    expect(summary.baselineGap).toBeNull();
  });

  it('does not use a point from inside the window as the baseline', async () => {
    await baselineRow('security', 3, 4, 2, DAYS_AGO_2);
    await insertRule(RULE_PASSING, { lastRunStatus: 'success' });

    const summary = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);

    expect(summary.baseline).toBeNull();
    expect(summary.baselineGap).toEqual({ needed: DAY_BEFORE_WINDOW, earliest: DAYS_AGO_2, level: 'install' });
  });

  it('reads 240 of 240 to 239 of 240 as 99% and -1 pt, never 100% or flat', async () => {
    await baselineRow('security', 240, 240, 2);
    for (let i = 0; i < 239; i++) await insertRule(`bulk-passing-${i}`, { lastRunStatus: 'success' });
    await insertRule('bulk-unproven', { lastRunStatus: null });

    const summary = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);

    expect(summary.current.pct).toBe(99);
    expect(summary.baseline!.pct).toBe(100);
    expect(summary.deltaPct).toBe(-1);
  });

  it('holds a subscription to formula 3: a formula-2 subscription point is not a baseline', async () => {
    await baselineRow('security', 3, 4, 2, BASELINE_DATE, SUB_ONE);
    await insertRule(RULE_PASSING, { lastRunStatus: 'success' });

    const summary = await computeWidgetSummary({ categories: ['security'], subscriptions: [SUB_ONE], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);

    expect(summary.baseline).toBeNull();
    expect(summary.baselineGap).toEqual({ needed: DAY_BEFORE_WINDOW, earliest: null, level: 'subscription' });
  });

  it('when the only baseline row is already honest, the delta still computes exactly as before', async () => {
    await baselineRow('security', 3, 4, SNAPSHOT_FORMULA_VERSION);
    await insertRule(RULE_PASSING, { lastRunStatus: 'success' });

    const summary = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30, EVERYTHING_ACCESS);

    expect(summary.baseline).not.toBeNull();
    expect(summary.baseline!.pct).toBe(75);
    expect(summary.deltaPct).toBe(25);
  });
});
