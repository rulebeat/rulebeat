/**
 * #274: posture snapshots are install-wide and recorded per subscription, so a read for anyone below
 * Everything never returns the aggregate row (which counts every finding on the install) and returns a
 * subscription's row only for a subscription they hold whole. Snapshots are written by the real path.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { insertTrendPoint, resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { getBaselineSnapshots, getSnapshots, refreshSnapshotsFor } from '@/lib/db/snapshots';
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

const counts = (rows: { subscriptionId: string; date: string; activeFindings: number }[]) =>
  rows.map(r => [r.subscriptionId, r.date, r.activeFindings]);

beforeAll(async () => {
  await resetDb();
  const a = (name: string) => syntheticFinding(name, [{ zone: 'a' }], { ruleId: 'snap-rule', subscriptionId: SUB_ONE, resourceGroup: 'rg-one' });
  const b = (name: string) => syntheticFinding(name, [{ zone: 'a' }], { ruleId: 'snap-rule', subscriptionId: SUB_TWO, resourceGroup: 'rg-one' });
  await storeScan([a('a1'), a('a2'), b('b1')], { scanId: '00000000-0000-0000-0000-0000000000d1', finishedAt: '2026-06-01T10:00:00.000Z' });
  await refreshSnapshotsFor(['security'], new Date('2026-06-01T10:00:00.000Z'));
  await storeScan([a('a1'), a('a2'), a('a3'), b('b1')], { scanId: '00000000-0000-0000-0000-0000000000d2', finishedAt: '2026-06-02T10:00:00.000Z' });
  await refreshSnapshotsFor(['security'], new Date('2026-06-02T10:00:00.000Z'));
});

describe('getSnapshots', () => {
  it('gives Everything the aggregate row, or the subscription it names', async () => {
    expect(counts(await getSnapshots(everythingAccess('admin')))).toEqual([['', '2026-06-01', 3], ['', '2026-06-02', 4]]);
    expect(counts(await getSnapshots(everythingAccess('admin'), { subscriptionId: SUB_ONE }))).toEqual([[SUB_ONE, '2026-06-01', 2], [SUB_ONE, '2026-06-02', 3]]);
  });

  it('gives a subscription Scope that subscription\'s rows, never the install\'s count', async () => {
    const access = viewerAt(`/subscriptions/${SUB_ONE}`);
    expect(await getSnapshots(access)).toEqual([]);
    expect(counts(await getSnapshots(access, { subscriptionId: SUB_ONE }))).toEqual([[SUB_ONE, '2026-06-01', 2], [SUB_ONE, '2026-06-02', 3]]);
    expect(counts(await getSnapshots(viewerAt(`/subscriptions/${SUB_ONE.toUpperCase()}`), { subscriptionId: SUB_ONE }))).toHaveLength(2);
  });

  it('gives nothing for a subscription the person does not hold, held or not as a resource group', async () => {
    expect(await getSnapshots(viewerAt(`/subscriptions/${SUB_ONE}`), { subscriptionId: SUB_TWO })).toEqual([]);
    expect(await getSnapshots(viewerAt(`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`), { subscriptionId: SUB_ONE })).toEqual([]);
  });

  it('gives a resource group Scope nothing, since a snapshot has no resource group grain', async () => {
    const access = viewerAt(`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`);
    expect(await getSnapshots(access)).toEqual([]);
    expect(await getSnapshots(access, { subscriptionId: SUB_ONE })).toEqual([]);
  });

  it('gives a management group Scope the rows of a subscription under it, and not the aggregate', async () => {
    expect(await getSnapshots(underGroup)).toEqual([]);
    // Subscription two held one finding on both days, so only the first day has a point: a missing point means unchanged.
    expect(counts(await getSnapshots(underGroup, { subscriptionId: SUB_TWO }))).toEqual([[SUB_TWO, '2026-06-01', 1]]);
  });

  it('gives a person with no Scope and a Directory only person nothing', async () => {
    expect(await getSnapshots(NO_ACCESS, { subscriptionId: SUB_ONE })).toEqual([]);
    expect(await getSnapshots(viewerAt('@directory'), { subscriptionId: SUB_ONE })).toEqual([]);
    expect(await getSnapshots(NO_ACCESS)).toEqual([]);
  });

  it('still applies the category and date filters', async () => {
    const access = viewerAt(`/subscriptions/${SUB_ONE}`);
    expect(counts(await getSnapshots(access, { subscriptionId: SUB_ONE, sinceDate: '2026-06-02' }))).toEqual([[SUB_ONE, '2026-06-02', 3]]);
    expect(await getSnapshots(access, { subscriptionId: SUB_ONE, categories: ['cost'] })).toEqual([]);
  });
});

describe('getBaselineSnapshots', () => {
  it('gives Everything the latest aggregate row on or before the date', async () => {
    expect(counts(await getBaselineSnapshots(['security'], '2026-06-01', everythingAccess('admin')))).toEqual([['', '2026-06-01', 3]]);
  });

  it('gives a subscription Scope its own row, and no aggregate without a subscription', async () => {
    const access = viewerAt(`/subscriptions/${SUB_ONE}`);
    expect(counts(await getBaselineSnapshots(['security'], '2026-06-02', access, SUB_ONE))).toEqual([[SUB_ONE, '2026-06-02', 3]]);
    expect(await getBaselineSnapshots(['security'], '2026-06-02', access)).toEqual([]);
    expect(await getBaselineSnapshots(['security'], '2026-06-02', access, SUB_TWO)).toEqual([]);
  });

  it('gives a resource group Scope and a person with no Scope nothing', async () => {
    const group = viewerAt(`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`);
    expect(await getBaselineSnapshots(['security'], '2026-06-02', group, SUB_ONE)).toEqual([]);
    expect(await getBaselineSnapshots(['security'], '2026-06-02', NO_ACCESS)).toEqual([]);
  });

  it('gives a management group Scope a subscription under it', async () => {
    // The newest point on or before the 2nd is the one written on the 1st, because nothing changed on the 2nd.
    expect(counts(await getBaselineSnapshots(['security'], '2026-06-02', underGroup, SUB_TWO))).toEqual([[SUB_TWO, '2026-06-01', 1]]);
  });
});

describe('the level of a point is compared without regard to case', () => {
  const UPPER = SUB_ONE.replace('a', 'A');
  const lowerHeld = viewerAt(`/subscriptions/${SUB_ONE}`);

  beforeAll(async () => {
    await resetDb();
    await insertTrendPoint({ category: 'security', subscriptionId: UPPER, date: '2026-05-01', passing: 1, total: 2, formulaVersion: 2, activeFindings: 7 });
  });

  it('finds an upper-case old point for a lower-case level, for Everything and for a holder', async () => {
    expect(counts(await getSnapshots(everythingAccess('admin'), { subscriptionId: SUB_ONE }))).toEqual([[UPPER, '2026-05-01', 7]]);
    expect(counts(await getSnapshots(lowerHeld, { subscriptionId: SUB_ONE }))).toEqual([[UPPER, '2026-05-01', 7]]);
    expect(counts(await getBaselineSnapshots(['security'], '2026-05-02', everythingAccess('admin'), SUB_ONE))).toEqual([[UPPER, '2026-05-01', 7]]);
    expect(counts(await getBaselineSnapshots(['security'], '2026-05-02', lowerHeld, SUB_ONE))).toEqual([[UPPER, '2026-05-01', 7]]);
  });

  it('finds a lower-case point for an upper-case level', async () => {
    await insertTrendPoint({ category: 'cost', subscriptionId: SUB_ONE, date: '2026-05-01', passing: 1, total: 2, activeFindings: 3 });
    expect(counts(await getSnapshots(everythingAccess('admin'), { subscriptionId: UPPER, categories: ['cost'] }))).toEqual([[SUB_ONE, '2026-05-01', 3]]);
  });

  it('does not read the aggregate row for a subscription, or another subscription', async () => {
    expect(await getSnapshots(everythingAccess('admin'))).toEqual([]);
    expect(await getSnapshots(everythingAccess('admin'), { subscriptionId: SUB_TWO })).toEqual([]);
  });

  it('gives the most recently updated point when two cases of one level share a date', async () => {
    await insertTrendPoint({ category: 'reliability', subscriptionId: SUB_ONE, date: '2026-05-01', passing: 1, total: 2, activeFindings: 11, updatedAt: '2026-05-01T20:00:00.000Z' });
    await insertTrendPoint({ category: 'reliability', subscriptionId: UPPER, date: '2026-05-01', passing: 1, total: 2, activeFindings: 22, updatedAt: '2026-05-01T08:00:00.000Z' });
    const admin = everythingAccess('admin');
    expect(counts(await getSnapshots(admin, { subscriptionId: SUB_ONE, categories: ['reliability'] }))).toEqual([[SUB_ONE, '2026-05-01', 11]]);
    expect(counts(await getBaselineSnapshots(['reliability'], '2026-05-01', admin, SUB_ONE))).toEqual([[SUB_ONE, '2026-05-01', 11]]);

    await insertTrendPoint({ category: 'identity', subscriptionId: SUB_ONE, date: '2026-05-01', passing: 1, total: 2, activeFindings: 11, updatedAt: '2026-05-01T08:00:00.000Z' });
    await insertTrendPoint({ category: 'identity', subscriptionId: UPPER, date: '2026-05-01', passing: 1, total: 2, activeFindings: 22, updatedAt: '2026-05-01T20:00:00.000Z' });
    expect(counts(await getSnapshots(admin, { subscriptionId: SUB_ONE, categories: ['identity'] }))).toEqual([[UPPER, '2026-05-01', 22]]);
    expect(counts(await getBaselineSnapshots(['identity'], '2026-05-01', admin, SUB_ONE))).toEqual([[UPPER, '2026-05-01', 22]]);
  });
});

describe('the Directory\'s points', () => {
  beforeAll(async () => {
    await resetDb();
    await insertTrendPoint({ category: 'identity', subscriptionId: 'directory', date: '2026-05-01', passing: 1, total: 2, activeFindings: 5 });
  });

  it('gives Everything and a Directory holder the Directory\'s rows', async () => {
    expect(counts(await getSnapshots(everythingAccess('admin'), { subscriptionId: 'directory' }))).toEqual([['directory', '2026-05-01', 5]]);
    expect(counts(await getSnapshots(viewerAt('@directory'), { subscriptionId: 'directory' }))).toEqual([['directory', '2026-05-01', 5]]);
    expect(counts(await getSnapshots(viewerAt('@directory', `/subscriptions/${SUB_ONE}`), { subscriptionId: 'Directory' }))).toEqual([['directory', '2026-05-01', 5]]);
    expect(counts(await getBaselineSnapshots(['identity'], '2026-05-02', viewerAt('@directory'), 'directory'))).toEqual([['directory', '2026-05-01', 5]]);
  });

  it('gives nobody else the Directory\'s rows', async () => {
    expect(await getSnapshots(viewerAt(`/subscriptions/${SUB_ONE}`), { subscriptionId: 'directory' })).toEqual([]);
    expect(await getSnapshots(underGroup, { subscriptionId: 'directory' })).toEqual([]);
    expect(await getSnapshots(NO_ACCESS, { subscriptionId: 'directory' })).toEqual([]);
    expect(await getBaselineSnapshots(['identity'], '2026-05-02', viewerAt(`/subscriptions/${SUB_ONE}`), 'directory')).toEqual([]);
  });

  it('does not give a Directory holder the install-wide row', async () => {
    expect(await getSnapshots(viewerAt('@directory'))).toEqual([]);
  });
});
