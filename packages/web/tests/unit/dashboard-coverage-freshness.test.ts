/**
 * The Scan Coverage widget says a category is incomplete from the rules whose last run did not finish,
 * not from the single newest scan. A category scanned a moment ago can still have a rule that failed, and
 * the row says so with one signal: the count link. The summary is read through computeWidgetSummary and
 * the row is rendered from it.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { computeWidgetSummary, type WidgetSummary } from '@/lib/dashboard-data';
import { CoverageFreshnessWidget } from '@/components/dashboard/widgets/coverage-freshness-widget';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, TEST_SUB_A } from '../helpers/fake-azure';
import { EVERYTHING_ACCESS } from '../helpers/access';

let summary: WidgetSummary | null = null;

vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: summary, loading: false, failed: false, retry: () => undefined }),
}));

const FILTERS = { categories: ['security'], dateWindow: { mode: 'relative' as const, days: 7 } };

async function renderRow(): Promise<string> {
  summary = await computeWidgetSummary(FILTERS, EVERYTHING_ACCESS);
  return renderToStaticMarkup(createElement(CoverageFreshnessWidget, { config: {}, filters: FILTERS, refreshKey: 0 }));
}

const RULE_OK = 'test-rule-ok';
const RULE_FAIL = 'test-rule-fail';
const MARKER_OK = '// marker-ok';
const MARKER_FAIL = '// marker-fail';

async function insertRule(id: string, marker: string): Promise<void> {
  await execRun(db.insert(rulesTable).values({
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
  }));
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

describe('coverage-freshness widget data', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule(RULE_OK, MARKER_OK);
    await insertRule(RULE_FAIL, MARKER_FAIL);
  });

  async function scan(behavior: QueryBehavior): Promise<void> {
    const category = (await getCategory('security'))!;
    await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx: makeCtx(behavior), ruleIds: [RULE_OK, RULE_FAIL] });
  }

  it('counts the failed rule after a mixed scan, and the row says "1 rule incomplete" and no "Partial"', async () => {
    await scan({
      [MARKER_OK]: { rows: [argRow({ name: 'vm-ok' })] },
      [MARKER_FAIL]: { failWith: new Error('429 Too Many Requests') },
    });
    const html = await renderRow();
    const security = summary!.perCategory.find(c => c.category === 'security')!;
    expect(security.incompleteRuleCount).toBe(1);
    expect(security).not.toHaveProperty('lastScanCoverage');
    expect(html).toContain('>1 rule incomplete<');
    expect(html).not.toContain('Partial');
    expect(html).not.toContain('title=');
  });

  it('counts nothing and shows no badge after a fully clean scan', async () => {
    await scan({ [MARKER_OK]: { rows: [argRow({ name: 'vm-ok' })] }, [MARKER_FAIL]: { rows: [] } });
    const html = await renderRow();
    expect(summary!.perCategory.find(c => c.category === 'security')!.incompleteRuleCount).toBe(0);
    expect(html).not.toContain('incomplete<');
    expect(html).not.toContain('Partial');
  });

  it('counts nothing for a category that has never been scanned', async () => {
    const html = await renderRow();
    expect(summary!.perCategory.find(c => c.category === 'security')!.incompleteRuleCount).toBe(0);
    expect(html).not.toContain('Partial');
  });

  it('counts a rule that failed in an earlier scan even when the newest scan was complete for other rules', async () => {
    await scan({ [MARKER_OK]: { rows: [] }, [MARKER_FAIL]: { failWith: new Error('boom') } });
    const category = (await getCategory('security'))!;
    await runCategoryScan(category, { access: EVERYTHING_ACCESS, ctx: makeCtx({ [MARKER_OK]: { rows: [] } }), ruleIds: [RULE_OK] });
    await renderRow();
    expect(summary!.perCategory.find(c => c.category === 'security')!.incompleteRuleCount).toBe(1);
  });
});
