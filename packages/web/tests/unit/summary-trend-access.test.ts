/**
 * #274: the trend and delta of the summary widget for a person below Everything. Snapshots are install-wide
 * and kept per subscription, so a trend is served from one subscription's rows and per-subscription rows
 * are never added up. Live `current` numbers narrow by Scope for everyone, whatever the trend does.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { upsertDailySnapshot } from '@/lib/db/snapshots';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { buildAccess, everythingAccess, NO_ACCESS, parseScope, type Access } from '@/lib/access-model';

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';

const viewerAt = (...paths: string[]): Access =>
  buildAccess(paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })), 'manual');
const underGroup: Access = buildAccess(
  [{ tenantId: 't', scope: parseScope(GROUP)!, role: 'viewer' }], 'manual',
  [{ tenantId: 't', path: GROUP, role: 'viewer', groups: ['mg-example'], subscriptions: [SUB_ONE, SUB_TWO] }],
);

async function summary(access: Access, subscriptions?: string[]) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
  const result = await computeWidgetSummary({ dateWindow: { mode: 'relative', days: 7 }, ...(subscriptions ? { subscriptions } : {}) }, 30, access);
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
  await upsertDailySnapshot('security', new Date('2026-06-01T10:00:00.000Z'));
  await storeScan([a('a1'), a('a2'), a('a3'), b('b1')], { scanId: '00000000-0000-0000-0000-0000000000e2', finishedAt: '2026-06-02T10:00:00.000Z' });
  await upsertDailySnapshot('security', new Date('2026-06-02T10:00:00.000Z'));
});

describe('the summary trend for a person below Everything', () => {
  it('draws Everything\'s trend from the install-wide row', async () => {
    expect(await summary(everythingAccess('admin'))).toMatchObject({
      live: 4, trend: [['2026-06-01', 3], ['2026-06-02', 4]], baseline: '2026-06-02', reason: null,
    });
  });

  it('draws a subscription Viewer\'s trend from that subscription\'s rows, not the install\'s', async () => {
    const result = await summary(viewerAt(`/subscriptions/${SUB_ONE}`));
    expect(result).toMatchObject({ live: 3, trend: [['2026-06-01', 2], ['2026-06-02', 3]], baseline: '2026-06-02', reason: null });
    expect(typeof result.deltaPct).toBe('number');
  });

  it('draws the trend of the one subscription a filter names, for a subscription held whole', async () => {
    const result = await summary(underGroup, [SUB_TWO]);
    expect(result).toMatchObject({ live: 1, trend: [['2026-06-01', 1], ['2026-06-02', 1]], reason: null });
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
