/**
 * #392: an old `/scans` link that carries `subscription=` and `rg=` opens as Scope picks. The Scans page asks
 * `legacyLinkRedirect` where the address should go, and the view read marks the values that reach no pair the
 * viewer holds. Driven over the access matrix's seed on whichever backend the suite opened (the SQLite run and
 * the Postgres run, RULEBEAT_TEST_PG_URL, read the same).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { MATRIX_TENANT, SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, SUB_ONE, SUB_TWO, matrixHierarchy, seedMatrix } from '../helpers/access-matrix';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { expandManagementGroups } from '@/lib/management-group-tree';
import { legacyLinkRedirect } from '@/lib/db/legacy-scope-link';
import { expandScopeSet } from '@/lib/db/scope-sets';
import { queryView } from '@/lib/db/finding-views';
import { emptyView, viewFromSearchParams, type View } from '@/lib/finding-view';
import { SCOPE_INLINE_BUDGET } from '@/lib/finding-view';

const nodes = matrixHierarchy().nodes;
const SUB_ONE_PATH = `/subscriptions/${SUB_ONE}`;
const SUB_TWO_PATH = `/subscriptions/${SUB_TWO}`;
const GROUP_ONE_IN_ONE = `${SUB_ONE_PATH}/resourceGroups/rg-one`;
const GROUP_ONE_IN_TWO = `${SUB_TWO_PATH}/resourceGroups/rg-one`;

function accessAt(...paths: string[]): Access {
  const grants = paths.map(path => ({ tenantId: MATRIX_TENANT, scope: parseScope(path)!, role: 'viewer' as const }));
  return buildAccess(grants, 'manual', expandManagementGroups(grants, nodes));
}

beforeAll(async () => {
  await resetDb();
  await seedMatrix();
});

const to = async (query: string, access: Access = EVERYTHING_ACCESS) => {
  const href = await legacyLinkRedirect(Object.fromEntries(new URLSearchParams(query)), access);
  return href === null ? null : { path: href.split('?')[0], params: new URLSearchParams(href.split('?')[1]) };
};

describe('a link whose every value reaches a pair the viewer holds is replaced in full', () => {
  it('writes a subscription as a Scope pick and keeps every other param', async () => {
    const moved = await to(`tab=advisories&subscription=${SUB_ONE}&severity=high&ruleId=r1&category=security&tags=prod`);
    expect(moved!.path).toBe('/scans');
    expect(moved!.params.get('scope')).toBe(SUB_ONE_PATH);
    expect(moved!.params.has('subscription')).toBe(false);
    expect(moved!.params.has('rg')).toBe(false);
    expect(Object.fromEntries(moved!.params)).toMatchObject({ tab: 'advisories', severity: 'high', ruleId: 'r1', category: 'security', tags: 'prod' });
  });

  it('reads back as the same findings the old link showed', async () => {
    const moved = await to(`subscription=${SUB_ONE}&rg=rg-one`);
    expect(viewFromSearchParams(moved!.params).scope).toEqual([GROUP_ONE_IN_ONE]);
  });

  it('resolves a name-only resource group to every pair of that name for someone who holds both subscriptions', async () => {
    const moved = await to('rg=rg-one');
    expect(viewFromSearchParams(moved!.params).scope).toEqual([GROUP_ONE_IN_ONE, GROUP_ONE_IN_TWO]);
  });

  it('resolves a name-only resource group to the pairs the viewer holds, and no other', async () => {
    const moved = await to('rg=rg-one', accessAt(SUB_ONE_PATH));
    expect(viewFromSearchParams(moved!.params).scope).toEqual([GROUP_ONE_IN_ONE]);
    expect(moved!.params.toString()).not.toContain(SUB_TWO);
  });

  it('resolves a name-only resource group through a resource group Scope', async () => {
    const moved = await to('rg=rg-one', accessAt(SCOPE_RESOURCE_GROUP));
    expect(viewFromSearchParams(moved!.params).scope).toEqual([GROUP_ONE_IN_ONE]);
  });

  it('writes a long result as a Scope set of the held pairs only', async () => {
    const subscriptions = Array.from({ length: 40 }, (_, n) => `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`);
    const access = accessAt(...subscriptions.map(id => `/subscriptions/${id}`));
    const moved = await to(`subscription=${subscriptions.join(',')}&rg=rg-one`, access);
    expect(moved!.params.has('scope')).toBe(false);
    const set = await expandScopeSet(moved!.params.get('scopeset')!);
    expect(set).toEqual({ status: 'resolved', paths: subscriptions.map(id => `/subscriptions/${id}/resourceGroups/rg-one`) });
    expect(moved!.params.toString().length).toBeLessThan(SCOPE_INLINE_BUDGET);
  });
});

describe('a link with a value that reaches no pair the viewer holds keeps its legacy params', () => {
  it('leaves an unheld subscription as it was written', async () => {
    expect(await to(`subscription=${SUB_TWO}`, accessAt(SUB_ONE_PATH))).toBeNull();
  });

  it('leaves a partly held link as it was written, so the unheld value stays counted', async () => {
    expect(await to(`subscription=${SUB_ONE},${SUB_TWO}&severity=high`, accessAt(SUB_ONE_PATH))).toBeNull();
  });

  it('leaves a group that no pair the viewer holds carries', async () => {
    expect(await to('rg=rg-two', accessAt(SUB_TWO_PATH))).toBeNull();
  });

  it('leaves a name no record pairs with a subscription, for Everything too', async () => {
    expect(await to('rg=rg-ghost')).toBeNull();
  });
});

describe('a link that needs no translation', () => {
  it('is left alone without a subscription or resource group', async () => {
    expect(await to('severity=high&ruleId=r1&category=security&tags=prod')).toBeNull();
  });

  it('is left alone when it already holds a Scope', async () => {
    expect(await to(`scope=${encodeURIComponent(SUB_ONE_PATH)}&subscription=${SUB_ONE}`)).toBeNull();
  });
});

describe('what the view says about a legacy value the viewer holds no pair of', () => {
  const legacy = (filters: View['filters']): View => ({ ...emptyView(), filters });
  const marks = async (view: View, access: Access) => (await queryView(view, { tab: 'results', showSuppressed: true }, access)).outsideAccess;

  it('marks an unheld subscription and matches nothing', async () => {
    const view = legacy([{ field: 'subscription', values: [SUB_TWO] }]);
    expect(await marks(view, accessAt(SUB_ONE_PATH))).toEqual({ subscriptions: [SUB_TWO], resourceGroups: [] });
    expect((await queryView(view, { tab: 'results', showSuppressed: true }, accessAt(SUB_ONE_PATH))).items).toEqual([]);
  });

  it('marks a name-only group that none of the viewer\'s own pairs carries, even when they hold the whole subscription', async () => {
    const view = legacy([{ field: 'resourceGroup', values: ['rg-two'] }]);
    expect(await marks(view, accessAt(SUB_TWO_PATH))).toEqual({ subscriptions: [], resourceGroups: ['rg-two'] });
  });

  it('marks only the value with no held pair when the link is partly held', async () => {
    const view = legacy([{ field: 'subscription', values: [SUB_ONE, SUB_TWO] }]);
    const response = await queryView(view, { tab: 'results', showSuppressed: true }, accessAt(SCOPE_SUBSCRIPTION));
    expect(response.outsideAccess).toEqual({ subscriptions: [SUB_TWO], resourceGroups: [] });
    expect(response.items.map(i => i.finding.resourceName).sort()).toEqual(['subscription-level', 'vm-one', 'vm-two']);
  });

  it('marks nothing for Everything', async () => {
    const view = legacy([{ field: 'resourceGroup', values: ['rg-ghost'] }]);
    expect(await marks(view, EVERYTHING_ACCESS)).toEqual({ subscriptions: [], resourceGroups: [] });
  });
});
