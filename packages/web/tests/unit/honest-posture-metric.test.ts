/**
 * Spec 030 — the posture formula's tri-state contract: a rule counts as passing only when it
 * has zero active findings AND its last real scan proved it (lastRunStatus === 'success'). Zero
 * findings alone is not proof — a rule that has never run, or whose last run errored, goes into
 * unknownRules instead. Activity-kind rules (log-analytics, spec 029) have no "zero findings means
 * passing" state at all and are counted separately. See splitRuleOutcomes() and
 * enabledRuleIdsForCategory() in lib/dashboard-data.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { rules as rulesTable, postureSnapshots } from '@/lib/db/schema';
import { syncScanFindings } from '@/lib/db/findings';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { SNAPSHOT_FORMULA_VERSION } from '@/lib/db/snapshots';
import { resetDb, clearRules } from '../helpers/db';
import type { Finding } from '@/lib/types';

const CATEGORY = 'security';
const RULE_PASSING = 'test-rule-passing';
const RULE_UNKNOWN_FAILED = 'test-rule-unknown-failed';
const RULE_UNKNOWN_NEVER_RUN = 'test-rule-unknown-never-run';
const RULE_WITH_FINDING = 'test-rule-with-finding';
const RULE_ACTIVITY = 'test-rule-activity';

function insertRule(id: string, overrides: { lastRunStatus?: string | null; kind?: string; queryBackend?: string } = {}): void {
  db.insert(rulesTable).values({
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
  }).run();
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
    insertRule(RULE_PASSING, { lastRunStatus: 'success' });
    insertRule(RULE_UNKNOWN_FAILED, { lastRunStatus: 'failed' });
    insertRule(RULE_UNKNOWN_NEVER_RUN, { lastRunStatus: null });
    // Last run also errored, but an active finding makes it implicitly failing regardless —
    // proves unknownRules is specifically "zero findings, not proven", not "everything imperfect".
    insertRule(RULE_WITH_FINDING, { lastRunStatus: 'failed' });
    insertRule(RULE_ACTIVITY, { lastRunStatus: 'success', kind: 'activity', queryBackend: 'log-analytics' });

    await syncScanFindings({
      scanId: 's1',
      category: CATEGORY,
      ranRuleIds: [RULE_WITH_FINDING],
      findings: [finding(RULE_WITH_FINDING, 'vm-1')],
      finishedAt: new Date().toISOString(),
    });
  });

  it('a rule with zero findings but a failed or never-run last status counts as unknown, never passing', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30);

    expect(summary.current.passingRules).toBe(1);
    expect(summary.current.unknownRules).toBe(2);
  });

  it('an activity-kind rule is excluded from totalRules/passingRules and counted in activityRuleCount', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30);

    // 4 state rules (passing, unknown-failed, unknown-never-run, with-finding) — the activity
    // rule is not one of them, no matter how healthy its own status looks.
    expect(summary.current.totalRules).toBe(4);
    expect(summary.current.activityRuleCount).toBe(1);
  });

  it('perCategory carries the same passing/total its pct is rounded from (spec 033)', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30);
    const mod = summary.perCategory.find(m => m.category === CATEGORY);

    expect(mod).toBeDefined();
    expect(mod!.passing).toBe(1);
    expect(mod!.total).toBe(4);
    expect(mod!.pct).toBe(25);
  });

  it('perSubscription carries the same passingRules/totalRules its pct is rounded from (spec 033)', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30);
    const sub = summary.perSubscription.find(s => s.subscriptionId === 'sub-1');

    expect(sub).toBeDefined();
    expect(sub!.passingRules).toBe(1);
    expect(sub!.totalRules).toBe(4);
    expect(sub!.pct).toBe(25);
  });
});

describe('spec 033 — baseline honesty: a pre-honest-formula snapshot must not blend into the trend comparison', () => {
  // Comfortably before any `dateWindow: { mode: 'relative', days: 7 }` cutoff, whatever "today" is.
  const BASELINE_DATE = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  function baselineRow(category: string, passingRules: number, totalRules: number, formulaVersion: number): void {
    db.insert(postureSnapshots).values({
      category,
      subscriptionId: '',
      date: BASELINE_DATE,
      posturePct: Math.round((passingRules / totalRules) * 100),
      passingRules,
      totalRules,
      unknownRules: 0,
      activityRuleCount: 0,
      formulaVersion,
      activeFindings: 0,
      severityCounts: '{}',
      updatedAt: new Date().toISOString(),
    }).run();
  }

  beforeEach(async () => {
    await resetDb();
    await clearRules();
  });

  it('a category whose only baseline row predates the honest formula is excluded from the blend, not blended in — this is the actual "-75%" bug', async () => {
    // security's only baseline row is old-formula and generous (10/10) — if it leaked into the
    // blend it would pull basePct from cost's honest 25% up toward ~79%, a wrong comparison point.
    baselineRow('security', 10, 10, 1);
    baselineRow('cost', 1, 4, SNAPSHOT_FORMULA_VERSION);
    insertRule(RULE_PASSING, { lastRunStatus: 'success' }); // lands in `security`; gives `pct` a value.

    const summary = await computeWidgetSummary({ categories: ['security', 'cost'], dateWindow: { mode: 'relative', days: 7 } }, 30);

    expect(summary.baseline, 'the old-formula row should not have blanked the baseline entirely').not.toBeNull();
    expect(summary.baseline!.pct, 'the old-formula row leaked into the baseline blend').toBe(25);
    expect(summary.deltaPct).toBe(75);
  });

  it('when the only baseline row is already honest, the delta still computes exactly as before', async () => {
    baselineRow('security', 3, 4, SNAPSHOT_FORMULA_VERSION);
    insertRule(RULE_PASSING, { lastRunStatus: 'success' });

    const summary = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30);

    expect(summary.baseline).not.toBeNull();
    expect(summary.baseline!.pct).toBe(75);
    expect(summary.deltaPct).toBe(25);
  });
});
