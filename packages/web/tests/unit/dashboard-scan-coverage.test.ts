/**
 * Scan Coverage: the incomplete-rule count and Last scanned follow what the viewer holds. The count is
 * the length of the Rules list its link opens, for Everything and for someone who holds one subscription;
 * a rule that never ran is not incomplete; and Last scanned is read from scans, not from trend points.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { loadRules } from '@/lib/rules';
import { listHierarchyNodes } from '@/lib/db/management-group-hierarchy';
import { upsertDailySnapshot } from '@/lib/db/snapshots';
import { computeWidgetSummary, type WidgetSummary } from '@/lib/dashboard-data';
import { CoverageFreshnessWidget } from '@/components/dashboard/widgets/coverage-freshness-widget';
import { saveScanResult } from '@/lib/scan-history';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { ruleIdsInReach } from '@/lib/rule-overlap';
import { incompleteRulesHref, matchesRulesTabFilter, readRulesTabFilter } from '@/lib/rules-tab-query';
import type { CoveredEntry } from '@/lib/run-scope';
import { emptySeverityCounts } from '@/lib/severity';
import type { QueryBackend, RuleExecutionStatus } from '@rulebeat/core';
import { resetDb, clearRules } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';

let widgetSummary: WidgetSummary | null = null;

vi.mock('@/lib/hooks/use-widget-fetch', () => ({
  useWidgetFetch: () => ({ data: widgetSummary, loading: false, failed: false, retry: () => undefined }),
}));

/** The freshness badge the widget renders for the security row, from the summary the viewer is served. */
async function freshnessShownTo(access: Access): Promise<string> {
  widgetSummary = await computeWidgetSummary(FILTERS, access);
  const html = renderToStaticMarkup(createElement(CoverageFreshnessWidget, { config: {}, filters: FILTERS, refreshKey: 0 }));
  return /(Fresh|Recent|Stale|Never scanned)<\/span>/.exec(html)![1]!;
}

const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const holder: Access = buildAccess([{ tenantId: 't', scope: parseScope(`/subscriptions/${SUB_A}`)!, role: 'viewer' }], 'manual');
const FILTERS = { categories: ['security'], dateWindow: { mode: 'relative' as const, days: 7 } };

interface RuleSeed {
  id: string; enabled?: boolean; status?: RuleExecutionStatus; subscriptions?: string[];
  queryBackend?: QueryBackend; category?: string;
}

async function insertRule(seed: RuleSeed): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id: seed.id, name: seed.id, description: 'test rule', category: seed.category ?? 'security', severity: 'medium',
    enabled: seed.enabled ?? true,
    scope: JSON.stringify({ level: 'subscription', ...(seed.subscriptions ? { subscriptions: seed.subscriptions } : {}) }),
    resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom', kind: seed.queryBackend === 'log-analytics' ? 'activity' : 'state',
    queryBackend: seed.queryBackend ?? 'resource-graph', lastRunStatus: seed.status ?? null,
  }));
}

async function saveScan(id: string, finishedAt: string, covered: CoveredEntry[] | null): Promise<void> {
  await saveScanResult('security', {
    id, module: 'security', startedAt: finishedAt, finishedAt, durationMs: 1, subscriptionsScanned: [], findings: [],
    counts: emptySeverityCounts(), totalRules: 1, coverage: 'complete', incompleteRules: [],
  }, { id, ...(covered ? { coveredScope: covered } : {}) });
}

