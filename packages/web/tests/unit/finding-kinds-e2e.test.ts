/**
 * End-to-end proof that a finding-level total (the dashboard's live summary, the New vs Fixed
 * trend, and the posture snapshot writer) counts a state finding, while an activity-kind finding
 * and a finding of some future kind (stood in for by 'advisory', ADR 0005) are excluded. See
 * lib/finding-kinds.ts for why there are two predicates and which one each of these paths uses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core';
import { syncScanFindings, getFindingEventCounts } from '@/lib/db/findings';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { upsertDailySnapshot, getSnapshots } from '@/lib/db/snapshots';
import { resetDb, clearRules } from '../helpers/db';
import type { Finding, RuleKind } from '@/lib/types';

const CATEGORY = 'security';
const RULE_ACTIVITY = 'test-175-activity-rule';
const RULE_STATE = 'test-175-state-rule';
const RULE_FUTURE = 'test-175-future-kind-rule';
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

function activityFinding(dimensionKey: string, overrides: Partial<Finding> = {}): Finding {
  return {
    module: CATEGORY,
    ruleId: RULE_ACTIVITY,
    fingerprint: computeActivityFingerprint(RULE_ACTIVITY, dimensionKey),
    kind: 'activity',
    dimensionKey,
    severity: 'high',
    category: CATEGORY,
    subscriptionId: 'sub-1',
    title: 'test activity finding',
    description: 'test',
    evidence: {},
    recommendation: 'investigate',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function stateFinding(resourceSuffix: string, overrides: Partial<Finding> = {}): Finding {
  const resourceId = `/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${resourceSuffix}`;
  return {
    module: CATEGORY,
    ruleId: RULE_STATE,
    fingerprint: computeFingerprint(RULE_STATE, resourceId),
    severity: 'high',
    category: CATEGORY,
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: resourceSuffix,
    subscriptionId: 'sub-1',
    title: 'test state finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A finding of a kind that does not exist yet (stands in for 'advisory', ADR 0005). Built on a
 *  resource id like a state finding so its fingerprint is well-formed, then the kind is
 *  overwritten past the type system since RuleKind has no third member today. */
function futureKindFinding(resourceSuffix: string, overrides: Partial<Finding> = {}): Finding {
  const resourceId = `/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${resourceSuffix}`;
  return {
    module: CATEGORY,
    ruleId: RULE_FUTURE,
    fingerprint: computeFingerprint(RULE_FUTURE, resourceId),
    kind: 'advisory' as unknown as RuleKind,
    severity: 'high',
    category: CATEGORY,
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: resourceSuffix,
    subscriptionId: 'sub-1',
    title: 'test future-kind finding',
    description: 'test',
    evidence: {},
    recommendation: 'investigate',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
});

describe('computeWidgetSummary (issue #175)', () => {
  it('severityCounts/activeFindings/newInWindow count the state finding, not the activity or future-kind one', async () => {
    const activity = activityFinding('principal-a');
    const state = stateFinding('vm-1');
    const future = futureKindFinding('vm-2');
    await syncScanFindings({
      scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_ACTIVITY, RULE_STATE, RULE_FUTURE],
      findings: [activity, state, future], finishedAt: daysAgo(1),
    });

    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30);

    expect(summary.current.activeFindings).toBe(1);
    expect(summary.current.severityCounts.high).toBe(1);
    expect(summary.current.newInWindow).toBe(1);
  });
});

describe('getFindingEventCounts (issue #175)', () => {
  it('counts the state "created" event, not the activity or future-kind one', async () => {
    const activity = activityFinding('principal-a');
    const state = stateFinding('vm-1');
    const future = futureKindFinding('vm-2');
    const day = daysAgo(2);
    await syncScanFindings({
      scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_ACTIVITY, RULE_STATE, RULE_FUTURE],
      findings: [activity, state, future], finishedAt: day,
    });

    const counts = await getFindingEventCounts({ sinceDate: daysAgo(5).slice(0, 10) });
    const totalCreated = counts.reduce((n, c) => n + c.created, 0);
    expect(totalCreated).toBe(1);
  });
});

describe('upsertDailySnapshot (issue #175)', () => {
  it('activeFindings/severityCounts on the written row reflect the state finding, not the activity or future-kind one', async () => {
    const activity = activityFinding('principal-a');
    const state = stateFinding('vm-1');
    const future = futureKindFinding('vm-2');
    await syncScanFindings({
      scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_ACTIVITY, RULE_STATE, RULE_FUTURE],
      findings: [activity, state, future], finishedAt: daysAgo(1),
    });

    await upsertDailySnapshot(CATEGORY);
    const today = new Date().toISOString().slice(0, 10);
    const row = (await getSnapshots({ categories: [CATEGORY] })).find(s => s.date === today);

    expect(row, 'upsertDailySnapshot did not write today\'s row').toBeDefined();
    expect(row!.activeFindings).toBe(1);
    expect(row!.severityCounts.high).toBe(1);
  });
});
