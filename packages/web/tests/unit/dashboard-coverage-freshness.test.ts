/**
 * Spec 004 — the posture-freshness dashboard widget must surface a category's most recent
 * scan coverage, not just how long ago it ran. A category can be freshly scanned and still have a
 * rule that failed or was capped — the widget's data source (computeWidgetSummary) needs to expose
 * that alongside lastScanAt, or the widget has nothing to render it from.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { rules as rulesTable } from '@/lib/db/schema';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';

const RULE_OK = 'test-rule-ok';
const RULE_FAIL = 'test-rule-fail';
const MARKER_OK = '// marker-ok';
const MARKER_FAIL = '// marker-fail';

function insertRule(id: string, marker: string): void {
  db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: 'security',
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" ${marker}`,
    type: 'custom',
  }).run();
}

type QueryBehavior = Record<string, { rows?: Record<string, unknown>[]; failWith?: Error }>;

function makeCtx(behavior: QueryBehavior): TenantContext {
  return {
    tenantId: 'test-tenant',
    subscriptionIds: [TEST_SUB_A],
    credential: {} as TokenCredential,
    log: () => {},
    async graphGet<TValue = Record<string, unknown>>(): Promise<TValue[]> {
      throw new Error('test ctx: graphGet should not be called in this ARG-only suite');
    },
    async queryLogs<TRow = Record<string, unknown>>(): Promise<TRow[]> {
      throw new Error('test ctx: queryLogs should not be called in this ARG-only suite');
    },
    async queryARG<TRow = Record<string, unknown>>(kql: string): Promise<TRow[]> {
      const marker = Object.keys(behavior).find(m => kql.includes(m));
      if (!marker) throw new Error(`test ctx: no behavior registered for query: ${kql}`);
      const b = behavior[marker]!;
      if (b.failWith) throw b.failWith;
      return (b.rows ?? []) as TRow[];
    },
  };
}

describe('coverage-freshness widget data (spec 004)', () => {
  beforeEach(() => {
    resetDb();
    clearRules();
    insertRule(RULE_OK, MARKER_OK);
    insertRule(RULE_FAIL, MARKER_FAIL);
  });

  it('reports the security category as partial, with the failed rule named, after a mixed scan', async () => {
    const category = getCategory('security')!;
    await runCategoryScan(category, {
      ctx: makeCtx({
        [MARKER_OK]: { rows: [argRow({ name: 'vm-ok' })] },
        [MARKER_FAIL]: { failWith: new Error('429 Too Many Requests') },
      }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });

    const summary = computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30);
    const security = summary.perCategory.find(c => c.category === 'security');

    expect(security?.lastScanCoverage).toBe('partial');
    expect(security?.lastScanIncompleteRules).toEqual([{ ruleId: RULE_FAIL, ruleName: RULE_FAIL, status: 'failed' }]);
  });

  it('reports complete coverage and no incomplete rules after a fully clean scan', async () => {
    const category = getCategory('security')!;
    await runCategoryScan(category, {
      ctx: makeCtx({
        [MARKER_OK]: { rows: [argRow({ name: 'vm-ok' })] },
        [MARKER_FAIL]: { rows: [] },
      }),
      ruleIds: [RULE_OK, RULE_FAIL],
    });

    const summary = computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30);
    const security = summary.perCategory.find(c => c.category === 'security');

    expect(security?.lastScanCoverage).toBe('complete');
    expect(security?.lastScanIncompleteRules).toEqual([]);
  });

  it('reports null coverage for a category that has never been scanned', () => {
    const summary = computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30);
    const security = summary.perCategory.find(c => c.category === 'security');

    expect(security?.lastScanCoverage).toBeNull();
    expect(security?.lastScanIncompleteRules).toEqual([]);
  });
});
