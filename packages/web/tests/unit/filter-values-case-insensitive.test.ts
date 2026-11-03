/**
 * #379: a subscription or resource group filter compares case-insensitively on every surface that
 * counts findings, so the live numbers agree with Scans and with each other. Azure treats the two
 * names as case-insensitive but ARM returns a resource group in whatever case the resource was
 * created with, so one group is stored as both 'rg-a' and 'RG-A'.
 *
 * Driven through the seams each surface is read at: the posture ring (computeWidgetSummary), New vs
 * Fixed and Activity occurrences (the event counts), and the Scans count (queryView). Runs on
 * whichever backend tests/setup.ts selected.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { emptyView, type View } from '@/lib/finding-view';
import { queryView } from '@/lib/db/finding-views';
import { getActivityOccurrenceCounts, getFindingEventCounts } from '@/lib/db/findings';
import { computeWidgetSummary, queryActiveFindings } from '@/lib/dashboard-data';
import { DIRECTORY_SUBSCRIPTION } from '@/lib/placement';
import { filterValuesInclude, resourceGroupFilterMatches, subscriptionFilterMatches } from '@/lib/dashboard-filters';
import { EVERYTHING_ACCESS } from '../helpers/access';

const SUB = 'AAAAAAAA-1111-1111-1111-111111111111';
const STATE_RULE = 'case-state-rule';
const GRAPH_RULE = 'case-graph-rule';
const LOGS_RULE = 'case-logs-rule';
const WINDOW = { mode: 'relative', days: 7 } as const;
const since = () => new Date(Date.now() - 7 * 86_400_000).toISOString();
const total = (counts: { created: number }[]) => counts.reduce((n, c) => n + c.created, 0);

beforeAll(async () => {
  await resetDb();
  await storeScan([
    syntheticFinding('vm-lower', [{ n: 1 }], { ruleId: STATE_RULE, subscriptionId: SUB.toLowerCase(), resourceGroup: 'rg-a' }),
    syntheticFinding('vm-upper', [{ n: 2 }], { ruleId: STATE_RULE, subscriptionId: SUB, resourceGroup: 'RG-A' }),
    syntheticFinding('vm-other', [{ n: 3 }], { ruleId: STATE_RULE, subscriptionId: SUB, resourceGroup: 'rg-b' }),
    syntheticFinding('app-1', [{ n: 4 }], { ruleId: GRAPH_RULE, placement: 'directory' }),
    syntheticFinding('act-lower', [{ n: 5 }], { ruleId: LOGS_RULE, subscriptionId: SUB.toLowerCase(), resourceGroup: 'rg-a', kind: 'activity' }),
    syntheticFinding('act-upper', [{ n: 6 }], { ruleId: LOGS_RULE, subscriptionId: SUB, resourceGroup: 'RG-A', kind: 'activity' }),
  ], { scanId: 'case-scan', finishedAt: new Date().toISOString() });
});

const viewOf = (field: 'subscription' | 'resourceGroup', ...values: string[]): View => ({ ...emptyView(), filters: [{ field, values }] });

describe('the filter model helpers', () => {
  it('compares values without regard to case', () => {
    expect(filterValuesInclude(['RG-A'], 'rg-a')).toBe(true);
    expect(filterValuesInclude(['RG-A'], 'rg-b')).toBe(false);
    expect(resourceGroupFilterMatches(['RG-A'], 'rg-a')).toBe(true);
    expect(resourceGroupFilterMatches(['RG-A'], undefined)).toBe(false);
  });

  it('matches the reserved Directory value to placement directory only', () => {
    expect(subscriptionFilterMatches([DIRECTORY_SUBSCRIPTION], { placement: 'directory', subscriptionId: '' })).toBe(true);
    expect(subscriptionFilterMatches([DIRECTORY_SUBSCRIPTION], { placement: 'resource', subscriptionId: 'directory' })).toBe(false);
    expect(subscriptionFilterMatches([SUB], { placement: 'directory', subscriptionId: '' })).toBe(false);
    expect(subscriptionFilterMatches(['Directory'], { placement: 'directory', subscriptionId: '' })).toBe(false);
    expect(subscriptionFilterMatches([SUB.toLowerCase()], { placement: 'resource', subscriptionId: SUB })).toBe(true);
  });
});

describe('the posture ring and stat card', () => {
  it('counts a resource group in either case', async () => {
    const summary = await computeWidgetSummary({ dateWindow: WINDOW, resourceGroups: ['RG-A'] }, 30, EVERYTHING_ACCESS);
    expect(summary.current.activeFindings).toBe(2);
    const lower = await computeWidgetSummary({ dateWindow: WINDOW, resourceGroups: ['rg-a'] }, 30, EVERYTHING_ACCESS);
    expect(lower.current.activeFindings).toBe(2);
  });

  it('counts a subscription id in either case', async () => {
    expect((await queryActiveFindings({ dateWindow: WINDOW, subscriptions: [SUB.toLowerCase()] }, EVERYTHING_ACCESS)).length).toBe(5);
  });

  it('keeps Directory to the directory findings', async () => {
    const found = await queryActiveFindings({ dateWindow: WINDOW, subscriptions: [DIRECTORY_SUBSCRIPTION] }, EVERYTHING_ACCESS);
    expect(found.map(f => f.resourceName)).toEqual(['app-1']);
  });
});

describe('New vs Fixed', () => {
  it('counts a resource group in either case', async () => {
    const counts = await getFindingEventCounts({ resourceGroups: ['RG-A'], sinceDate: since() }, EVERYTHING_ACCESS);
    expect(total(counts)).toBe(2);
  });

  it('counts a subscription id in either case', async () => {
    const counts = await getFindingEventCounts({ subscriptions: [SUB.toLowerCase()], sinceDate: since() }, EVERYTHING_ACCESS);
    expect(total(counts)).toBe(3);
  });

  it('keeps Directory to the directory findings', async () => {
    const counts = await getFindingEventCounts({ subscriptions: [DIRECTORY_SUBSCRIPTION], sinceDate: since() }, EVERYTHING_ACCESS);
    expect(total(counts)).toBe(1);
  });
});

describe('Activity occurrences', () => {
  it('counts a resource group in either case', async () => {
    const counts = await getActivityOccurrenceCounts({ resourceGroups: ['RG-A'], sinceDate: since() }, EVERYTHING_ACCESS);
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(2);
  });

  it('counts a subscription id in either case', async () => {
    const counts = await getActivityOccurrenceCounts({ subscriptions: [SUB.toLowerCase()], sinceDate: since() }, EVERYTHING_ACCESS);
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(2);
  });
});

describe('the Scans views', () => {
  const query = { tab: 'results', showSuppressed: false } as const;

  it('counts a resource group in either case', async () => {
    expect((await queryView(viewOf('resourceGroup', 'RG-A'), query, EVERYTHING_ACCESS)).total).toBe(2);
    expect((await queryView(viewOf('resourceGroup', 'rg-a'), query, EVERYTHING_ACCESS)).total).toBe(2);
  });

  it('counts a subscription id in either case', async () => {
    expect((await queryView(viewOf('subscription', SUB.toLowerCase()), query, EVERYTHING_ACCESS)).total).toBe(3);
  });

  it('keeps Directory to the directory findings', async () => {
    expect((await queryView(viewOf('subscription', DIRECTORY_SUBSCRIPTION), query, EVERYTHING_ACCESS)).total).toBe(1);
  });
});
