/**
 * #274: the trend and delta of the summary widget for a person below Everything. Snapshots are install-wide
 * and kept per subscription, so a trend is served from one subscription's rows and per-subscription rows
 * are never added up. Live `current` numbers narrow by Scope for everyone, whatever the trend does.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertTrendPoint, resetDb, stampSubscriptionPointsFormula3 } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { refreshSnapshotsFor } from '@/lib/db/snapshots';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import { TREND_FILTER_SUPPORT } from '@/lib/trend-scope';
import { WIDGET_LIMITS } from '@/lib/widget-limits';
import { buildAccess, everythingAccess, NO_ACCESS, parseScope, type Access } from '@/lib/access-model';

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';

// The clock reads 2026-06-10, so a point last written on the 2nd is carried through the 10th.
const DAYS = Array.from({ length: 10 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);
const carriedFrom = (first: number, rest: number) => DAYS.map((day, i) => [day, i === 0 ? first : rest]);

const viewerAt = (...paths: string[]): Access =>
  buildAccess(paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })), 'manual');
const underGroup: Access = buildAccess(
  [{ tenantId: 't', scope: parseScope(GROUP)!, role: 'viewer' }], 'manual',
  [{ tenantId: 't', path: GROUP, role: 'viewer', groups: ['mg-example'], subscriptions: [SUB_ONE, SUB_TWO] }],
);

// Security is the one category with snapshots, and a delta is withheld unless every category in scope has a comparable point.
async function summary(access: Access, subscriptions?: string[]) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
  const result = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 }, ...(subscriptions ? { subscriptions } : {}) }, 30, access);
  return {
    live: result.current.activeFindings,
    trend: result.trend.map(p => [p.date, p.findings]),
    baseline: result.baseline?.date ?? null,
    deltaPct: result.deltaPct,
    reason: result.trendUnavailable,
    categoryScopedOnly: result.trendIsCategoryScopedOnly,
  };
}

afterEach(() => vi.useRealTimers());

beforeAll(async () => {
  await resetDb();
  const a = (name: string) => syntheticFinding(name, [{ zone: 'a' }], { ruleId: 'trend-rule', subscriptionId: SUB_ONE, resourceGroup: 'rg-one' });
  const b = (name: string) => syntheticFinding(name, [{ zone: 'a' }], { ruleId: 'trend-rule', subscriptionId: SUB_TWO, resourceGroup: 'rg-one' });
  await storeScan([a('a1'), a('a2'), b('b1')], { scanId: '00000000-0000-0000-0000-0000000000e1', finishedAt: '2026-06-01T10:00:00.000Z' });
  await refreshSnapshotsFor(['security'], new Date('2026-06-01T10:00:00.000Z'));
  await storeScan([a('a1'), a('a2'), a('a3'), b('b1')], { scanId: '00000000-0000-0000-0000-0000000000e2', finishedAt: '2026-06-02T10:00:00.000Z' });
  await refreshSnapshotsFor(['security'], new Date('2026-06-02T10:00:00.000Z'));
  await stampSubscriptionPointsFormula3();
});

describe('the summary trend for a person below Everything', () => {
  it('draws Everything\'s trend from the install-wide row', async () => {
    expect(await summary(everythingAccess('admin'))).toMatchObject({
      live: 4, trend: carriedFrom(3, 4), baseline: '2026-06-02', reason: null,
    });
  });

  it('draws a subscription Viewer\'s trend from that subscription\'s rows, not the install\'s', async () => {
    const result = await summary(viewerAt(`/subscriptions/${SUB_ONE}`));
    expect(result).toMatchObject({ live: 3, trend: carriedFrom(2, 3), baseline: '2026-06-02', reason: null });
    expect(typeof result.deltaPct).toBe('number');
  });

  it('draws the trend of the one subscription a filter names, for a subscription held whole', async () => {
    const result = await summary(underGroup, [SUB_TWO]);
    expect(result).toMatchObject({ live: 1, trend: carriedFrom(1, 1), reason: null });
  });

  it('asks a management group Viewer with no filter to choose, and sums nothing', async () => {
    expect(await summary(underGroup)).toEqual({ live: 4, trend: [], baseline: null, deltaPct: null, reason: 'choose-subscription', categoryScopedOnly: false });
  });

  it('gives a management group Viewer filtered to two subscriptions the existing one subscription only message, and no trend', async () => {
    expect(await summary(underGroup, [SUB_ONE, SUB_TWO])).toMatchObject({ trend: [], baseline: null, deltaPct: null, reason: null, categoryScopedOnly: true });
  });

  it('tells a resource group Viewer that no trend is kept for them, and still gives live numbers', async () => {
    const result = await summary(viewerAt(`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`));
    expect(result).toEqual({ live: 3, trend: [], baseline: null, deltaPct: null, reason: 'no-whole-subscription', categoryScopedOnly: false });
  });

  it('tells a person with no Scope the same, with nothing to count', async () => {
    expect(await summary(NO_ACCESS)).toEqual({ live: 0, trend: [], baseline: null, deltaPct: null, reason: 'no-whole-subscription', categoryScopedOnly: false });
  });

  it('asks a subscription Viewer who filters to another subscription to choose, and counts nothing of it', async () => {
    expect(await summary(viewerAt(`/subscriptions/${SUB_ONE}`), [SUB_TWO])).toMatchObject({ live: 0, trend: [], reason: 'choose-subscription' });
  });
});


async function summaryWith(filters: Partial<WidgetFilters>, access: Access) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
  return computeWidgetSummary({ dateWindow: { mode: 'relative', days: 7 }, ...filters }, 30, access);
}

describe('a trend is served only under the filters the allow-list names', () => {
  const unavailable: Record<string, Partial<WidgetFilters>> = {
    resourceGroups: { resourceGroups: ['rg-one'] },
    tags: { tags: ['prod'] },
    severities: { severities: ['high'] },
    ruleIds: { ruleIds: ['trend-rule'] },
  };

  it('names every key the allow-list marks unavailable', () => {
    const marked = Object.entries(TREND_FILTER_SUPPORT).filter(([, v]) => v === 'unavailable').map(([k]) => k).sort();
    expect(Object.keys(unavailable).sort()).toEqual(marked);
  });

  it.each(Object.keys(unavailable))('gives no trend, baseline or delta when %s is set', async key => {
    const result = await summaryWith({ categories: ['security'], ...unavailable[key] }, everythingAccess('admin'));
    expect(result).toMatchObject({ trend: [], baseline: null, deltaPct: null, baselineGap: null, trendIsCategoryScopedOnly: true, trendUnavailable: null });
    expect(result.trendByCategory).toBeUndefined();
  });

  it('gives no trend for two subscriptions, but one is served', async () => {
    expect(await summaryWith({ categories: ['security'], subscriptions: [SUB_ONE, SUB_TWO] }, everythingAccess('admin'))).toMatchObject({ trend: [], trendIsCategoryScopedOnly: true });
    expect(await summaryWith({ categories: ['security'], subscriptions: [SUB_ONE] }, everythingAccess('admin'))).toMatchObject({ trendIsCategoryScopedOnly: false });
  });
});

describe('the Directory\'s trend', () => {
  const directoryHolder = viewerAt('@directory');
  const subscriptionHolder = viewerAt(`/subscriptions/${SUB_ONE}`);

  beforeAll(async () => {
    await resetDb();
    await insertTrendPoint({ category: 'identity', subscriptionId: 'directory', date: '2026-06-01', passing: 1, total: 2, activeFindings: 4 });
    await insertTrendPoint({ category: 'identity', subscriptionId: 'directory', date: '2026-06-02', passing: 2, total: 2, activeFindings: 0 });
    await insertTrendPoint({ category: 'identity', subscriptionId: '', date: '2026-06-02', passing: 0, total: 9, activeFindings: 99 });
  });

  const days = (result: Awaited<ReturnType<typeof summaryWith>>) => result.trend.map(p => [p.date, p.findings]);

  it('serves a Directory-only person its trend with no filter, never the install-wide one', async () => {
    const result = await summaryWith({ categories: ['identity'] }, directoryHolder);
    expect(days(result)).toEqual(carriedFrom(4, 0));
    expect(result).toMatchObject({ trendLevel: 'directory', trendUnavailable: null, trendIsCategoryScopedOnly: false });
    expect(result.baseline?.date).toBe('2026-06-02');
  });

  it('serves Everything and a Directory holder the Directory\'s trend when the filter names it', async () => {
    expect(days(await summaryWith({ categories: ['identity'], subscriptions: ['directory'] }, everythingAccess('admin')))).toEqual(carriedFrom(4, 0));
    expect(days(await summaryWith({ categories: ['identity'], subscriptions: ['directory'] }, viewerAt('@directory', `/subscriptions/${SUB_ONE}`)))).toEqual(carriedFrom(4, 0));
  });

  it('gives Everything the install-wide trend when no filter names the Directory', async () => {
    expect(days(await summaryWith({ categories: ['identity'] }, everythingAccess('admin')))).toEqual([['2026-06-02', 99], ...DAYS.slice(2).map(d => [d, 99])]);
  });

  it('does not serve the Directory to someone who does not hold it, and says why', async () => {
    const result = await summaryWith({ categories: ['identity'], subscriptions: ['directory'] }, subscriptionHolder);
    expect(result).toMatchObject({ trend: [], baseline: null, deltaPct: null, trendUnavailable: 'choose-subscription' });
    expect(await summaryWith({ categories: ['identity'], subscriptions: ['directory'] }, NO_ACCESS)).toMatchObject({ trend: [], trendUnavailable: 'no-whole-subscription' });
  });
});

describe('the lines of a served trend', () => {
  const admin = everythingAccess('admin');

  beforeAll(async () => {
    await resetDb();
    await insertTrendPoint({ category: 'security', subscriptionId: '', date: '2026-06-01', passing: 1, total: 2, activeFindings: 5, formulaVersion: 2 });
    await insertTrendPoint({ category: 'security', subscriptionId: '', date: '2026-06-03', passing: 2, total: 2, activeFindings: 1, formulaVersion: 3 });
    await insertTrendPoint({ category: 'cost', subscriptionId: '', date: '2026-06-02', passing: 3, total: 4, activeFindings: 2, formulaVersion: 3 });
    await insertTrendPoint({ category: 'cost', subscriptionId: SUB_ONE.toUpperCase(), date: '2026-06-01', passing: 1, total: 4, activeFindings: 8, formulaVersion: 3 });
  });

  const shape = (line: Array<{ date: string; findings: number; carried: boolean }> | undefined) => line?.map(p => [p.date, p.findings, p.carried]);

  it('keeps a category in the line on a day it has no point, from its last point', async () => {
    const { trendByCategory } = await summaryWith({ categories: ['security', 'cost'] }, admin);
    expect(shape(trendByCategory!.security)!.slice(0, 4)).toEqual([
      ['2026-06-01', 5, false], ['2026-06-02', 5, true], ['2026-06-03', 1, false], ['2026-06-04', 1, true],
    ]);
    expect(trendByCategory!.cost!.at(-1)).toMatchObject({ date: '2026-06-10', findings: 2, carried: true });
  });

  it('starts each category at its own first point, and the aggregate on the first day every category has one', async () => {
    const result = await summaryWith({ categories: ['security', 'cost'] }, admin);
    expect(result.trendByCategory!.security![0]!.date).toBe('2026-06-01');
    expect(result.trendByCategory!.cost![0]!.date).toBe('2026-06-02');
    expect(result.trend[0]).toMatchObject({ date: '2026-06-02', findings: 7, passing: 4, total: 6 });
    expect(result.trend.at(-1)).toMatchObject({ date: '2026-06-10', findings: 3 });
  });

  it('draws the categories asked for and no other', async () => {
    const { trendByCategory } = await summaryWith({ categories: ['security'] }, admin);
    expect(Object.keys(trendByCategory!)).toEqual(['security']);
  });

  it('keeps each point\'s version, and notes the day an install-wide line is not marked', async () => {
    const result = await summaryWith({ categories: ['security'] }, admin);
    expect(result.trendByCategory!.security!.map(p => p.formulaVersion).slice(0, 4)).toEqual([2, 2, 3, 3]);
    expect(result).toMatchObject({ trendLevel: 'install', trendNotes: [] });
  });

  it('finds an upper-case point for a lower-case level, carries it, and notes where its counting changed', async () => {
    await insertTrendPoint({ category: 'cost', subscriptionId: SUB_ONE.toUpperCase(), date: '2026-06-05', passing: 2, total: 4, activeFindings: 6, formulaVersion: 3 });
    await insertTrendPoint({ category: 'reliability', subscriptionId: SUB_ONE.toUpperCase(), date: '2026-06-01', passing: 1, total: 4, activeFindings: 8, formulaVersion: 2 });
    await insertTrendPoint({ category: 'reliability', subscriptionId: SUB_ONE.toUpperCase(), date: '2026-06-04', passing: 2, total: 4, activeFindings: 6, formulaVersion: 3 });
    const result = await summaryWith({ categories: ['cost', 'reliability'], subscriptions: [SUB_ONE] }, admin);
    expect(shape(result.trendByCategory!.cost)!.slice(0, 5)).toEqual([
      ['2026-06-01', 8, false], ['2026-06-02', 8, true], ['2026-06-03', 8, true], ['2026-06-04', 8, true], ['2026-06-05', 6, false],
    ]);
    expect(result.trendLevel).toBe('subscription');
    expect(result.trendNotes).toEqual([WIDGET_LIMITS.w2, WIDGET_LIMITS.w5('2026-06-04')]);
    expect(result.baselineGap).toMatchObject({ level: 'subscription' });
  });
});
