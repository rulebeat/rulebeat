/**
 * A finding opened inside a group shows the rows of that group only, read from the rows route with
 * the group's returned-column values added as filters (what the explorer sends). Those rows, their
 * count and their pages must be the ones the group route itself returned for the same finding, over
 * stored findings, so a group header's "n rows" and the rows under it never disagree.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { emptyView, type View, type ViewFilter } from '@/lib/finding-view';
import { groupUrl, rowsUrl, type RowCondition, type ViewRequest } from '@/lib/explorer-session';
import type { FindingRowsResponse, GroupResponse } from '@/lib/view-response';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));
const groupRoute = await import('@/app/api/findings/group/route');
const rowsRoute = await import('@/app/api/findings/rows/route');

const RULE = 'group-rows-rule';
// 45 rows: v cycles a, b, blank; w is x for the first 30 and y for the last 15.
const SPLIT = Array.from({ length: 45 }, (_, i) => ({
  v: i % 3 === 0 ? 'a' : i % 3 === 1 ? 'b' : null,
  w: i < 30 ? 'x' : 'y',
  n: i,
}));
const SPLIT_NAME = 'vm-split';
const SMALL = [{ v: 'a', w: 'x', n: 100 }, { v: 'b', w: 'y', n: 101 }];

beforeAll(async () => {
  await resetDb();
  await storeScan([
    syntheticFinding(SPLIT_NAME, SPLIT, { ruleId: RULE }),
    syntheticFinding('vm-small', SMALL, { ruleId: RULE }),
  ], { scanId: 'group-rows-scan', finishedAt: new Date().toISOString() });
});

afterEach(() => { mockRequireRole.mockReset(); });

const make = (patch: Partial<View> & { filters?: ViewFilter[] }): View => ({ ...emptyView(), ...patch });
const request = (view: View): ViewRequest => ({ view, tab: 'results', showSuppressed: false });

async function get<T>(route: { GET(req: Request): Promise<Response> }, url: string): Promise<T> {
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
  const res = await route.GET(new Request(`http://localhost${url}`));
  expect(res.status).toBe(200);
  return res.json() as Promise<T>;
}

const rowNumbers = (rows: { n?: unknown }[]) => rows.map(r => r.n);

/** The numbers of the rows the split finding holds for a group, counted straight from the fixture. */
const expectedN = (keep: (row: (typeof SPLIT)[number]) => boolean) => SPLIT.filter(keep).map(r => r.n);

describe('a finding inside a group of a returned column', () => {
  const view = make({ groupBy: ['row.v'] });

  it.each([
    ['a', 'a', (r: (typeof SPLIT)[number]) => r.v === 'a'],
    ['b', 'b', (r: (typeof SPLIT)[number]) => r.v === 'b'],
  ])('holds the rows of the %s group, 20 first and the rest on the next page', async (_name, value, keep) => {
    const group = await get<GroupResponse>(groupRoute, groupUrl(request(view), [value], 1));
    const item = group.items.find(i => i.finding.resourceName === SPLIT_NAME)!;
    const all = expectedN(keep);
    expect(all).toHaveLength(15);
    expect(item.matchedRowCount).toBe(15);
    expect(rowNumbers(item.rows)).toEqual(all);

    const conditions: RowCondition[] = [{ path: 'v', value }];
    const page1 = await get<FindingRowsResponse>(rowsRoute, rowsUrl(request(view), item.finding.fingerprint, 1, conditions));
    expect(page1.matchedRowCount).toBe(item.matchedRowCount);
    expect(rowNumbers(page1.rows)).toEqual(rowNumbers(item.rows));
  });

  it('holds more rows than a page, the same through both routes on both pages', async () => {
    const group = await get<GroupResponse>(groupRoute, groupUrl(request(make({ groupBy: ['row.w'] })), ['x'], 1));
    const item = group.items.find(i => i.finding.resourceName === SPLIT_NAME)!;
    // 30 rows are x: more than the 20 an item carries, so a second page exists.
    expect(item.matchedRowCount).toBe(30);
    expect(rowNumbers(item.rows)).toEqual(expectedN(r => r.w === 'x').slice(0, 20));

    const conditions: RowCondition[] = [{ path: 'w', value: 'x' }];
    const page1 = await get<FindingRowsResponse>(rowsRoute, rowsUrl(request(make({ groupBy: ['row.w'] })), item.finding.fingerprint, 1, conditions));
    const page2 = await get<FindingRowsResponse>(rowsRoute, rowsUrl(request(make({ groupBy: ['row.w'] })), item.finding.fingerprint, 2, conditions));
    expect(rowNumbers(page1.rows)).toEqual(rowNumbers(item.rows));
    expect(rowNumbers(page2.rows)).toEqual(expectedN(r => r.w === 'x').slice(20));
    expect(page2.pageCount).toBe(2);
  });

  it('holds the empty-value group\'s rows when the group path is null', async () => {
    const group = await get<GroupResponse>(groupRoute, groupUrl(request(view), [null], 1));
    const item = group.items.find(i => i.finding.resourceName === SPLIT_NAME)!;
    expect(item.matchedRowCount).toBe(15);
    expect(rowNumbers(item.rows)).toEqual(expectedN(r => r.v === null));

    const page1 = await get<FindingRowsResponse>(rowsRoute, rowsUrl(request(view), item.finding.fingerprint, 1, [{ path: 'v', value: null }]));
    expect(page1.matchedRowCount).toBe(15);
    expect(rowNumbers(page1.rows)).toEqual(rowNumbers(item.rows));
  });

  it('holds a group two levels down by both of its values', async () => {
    const two = make({ groupBy: ['row.w', 'row.v'] });
    const group = await get<GroupResponse>(groupRoute, groupUrl(request(two), ['x', 'a'], 1));
    const item = group.items.find(i => i.finding.resourceName === SPLIT_NAME)!;
    const all = expectedN(r => r.w === 'x' && r.v === 'a');
    expect(all).toHaveLength(10);
    expect(item.matchedRowCount).toBe(10);

    const conditions: RowCondition[] = [{ path: 'w', value: 'x' }, { path: 'v', value: 'a' }];
    const page1 = await get<FindingRowsResponse>(rowsRoute, rowsUrl(request(two), item.finding.fingerprint, 1, conditions));
    expect(rowNumbers(page1.rows)).toEqual(all);
    expect(rowNumbers(item.rows)).toEqual(all);
  });

  it('does not send the other finding\'s rows into the group', async () => {
    const group = await get<GroupResponse>(groupRoute, groupUrl(request(view), ['a'], 1));
    const small = group.items.find(i => i.finding.resourceName === 'vm-small')!;
    expect(rowNumbers(small.rows)).toEqual([100]);
    expect(group.total).toBe(2);
  });
});
