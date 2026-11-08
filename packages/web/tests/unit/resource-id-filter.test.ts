/**
 * The exact resource id filter (#406): `f=resourceId=<id>` keeps the findings on that one resource.
 * The free-text search it replaces on the dashboard's links matches by substring, so `vm1` also found
 * `vm10`. Driven through the address reader and writer, the view engine and the server view, under
 * the viewer's Access.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { emptyView, filterFindings, viewFromSearchParams, viewToSearchParams, type View, type ViewFinding } from '@/lib/finding-view';
import { queryView } from '@/lib/db/finding-views';
import { buildAccess, parseScope } from '@/lib/access-model';
import { EVERYTHING_ACCESS } from '../helpers/access';

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const idOf = (sub: string, name: string) =>
  `/subscriptions/${sub}/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/${name}`;

const viewFor = (...ids: string[]): View => ({ ...emptyView(), filters: [{ field: 'resourceId', values: ids }] });

function slim(resourceId: string | undefined, ruleId = 'rule-1'): ViewFinding {
  return {
    fingerprint: `${ruleId}:${resourceId}`, category: 'security', severity: 'high', status: 'active', ruleId, subscriptionId: SUB_ONE,
    title: 'a finding', firstSeenAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-01T00:00:00.000Z', resourceId,
    resourceName: resourceId?.split('/').pop(),
  };
}

describe('the address', () => {
  it('writes the id as f=resourceId=<id> and reads it back', () => {
    const id = idOf(SUB_ONE, 'vm1');
    const query = viewToSearchParams(viewFor(id)).toString();
    expect(new URLSearchParams(query).get('f')).toBe(`resourceId=${id}`);
    expect(viewFromSearchParams(new URLSearchParams(query)).filters).toEqual([{ field: 'resourceId', values: [id] }]);
  });

  it('keeps an id that holds the characters the address splits on', () => {
    const id = '/subscriptions/s/resourceGroups/rg/providers/p/things/a,b|c=d\\e';
    const view = viewFromSearchParams(new URLSearchParams(viewToSearchParams(viewFor(id)).toString()));
    expect(view.filters).toEqual([{ field: 'resourceId', values: [id] }]);
  });
});

describe('the view engine', () => {
  const vm1 = slim(idOf(SUB_ONE, 'vm1'));
  const vm10 = slim(idOf(SUB_ONE, 'vm10'));
  const other = slim(idOf(SUB_ONE, 'vm1'), 'rule-2');
  const activity: ViewFinding = { ...slim(undefined), kind: 'activity', dimensionKey: 'vm1' };

  it('keeps vm1 and not vm10, which a text search for vm1 would also keep', () => {
    expect(filterFindings([vm1, vm10], viewFor(idOf(SUB_ONE, 'vm1')))).toEqual([vm1]);
    expect(filterFindings([vm1, vm10], { ...emptyView(), search: 'vm1' })).toEqual([vm1, vm10]);
  });

  it('keeps every rule\'s finding on the resource', () => {
    expect(filterFindings([vm1, vm10, other], viewFor(idOf(SUB_ONE, 'vm1')))).toEqual([vm1, other]);
  });

  it('matches the id as Azure does, without regard to case', () => {
    expect(filterFindings([vm1, vm10], viewFor(idOf(SUB_ONE, 'vm1').toUpperCase()))).toEqual([vm1]);
  });

  it('accepts several ids, and drops a finding that has none', () => {
    expect(filterFindings([vm1, vm10, activity], viewFor(idOf(SUB_ONE, 'vm1'), idOf(SUB_ONE, 'vm10')))).toEqual([vm1, vm10]);
  });
});

describe('the server view', () => {
  beforeAll(async () => {
    await resetDb();
    await storeScan([
      syntheticFinding('vm1', [{ n: 1 }], { ruleId: 'exact-rule', subscriptionId: SUB_ONE }),
      syntheticFinding('vm10', [{ n: 2 }], { ruleId: 'exact-rule', subscriptionId: SUB_ONE }),
      syntheticFinding('vm1', [{ n: 3 }], { ruleId: 'exact-rule', subscriptionId: SUB_TWO }),
      syntheticFinding('vm1', [{ n: 4 }], { ruleId: 'exact-other-rule', subscriptionId: SUB_ONE }),
    ], { scanId: 'exact-scan', finishedAt: new Date().toISOString() });
  });

  const query = { tab: 'results', showSuppressed: false } as const;
  const found = async (view: View, access = EVERYTHING_ACCESS) =>
    (await queryView(view, query, access)).items.map(i => `${i.finding.ruleId}@${i.finding.resourceId}`).sort();

  it('lists only vm1 when asked for vm1, and not vm10', async () => {
    expect(await found(viewFor(idOf(SUB_ONE, 'vm1')))).toEqual([
      `exact-other-rule@${idOf(SUB_ONE, 'vm1')}`, `exact-rule@${idOf(SUB_ONE, 'vm1')}`,
    ]);
    expect((await queryView({ ...emptyView(), search: 'vm1' }, query, EVERYTHING_ACCESS)).total).toBe(4);
  });

  it('narrows by the viewer\'s Access first: a resource outside it is not found by its id', async () => {
    const viewerOnTwo = buildAccess([{ tenantId: 't', scope: parseScope(`/subscriptions/${SUB_TWO}`)!, role: 'viewer' }], 'manual');
    expect(await found(viewFor(idOf(SUB_ONE, 'vm1')), viewerOnTwo)).toEqual([]);
    expect(await found(viewFor(idOf(SUB_TWO, 'vm1')), viewerOnTwo)).toEqual([`exact-rule@${idOf(SUB_TWO, 'vm1')}`]);
  });

  it('counts the same findings in the tiles and the total as in the list', async () => {
    const response = await queryView(viewFor(idOf(SUB_ONE, 'vm1')), query, EVERYTHING_ACCESS);
    expect(response.total).toBe(2);
    expect(response.tiles.total).toBe(2);
  });
});
