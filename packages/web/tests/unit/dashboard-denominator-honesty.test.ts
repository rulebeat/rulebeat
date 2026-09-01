/**
 * Spec 039 — dashboard denominator and suppression honesty (RB-RM-015/RB-RM-016).
 *
 * RB-RM-015: a widget filtered by severity or tag already narrows which findings count as
 * violations (the numerator, via matchesFilters) but historically did NOT narrow which rules
 * count as "in scope" (the denominator, via enabledRuleIdsForCategory) — a rule whose only
 * violation got filtered out read as passing, when it was never evaluated at that scope at all.
 * See enabledRuleIdsForCategory() in lib/dashboard-data.ts.
 *
 * RB-RM-016: WidgetSummary.suppressedIncluded self-describes whether filters.includeSuppressed
 * was honored, so a future caller (no current dashboard UI can set this flag yet) doesn't have to
 * separately track which mode produced a given response.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { rules as rulesTable } from '@/lib/db/schema';
import { syncScanFindings } from '@/lib/db/findings';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { resetDb, clearRules } from '../helpers/db';
import type { Finding, Severity } from '@/lib/types';

const CATEGORY = 'security';
const RULE_HIGH = 'test-rule-high';
const RULE_MEDIUM = 'test-rule-medium';
const RULE_TAGGED = 'test-rule-tagged';
const RULE_UNTAGGED = 'test-rule-untagged';

function insertRule(id: string, overrides: { severity?: Severity; tags?: string[] } = {}): void {
  db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: CATEGORY,
    severity: overrides.severity ?? 'medium',
    tags: overrides.tags?.length ? JSON.stringify(overrides.tags) : null,
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom',
    lastRunStatus: 'success',
    kind: 'state',
    queryBackend: 'resource-graph',
  }).run();
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
    title: 'test finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
  };
}

describe('dashboard denominator honesty: severity/tag filters narrow rule scope, not just findings (spec 039, RB-RM-015)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    insertRule(RULE_HIGH, { severity: 'high' });
    insertRule(RULE_MEDIUM, { severity: 'medium' });

    await syncScanFindings({
      scanId: 's1',
      category: CATEGORY,
      ranRuleIds: [RULE_HIGH, RULE_MEDIUM],
      findings: [finding(RULE_HIGH, 'vm-1', 'high')],
      finishedAt: new Date().toISOString(),
    });
  });

  it('with no severity filter, totalRules counts both rules and passingRules counts only the clean one', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30);

    expect(summary.current.totalRules).toBe(2);
    expect(summary.current.passingRules).toBe(1);
  });

  it('filtering by severity:high narrows totalRules to just the high-severity rule, not the whole category', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], severities: ['high'], dateWindow: { mode: 'relative', days: 7 } },
      30,
    );

    // Before the fix, totalRules stayed 2 (the medium rule still counted toward the denominator
    // even though it can never appear as a violation under this filter) and passingRules read 1
    // (the medium rule, which has zero findings, read as "passing" despite never being in scope).
    expect(summary.current.totalRules).toBe(1);
    expect(summary.current.passingRules).toBe(0);
  });

  it('the same narrowing applies to perCategory, which the pct is rounded from', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], severities: ['high'], dateWindow: { mode: 'relative', days: 7 } },
      30,
    );
    const mod = summary.perCategory.find(m => m.category === CATEGORY);

    expect(mod).toBeDefined();
    expect(mod!.total).toBe(1);
    expect(mod!.passing).toBe(0);
    expect(mod!.pct).toBe(0);
  });
});

describe('dashboard denominator honesty: tag filter narrows rule scope the same way (spec 039, RB-RM-015)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    insertRule(RULE_TAGGED, { tags: ['pci'] });
    insertRule(RULE_UNTAGGED, {});

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
      { categories: [CATEGORY], tags: ['pci'], dateWindow: { mode: 'relative', days: 7 } },
      30,
    );

    expect(summary.current.totalRules).toBe(1);
    expect(summary.current.passingRules).toBe(1);
  });
});

describe('dashboard denominator honesty: resourceGroups/subscriptions are deliberately NOT applied to the denominator (spec 039 §2, out of scope)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    insertRule(RULE_HIGH, { severity: 'high' });
    insertRule(RULE_MEDIUM, { severity: 'medium' });

    await syncScanFindings({
      scanId: 's1',
      category: CATEGORY,
      ranRuleIds: [RULE_HIGH, RULE_MEDIUM],
      findings: [finding(RULE_HIGH, 'vm-1', 'high')],
      finishedAt: new Date().toISOString(),
    });
  });

  it('a resourceGroups-only filter leaves totalRules at the full category count', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], resourceGroups: ['rg1'], dateWindow: { mode: 'relative', days: 7 } },
      30,
    );

    expect(summary.current.totalRules).toBe(2);
  });
});

describe('WidgetSummary.suppressedIncluded self-describes which mode produced the numbers (spec 039, RB-RM-016)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    insertRule(RULE_HIGH, { severity: 'high' });
  });

  it('is false when filters.includeSuppressed is omitted', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 7 } }, 30);

    expect(summary.suppressedIncluded).toBe(false);
  });

  it('is true when filters.includeSuppressed is true', async () => {
    const summary = await computeWidgetSummary(
      { categories: [CATEGORY], includeSuppressed: true, dateWindow: { mode: 'relative', days: 7 } },
      30,
    );

    expect(summary.suppressedIncluded).toBe(true);
  });
});