describe('Scan Coverage counts the rules whose last run did not finish', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    await insertRule({ id: 'failed-in-a', status: 'failed', subscriptions: [SUB_A] });
    await insertRule({ id: 'capped-in-b', status: 'capped', subscriptions: [SUB_B] });
    await insertRule({ id: 'invalid-everywhere', status: 'invalid' });
    await insertRule({ id: 'activity-failed', status: 'failed', queryBackend: 'log-analytics' });
    await insertRule({ id: 'directory-failed', status: 'failed', queryBackend: 'microsoft-graph' });
    await insertRule({ id: 'disabled-failed-in-a', status: 'failed', enabled: false, subscriptions: [SUB_A] });
    await insertRule({ id: 'never-run', subscriptions: [SUB_A] });
    await insertRule({ id: 'succeeded', status: 'success', subscriptions: [SUB_A] });
    await insertRule({ id: 'failed-elsewhere', status: 'failed', category: 'cost' });
  });

  async function opened(access: Access) {
    const summary = await computeWidgetSummary(FILTERS, access);
    const category = summary.perCategory.find(c => c.category === 'security')!;
    const href = incompleteRulesHref('security', summary.holdsEverything);
    const filter = readRulesTabFilter(new URL(href, 'http://localhost').searchParams);
    const rules = await loadRules();
    const reach = access.everything ? undefined : ruleIdsInReach(rules, access, await listHierarchyNodes());
    const list = rules.filter(r => matchesRulesTabFilter(r, filter, reach)).map(r => r.id).sort();
    return { count: category.incompleteRuleCount, href, list };
  }

  it('equals the length of the Rules list it opens, for Everything', async () => {
    const { count, list } = await opened(EVERYTHING_ACCESS);
    expect(list).toEqual(['activity-failed', 'capped-in-b', 'directory-failed', 'failed-in-a', 'invalid-everywhere']);
    expect(count).toBe(list.length);
  });

  it('equals the length of the Rules list it opens, for someone who holds one subscription', async () => {
    const { count, list, href } = await opened(holder);
    expect(list).toEqual(['activity-failed', 'failed-in-a', 'invalid-everywhere']);
    expect(count).toBe(list.length);
    expect(new URL(href, 'http://localhost').searchParams.get('reach')).toBe('yours');
  });

  it('asks for reach only of someone without Everything, and for the enabled, unfinished rules of the category', async () => {
    const everything = new URL((await opened(EVERYTHING_ACCESS)).href, 'http://localhost').searchParams;
    expect(everything.get('reach')).toBeNull();
    expect(everything.get('tab')).toBe('rules');
    expect(everything.get('category')).toBe('security');
    expect(everything.get('status')).toBe('enabled');
    expect(everything.get('lastRun')).toBe('failed|capped|invalid');
  });

  it('does not count a rule that has never run, and counts nothing for a category with none unfinished', async () => {
    await execRun(db.delete(rulesTable));
    await insertRule({ id: 'never-run' });
    await insertRule({ id: 'succeeded', status: 'success' });
    expect((await opened(EVERYTHING_ACCESS)).count).toBe(0);
  });

  it('ignores the rule, tag and subscription filters', async () => {
    const summary = await computeWidgetSummary({ ...FILTERS, ruleIds: ['succeeded'], subscriptions: [SUB_B] }, EVERYTHING_ACCESS);
    expect(summary.perCategory.find(c => c.category === 'security')!.incompleteRuleCount).toBe(5);
  });
});

describe('Last scanned follows what the viewer holds', () => {
  let tenDaysAgo: string;
  let yesterday: string;

  beforeEach(async () => {
    await resetDb();
    tenDaysAgo = ago(10);
    yesterday = ago(0.5);
    await saveScan('old-a', tenDaysAgo, [{ tenantId: 't', path: `/subscriptions/${SUB_A}` }]);
    await saveScan('new-b', yesterday, [{ tenantId: 't', path: `/subscriptions/${SUB_B}` }]);
  });

  it('reads the older scan of the subscription they hold, while Everything reads the newer scan', async () => {
    const scoped = await computeWidgetSummary(FILTERS, holder);
    expect(scoped.perCategory.find(c => c.category === 'security')!.lastScanAt).toBe(tenDaysAgo);
    expect(scoped.lastScanAt).toBe(tenDaysAgo);
    const everything = await computeWidgetSummary(FILTERS, EVERYTHING_ACCESS);
    expect(everything.perCategory.find(c => c.category === 'security')!.lastScanAt).toBe(yesterday);
    expect(everything.lastScanAt).toBe(yesterday);
  });

  it('reads Stale for the scoped person and Fresh for Everything, as the widget renders them', async () => {
    expect(await freshnessShownTo(holder)).toBe('Stale');
    expect(await freshnessShownTo(EVERYTHING_ACCESS)).toBe('Fresh');
  });

  it('counts a scan from before covered scopes were recorded (null) for the scoped person', async () => {
    await resetDb();
    await saveScan('pre-276', ago(0.25), null);
    expect(await freshnessShownTo(holder)).toBe('Fresh');
  });

  it('is never read from a trend point\'s time', async () => {
    await resetDb();
    await upsertDailySnapshot('security', new Date());
    const summary = await computeWidgetSummary(FILTERS, EVERYTHING_ACCESS);
    expect(summary.perCategory.find(c => c.category === 'security')!.lastScanAt).toBeNull();
    expect(summary.lastScanAt).toBeNull();
    expect(await freshnessShownTo(EVERYTHING_ACCESS)).toBe('Never scanned');
  });
});
