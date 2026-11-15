/**
 * Dashboard denominator honesty under posture formula v3. A Severity filter keeps every counted rule
 * in the count and changes only which findings make a rule fail ("Option A"); a tag filter narrows the
 * rules, as category and rule do; and a rule counts only when its own scope overlaps the Scopes the
 * viewer holds, narrowed by the subscription and resource group filter (`lib/rule-overlap.ts`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { syncScanFindings } from '@/lib/db/findings';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { resetDb, clearRules } from '../helpers/db';
import type { Finding, QueryBackend, RuleScope, Severity } from '@/lib/types';
import { buildAccess, type ScopeGrant } from '@/lib/access-model';
import { EVERYTHING_ACCESS } from '../helpers/access';

const CATEGORY = 'security';
const RULE_HIGH = 'test-rule-high';
const RULE_MEDIUM = 'test-rule-medium';
const RULE_TAGGED = 'test-rule-tagged';
const RULE_UNTAGGED = 'test-rule-untagged';

interface RuleOverrides {
  severity?: Severity;
  tags?: string[];
  scope?: RuleScope;
  enabled?: boolean;
  queryBackend?: QueryBackend;
}

async function insertRule(id: string, overrides: RuleOverrides = {}): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: CATEGORY,
    severity: overrides.severity ?? 'medium',
    tags: overrides.tags?.length ? JSON.stringify(overrides.tags) : null,
    enabled: overrides.enabled ?? true,
    scope: JSON.stringify(overrides.scope ?? { level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom',
    lastRunStatus: 'success',
    kind: 'state',
    queryBackend: overrides.queryBackend ?? 'resource-graph',
  }));
}

function finding(ruleId: string, resourceSuffix: string, severity: Severity = 'medium'): Finding {
  const resourceId = `/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${resourceSuffix}`;
  return {
    module: CATEGORY,
    ruleId,
    fingerprint: computeFingerprint(ruleId, resourceId),
    severity,
    category: CATEGORY,
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: resourceSuffix,
    subscriptionId: 'sub-1',
    resourceGroup: 'rg1',
    title: 'test finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
  };
}

describe('dashboard denominator honesty: a Severity filter changes who fails, not who is counted', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule(RULE_HIGH, { severity: 'high' });
    await insertRule(RULE_MEDIUM, { severity: 'medium' });

    await syncScanFindings({
      scanId: 's1',
      category: CATEGORY,
      ranRuleIds: [RULE_HIGH, RULE_MEDIUM],
      findings: [finding(RULE_HIGH, 'vm-1', 'high')],
      finishedAt: new Date().toISOString(),
    });
  });

  it('with no severity filter, totalRules counts both rules and passingRules counts only the clean one', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS);

    expect(summary.current.totalRules).toBe(2);
    expect(summary.current.passingRules).toBe(1);
  });

  it('filtering by severity:high keeps both rules in the count, and only the rule with a High finding fails', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], severities: ['high'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );

    expect(summary.current.totalRules).toBe(2);
    expect(summary.current.passingRules).toBe(1);
  });

  it('a rule whose only finding is of another severity passes under the filter', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], severities: ['critical'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );

    expect(summary.current.totalRules).toBe(2);
    expect(summary.current.passingRules).toBe(2);
  });

  it('the same count applies to perCategory, which the pct is rounded from', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], severities: ['high'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );
    const mod = summary.perCategory.find(m => m.category === CATEGORY);

    expect(mod).toBeDefined();
    expect(mod!.total).toBe(2);
    expect(mod!.passing).toBe(1);
    expect(mod!.pct).toBe(50);
  });
});

describe('dashboard denominator honesty: tag filter narrows the counted rules', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule(RULE_TAGGED, { tags: ['pci'] });
    await insertRule(RULE_UNTAGGED, {});

    await syncScanFindings({
      scanId: 's1',
      category: CATEGORY,
      ranRuleIds: [RULE_TAGGED, RULE_UNTAGGED],
      findings: [],
      finishedAt: new Date().toISOString(),
    });
  });

  it('filtering by tag narrows totalRules to just the tagged rule', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], tags: ['pci'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );

    expect(summary.current.totalRules).toBe(1);
    expect(summary.current.passingRules).toBe(1);
  });
});

describe('dashboard denominator honesty: a resource group filter counts the rules whose scope overlaps its subscription', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule(RULE_HIGH, { severity: 'high' });
    await insertRule(RULE_MEDIUM, { severity: 'medium' });

    await syncScanFindings({
      scanId: 's1',
      category: CATEGORY,
      ranRuleIds: [RULE_HIGH, RULE_MEDIUM],
      findings: [finding(RULE_HIGH, 'vm-1', 'high')],
      finishedAt: new Date().toISOString(),
    });
  });

  it('a resourceGroups-only filter leaves totalRules at the full count of rules that look at that group', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], resourceGroups: ['rg1'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );

    expect(summary.current.totalRules).toBe(2);
  });

  it('a rule scoped to a different subscription drops out under a resource group filter', async () => {
    await insertRule('test-rule-elsewhere', { scope: { level: 'subscription', subscriptions: ['sub-2'] } });
    await insertRule('test-rule-here', { scope: { level: 'subscription', subscriptions: ['sub-1'] } });

    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], resourceGroups: ['rg1'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );

    expect(summary.current.totalRules).toBe(3);
  });

  it('a resource group no finding has ever sat in is looked at by every rule the viewer holds, not by none', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], resourceGroups: ['rg-nobody-has'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );

    expect(summary.current.totalRules).toBe(2);
    expect(summary.current.passingRules).toBe(2);
  });

  it('fixing the last finding in a resource group keeps its rules counted and turns the tile to all passing', async () => {
    await insertRule('test-rule-elsewhere', { scope: { level: 'subscription', subscriptions: ['sub-2'] } });
    await syncScanFindings({
      scanId: 's2',
      category: CATEGORY,
      ranRuleIds: [RULE_HIGH, RULE_MEDIUM],
      findings: [],
      finishedAt: new Date().toISOString(),
    });

    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], resourceGroups: ['rg1'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );

    expect(summary.current.totalRules).toBe(2);
    expect(summary.current.passingRules).toBe(2);
  });
});

const oneSubscription = (sub: string): ScopeGrant =>
  ({ tenantId: 't', scope: { kind: 'subscription', path: `/subscriptions/${sub}` }, role: 'viewer' });
const directory: ScopeGrant = { tenantId: 't', scope: { kind: 'directory', path: '@directory' }, role: 'viewer' };

describe('live posture counts only the rules that can look at what the viewer holds', () => {
  const window = { mode: 'relative', days: 7 } as const;

  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule('rule-unscoped');
    await insertRule('rule-sub-1', { scope: { level: 'subscription', subscriptions: ['sub-1'] } });
    await insertRule('rule-sub-2', { scope: { level: 'subscription', subscriptions: ['sub-2'] } });
    await insertRule('rule-graph', { queryBackend: 'microsoft-graph' });
    await syncScanFindings({
      scanId: 's1',
      category: CATEGORY,
      ranRuleIds: ['rule-unscoped', 'rule-sub-1', 'rule-sub-2', 'rule-graph'],
      findings: [finding('rule-sub-1', 'vm-1')],
      finishedAt: new Date().toISOString(),
    });
  });

  it('a one-subscription holder\'s total leaves out a rule scoped to another subscription and the Graph rule', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: window }, buildAccess([oneSubscription('sub-1')], 'manual'));

    expect(summary.current.totalRules).toBe(2);
    expect(summary.current.passingRules).toBe(1);
    const mod = summary.perCategory.find(m => m.category === CATEGORY);
    expect(mod!.total).toBe(2);
  });

  it('someone without the Directory has no Graph rules counted, and someone with it does', async () => {
    const without = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: window }, buildAccess([oneSubscription('sub-1')], 'manual'));
    const withDirectory = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: window }, buildAccess([oneSubscription('sub-1'), directory], 'manual'));

    expect(withDirectory.current.totalRules - without.current.totalRules).toBe(1);
  });

  it('Everything counts every enabled Problem rule, whatever its scope', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: window }, EVERYTHING_ACCESS);

    expect(summary.current.totalRules).toBe(4);
    expect(summary.current.passingRules).toBe(3);
  });

  it('the subscription filter narrows the Scopes the same way', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], subscriptions: ['sub-2'], dateWindow: window }, EVERYTHING_ACCESS);

    expect(summary.current.totalRules).toBe(2);
  });
});

describe('a rule-scoped widget counts only the rules it names that exist and are enabled', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule('rule-live');
    await insertRule('rule-disabled', { enabled: false });
    await syncScanFindings({
      scanId: 's1',
      category: CATEGORY,
      ranRuleIds: ['rule-live', 'rule-disabled'],
      findings: [],
      finishedAt: new Date().toISOString(),
    });
  });

  it('a deleted id and a disabled id count neither', async () => {
    const summary = await computeWidgetSummary(
      { ruleIds: ['rule-live', 'rule-deleted', 'rule-disabled'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );

    expect(summary.current.totalRules).toBe(1);
    expect(summary.current.passingRules).toBe(1);
  });

  it('a selection of nothing that exists reads empty, not 100', async () => {
    const summary = await computeWidgetSummary(
      { ruleIds: ['rule-deleted'], dateWindow: { mode: 'relative', days: 7 } }, EVERYTHING_ACCESS,
    );

    expect(summary.current.totalRules).toBe(0);
    expect(summary.current.pct).toBeNull();
  });
});
