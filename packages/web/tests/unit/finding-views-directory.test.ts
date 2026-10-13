/**
 * #271: a Directory finding (a Microsoft Graph finding, stored with an empty subscription) is not under
 * any subscription, and is one choice of its own wherever a subscription is filtered, faceted, grouped or
 * shown. Driven through the same seams the screens use: the view and export routes, the filter options,
 * the group read and the dashboard's data functions, over findings stored by a scan.
 *
 * Before placement a Graph finding carried the first subscription the credential listed, so a view or
 * widget filtered to that subscription counted it.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { emptyView, viewToSearchParams, type View } from '@/lib/finding-view';
import { queryFilterOptions, queryGroup, queryView } from '@/lib/db/finding-views';
import { getActivityOccurrenceCounts, getFindingEventCounts } from '@/lib/db/findings';
import { getSnapshots, upsertDailySnapshot } from '@/lib/db/snapshots';
import { computeWidgetSummary, queryActiveFindings } from '@/lib/dashboard-data';
import { DIRECTORY_SUBSCRIPTION } from '@/lib/placement';
import type { ViewTab } from '@/lib/view-response';
import { EVERYTHING_ACCESS } from '../helpers/access';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));
const exportRoute = await import('@/app/api/findings/export/route');

const SUB_A = '11111111-1111-1111-1111-111111111111';
const SUB_B = '22222222-2222-2222-2222-222222222222';
const ARM_RULE = 'dir-arm-rule';
const GRAPH_RULE = 'dir-graph-rule';
const ADVISORY_RULE = 'dir-advisory-rule';
const LOGS_RULE = 'dir-logs-rule';

beforeAll(async () => {
  await resetDb();
  await storeScan([
    syntheticFinding('vm-a', [{ n: 1 }], { ruleId: ARM_RULE, subscriptionId: SUB_A }),
    syntheticFinding('vm-b', [{ n: 2 }], { ruleId: ARM_RULE, subscriptionId: SUB_B }),
    syntheticFinding('app-1', [{ n: 3 }], { ruleId: GRAPH_RULE, placement: 'directory' }),
    syntheticFinding('app-2', [{ n: 4 }], { ruleId: GRAPH_RULE, placement: 'directory' }),
    syntheticFinding('app-3', [{ n: 5 }], { ruleId: ADVISORY_RULE, placement: 'directory', kind: 'advisory' }),
    syntheticFinding('vm-adv', [{ n: 6 }], { ruleId: ADVISORY_RULE, subscriptionId: SUB_A, kind: 'advisory' }),
    syntheticFinding('user-1', [{ n: 7 }], { ruleId: LOGS_RULE, subscriptionId: SUB_A, kind: 'activity' }),
  ], { scanId: 'directory-scan', finishedAt: new Date().toISOString() });
});

const withSubscription = (...values: string[]): View => ({ ...emptyView(), filters: [{ field: 'subscription', values }] });
const query = (tab: ViewTab) => ({ tab, showSuppressed: false });
const names = (response: Awaited<ReturnType<typeof queryView>>) => response.items.map(i => i.finding.resourceName).sort();

describe('a subscription filter does not count Directory findings', () => {
  it('lists only the findings under the subscription on the Results tab', async () => {
    expect(names(await queryView(withSubscription(SUB_A), query('results'), EVERYTHING_ACCESS))).toEqual(['vm-a']);
  });

  it('lists none of them on the Advisories tab', async () => {
    expect(names(await queryView(withSubscription(SUB_A), query('advisories'), EVERYTHING_ACCESS))).toEqual(['vm-adv']);
  });

  it('keeps them out of the Activity tab', async () => {
    expect(names(await queryView(withSubscription(SUB_B), query('activity'), EVERYTHING_ACCESS))).toEqual([]);
  });

  it('keeps them out of an export', async () => {
    mockRequireRole.mockResolvedValue({ id: 'viewer', access: EVERYTHING_ACCESS });
    const params = viewToSearchParams(withSubscription(SUB_A), { tab: 'results' });
    const res = await exportRoute.GET(new Request(`http://localhost/api/findings/export?${params}&format=json`));
    const exported = await res.json() as { resourceName: string }[];
    expect(exported.map(f => f.resourceName)).toEqual(['vm-a']);
  });
});

describe('Directory is one choice in the subscription filter', () => {
  it('returns exactly the Directory findings when chosen', async () => {
    const response = await queryView(withSubscription(DIRECTORY_SUBSCRIPTION), query('results'), EVERYTHING_ACCESS);
    expect(names(response)).toEqual(['app-1', 'app-2']);
    expect(response.items.every(i => i.finding.subscriptionId === '' && i.finding.placement === 'directory')).toBe(true);
  });

  it('can be chosen with a subscription, and returns the union', async () => {
    expect(names(await queryView(withSubscription(SUB_B, DIRECTORY_SUBSCRIPTION), query('results'), EVERYTHING_ACCESS))).toEqual(['app-1', 'app-2', 'vm-b']);
  });

  it('is one option in the subscription facet, labelled Directory, with its own count', async () => {
    const { facets } = await queryView(withSubscription(SUB_A), query('results'), EVERYTHING_ACCESS);
    expect(facets.subscription).toEqual([
      { value: SUB_A, label: SUB_A, count: 1 },
      { value: SUB_B, label: SUB_B, count: 1 },
      { value: DIRECTORY_SUBSCRIPTION, label: 'Directory', count: 2 },
    ]);
  });

  it('is one group, labelled Directory, when grouping by subscription, and opens to its findings', async () => {
    const view: View = { ...emptyView(), groupBy: ['subscription'] };
    const response = await queryView(view, query('results'), EVERYTHING_ACCESS);
    expect(response.grouped?.groups.map(g => [g.value, g.label, g.findingCount])).toEqual([
      [SUB_A, SUB_A, 1],
      [SUB_B, SUB_B, 1],
      [DIRECTORY_SUBSCRIPTION, 'Directory', 2],
    ]);

    const opened = await queryGroup(view, { ...query('results'), groupPath: [DIRECTORY_SUBSCRIPTION], groupPage: 1 }, EVERYTHING_ACCESS);
    expect(opened.items.map(i => i.finding.resourceName).sort()).toEqual(['app-1', 'app-2']);
  });

  it('is offered by the dashboard filter lists, once, and never as a blank', async () => {
    const options = await queryFilterOptions(EVERYTHING_ACCESS);
    expect(options.subscriptions).toEqual([SUB_A, SUB_B, DIRECTORY_SUBSCRIPTION]);
  });

  it('reads Directory in a CSV export, not a blank or a GUID', async () => {
    mockRequireRole.mockResolvedValue({ id: 'viewer', access: EVERYTHING_ACCESS });
    const params = viewToSearchParams(withSubscription(DIRECTORY_SUBSCRIPTION), { tab: 'results' });
    const csv = await (await exportRoute.GET(new Request(`http://localhost/api/findings/export?${params}&format=csv`))).text();
    const lines = csv.split('\n');
    expect(lines.length).toBe(3);
    // Severity, Title, Resource, ResourceGroup, Location, Subscription: the sixth column.
    for (const line of lines.slice(1)) expect(line.split(',')[5]).toBe('Directory');
  });
});

describe('the dashboard does not count Directory findings under a subscription', () => {
  const since = '2000-01-01';
  const created = async (subscriptions?: string[]) =>
    (await getFindingEventCounts({ sinceDate: since, subscriptions }, EVERYTHING_ACCESS)).reduce((n, d) => n + d.created, 0);

  it('counts new findings of a subscription without them, and of Directory alone', async () => {
    // The Problems the totals count: vm-a, vm-b, app-1 and app-2. Advisories and Activity are not in them.
    expect(await created()).toBe(4);
    expect(await created([SUB_A])).toBe(1);
    expect(await created([DIRECTORY_SUBSCRIPTION])).toBe(2);
    expect(await created([SUB_A, DIRECTORY_SUBSCRIPTION])).toBe(3);
  });

  it('counts Activity occurrences of a subscription without them', async () => {
    const total = async (subscriptions?: string[]) =>
      (await getActivityOccurrenceCounts({ sinceDate: since, subscriptions }, EVERYTHING_ACCESS)).reduce((n, d) => n + d.count, 0);
    expect(await total([SUB_A])).toBe(1);
    expect(await total([DIRECTORY_SUBSCRIPTION])).toBe(0);
  });

  it('counts active findings of a subscription without them, and of Directory alone', async () => {
    const dateWindow = { mode: 'relative', days: 7 } as const;
    expect((await queryActiveFindings({ dateWindow, subscriptions: [SUB_A] }, EVERYTHING_ACCESS)).map(f => f.resourceName).sort()).toEqual(['user-1', 'vm-a', 'vm-adv'].sort());
    expect((await queryActiveFindings({ dateWindow, subscriptions: [DIRECTORY_SUBSCRIPTION] }, EVERYTHING_ACCESS)).map(f => f.resourceName).sort()).toEqual(['app-1', 'app-2', 'app-3']);
  });

  it('lists no Directory entry in the subscription scorecard, though the tenant-wide count holds them', async () => {
    const dateWindow = { mode: 'relative', days: 7 } as const;
    const summary = await computeWidgetSummary({ dateWindow }, 30, EVERYTHING_ACCESS);
    expect(summary.perSubscription.map(s => s.subscriptionId).sort()).toEqual([SUB_A, SUB_B]);
    expect(summary.current.activeFindings).toBe(4);

    const narrowed = await computeWidgetSummary({ dateWindow, subscriptions: [SUB_A] }, 30, EVERYTHING_ACCESS);
    expect(narrowed.current.activeFindings).toBe(1);
  });

  it('offers no trend for Directory alone, which has no snapshot history, and still does for one subscription', async () => {
    const dateWindow = { mode: 'relative', days: 7 } as const;
    expect((await computeWidgetSummary({ dateWindow, subscriptions: [DIRECTORY_SUBSCRIPTION] }, 30, EVERYTHING_ACCESS)).trendIsCategoryScopedOnly).toBe(true);
    expect((await computeWidgetSummary({ dateWindow, subscriptions: [SUB_A] }, 30, EVERYTHING_ACCESS)).trendIsCategoryScopedOnly).toBe(false);
  });

  it('writes no per-subscription snapshot for them, and counts them in the aggregate row', async () => {
    await upsertDailySnapshot('security');
    const aggregate = await getSnapshots(EVERYTHING_ACCESS, { categories: ['security'] });
    expect(aggregate.map(s => s.activeFindings)).toEqual([4]);
    expect(await getSnapshots(EVERYTHING_ACCESS, { categories: ['security'], subscriptionId: SUB_A })).toHaveLength(1);
    expect(await getSnapshots(EVERYTHING_ACCESS, { categories: ['security'], subscriptionId: DIRECTORY_SUBSCRIPTION })).toEqual([]);
  });
});
