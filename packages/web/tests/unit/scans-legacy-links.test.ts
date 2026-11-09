/**
 * #392: an old `/scans` link that carries `subscription=` and `rg=` opens as Scope picks. The Scans page asks
 * `legacyLinkRedirect` where the address should go, and the view read marks the values that reach no pair the
 * viewer holds. Driven over the access matrix's seed on whichever backend the suite opened (the SQLite run and
 * the Postgres run, RULEBEAT_TEST_PG_URL, read the same).
 */
import { isValidElement, type ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { MATRIX_TENANT, SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, SUB_ONE, SUB_TWO, createPeople, matrixHierarchy, seedMatrix } from '../helpers/access-matrix';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { expandManagementGroups } from '@/lib/management-group-tree';
import { legacyLinkRedirect, markedSavedViews } from '@/lib/db/legacy-scope-link';
import { expandScopeSet } from '@/lib/db/scope-sets';
import { openExport, queryColumnValues, queryGroup, queryView } from '@/lib/db/finding-views';
import { emptyListCopy, emptyReasonOf, filterValueLabel } from '@/lib/explorer-screen';
import { emptyView, viewFromSearchParams, type View } from '@/lib/finding-view';
import { SCOPE_INLINE_BUDGET } from '@/lib/finding-view';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', async (original) => ({
  ...(await original<typeof import('next/navigation')>()),
  redirect: (href: string) => { throw new Error(`REDIRECT ${href}`); },
}));

const nodes = matrixHierarchy().nodes;
const SUB_ONE_PATH = `/subscriptions/${SUB_ONE}`;
const SUB_TWO_PATH = `/subscriptions/${SUB_TWO}`;
const GROUP_ONE_IN_ONE = `${SUB_ONE_PATH}/resourceGroups/rg-one`;
const GROUP_ONE_IN_TWO = `${SUB_TWO_PATH}/resourceGroups/rg-one`;

function accessAt(...paths: string[]): Access {
  const grants = paths.map(path => ({ tenantId: MATRIX_TENANT, scope: parseScope(path)!, role: 'viewer' as const }));
  return buildAccess(grants, 'manual', expandManagementGroups(grants, nodes));
}

const userIds: Record<string, string> = {};

beforeAll(async () => {
  await resetDb();
  Object.assign(userIds, await createPeople());
  await seedMatrix();
});

const to = async (query: string, access: Access = EVERYTHING_ACCESS) => {
  const href = await legacyLinkRedirect(Object.fromEntries(new URLSearchParams(query)), access);
  return href === null ? null : { path: href.split('?')[0], params: new URLSearchParams(href.split('?')[1]) };
};

const listed = async (view: View, access: Access): Promise<string[]> =>
  (await queryView(view, { tab: 'results', showSuppressed: true }, access)).items.map(i => i.finding.resourceName ?? '').sort();

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
    expect(await listed(viewFromSearchParams(moved!.params), EVERYTHING_ACCESS)).toEqual(['vm-one']);
  });

  it.each([
    ['a subscription', `subscription=${SUB_ONE}`, accessAt(SUB_ONE_PATH)],
    ['a name-only resource group', 'rg=rg-one', accessAt(SUB_ONE_PATH, SUB_TWO_PATH)],
    ['a name-only resource group for someone who holds one of its subscriptions', 'rg=rg-one', accessAt(SUB_TWO_PATH)],
    ['a name in other case', 'rg=RG-ONE', EVERYTHING_ACCESS],
  ])('lists the findings of %s the way the untranslated link does', async (_name, query, access) => {
    const moved = await to(query, access);
    const old = await listed(viewFromSearchParams(new URLSearchParams(query)), access);
    expect(old.length).toBeGreaterThan(0);
    expect(await listed(viewFromSearchParams(moved!.params), access)).toEqual(old);
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

  it('marks nothing as outside the access of Everything', async () => {
    const view = legacy([{ field: 'resourceGroup', values: ['rg-ghost'] }]);
    expect(await marks(view, EVERYTHING_ACCESS)).toEqual({ subscriptions: [], resourceGroups: [] });
  });
});

describe('what a link that was not redirected lists', () => {
  const link = (query: string) => viewFromSearchParams(new URLSearchParams(query));
  const read = (query: string, access: Access) => queryView(link(query), { tab: 'results', showSuppressed: true }, access);

  it('lists the held pair of a group name, whatever its case, with an unheld name beside it', async () => {
    const alone = await listed(link('rg=RG-ONE'), accessAt(SUB_ONE_PATH));
    expect(alone).toEqual(['vm-one']);
    const response = await read('rg=RG-ONE,rg-ghost', accessAt(SUB_ONE_PATH));
    expect(response.items.map(i => i.finding.resourceName)).toEqual(alone);
    expect(response.outsideAccess).toEqual({ subscriptions: [], resourceGroups: ['rg-ghost'] });
  });

  it('lists the held subscription of a link whose id is in upper case, with an unheld one beside it', async () => {
    const response = await read(`subscription=${SUB_ONE.toUpperCase()},${SUB_TWO}`, accessAt(SUB_ONE_PATH));
    expect(response.items.map(i => i.finding.resourceName).sort()).toEqual(['subscription-level', 'vm-one', 'vm-two']);
    expect(response.outsideAccess).toEqual({ subscriptions: [SUB_TWO], resourceGroups: [] });
  });

  it('lists every pair of a name-only group for Everything, and names the value no record pairs as gone', async () => {
    const response = await read('rg=RG-ONE,rg-ghost', EVERYTHING_ACCESS);
    expect(response.items.map(i => i.finding.resourceName).sort()).toEqual(['vm-one', 'vm-other-sub']);
    expect(response.filterStates.legacyGone).toEqual({ subscriptions: [], resourceGroups: ['rg-ghost'] });
    expect(response.outsideAccess).toEqual({ subscriptions: [], resourceGroups: [] });
  });

  it('reads the same pairs in a group, a column\'s values and an export', async () => {
    const access = accessAt(SUB_ONE_PATH);
    const asked = link('rg=RG-ONE,rg-ghost');
    const group = await queryGroup({ ...asked, groupBy: ['kind'] }, { tab: 'results', showSuppressed: true, groupPath: ['state'], groupPage: 1 }, access);
    expect(group.items.map(i => i.finding.resourceName)).toEqual(['vm-one']);
    const values = await queryColumnValues(asked, { tab: 'results', showSuppressed: true, column: 'row.zone' }, access);
    expect(values.values).toEqual([{ value: 'a', count: 1 }]);
    const names: string[] = [];
    await openExport(asked, { tab: 'results', showSuppressed: true }, access)(async source => {
      for await (const batch of source.batches()) for (const piece of batch) names.push(piece.finding.resourceName ?? '');
    });
    expect(names).toEqual(['vm-one']);
  });

  it('says a value no record pairs no longer exists, and that an empty list holds only such values', async () => {
    const asked = link('rg=rg-ghost');
    const response = await read('rg=rg-ghost', EVERYTHING_ACCESS);
    expect(response.items).toEqual([]);
    expect(filterValueLabel('resourceGroup', 'rg-ghost', response.outsideAccess, response.filterStates, v => v)).toBe('rg-ghost (no longer exists)');
    const reason = emptyReasonOf({ filters: asked.filters, outsideAccess: response.outsideAccess, filterStates: response.filterStates });
    expect(reason).toBe('legacy-gone');
    expect(emptyListCopy(reason, 'findings')).toContain('no longer exist');
  });

  it('does not say a value that matches no pair is gone while another value of its dimension matches', async () => {
    const asked = link('rg=RG-ONE,rg-ghost');
    const response = await read('rg=RG-ONE,rg-ghost', EVERYTHING_ACCESS);
    expect(emptyReasonOf({ filters: asked.filters, outsideAccess: response.outsideAccess, filterStates: response.filterStates })).toBe('filters');
    expect(filterValueLabel('resourceGroup', 'RG-ONE', response.outsideAccess, response.filterStates, v => v)).toBe('RG-ONE');
  });

  it('counts an unheld group as outside the viewer\'s access, never as gone', async () => {
    const asked = link('rg=rg-two');
    const response = await read('rg=rg-two', accessAt(SCOPE_RESOURCE_GROUP));
    expect(response.items).toEqual([]);
    expect(response.outsideAccess.resourceGroups).toEqual(['rg-two']);
    expect(emptyReasonOf({ filters: asked.filters, outsideAccess: response.outsideAccess, filterStates: response.filterStates })).toBe('access');
  });
});

describe('what a saved view says about its old subscription and resource group values', () => {
  it('marks by held pairs, as the Scans page does', async () => {
    const view = { id: 'v', query: 'rg=rg-one&severity=high' };
    const [held] = await markedSavedViews(accessAt(SUB_TWO_PATH), [view]);
    expect(held).toEqual({ ...view, outsideAccess: { subscriptions: [], resourceGroups: [] } });
    // rg-two is a group of subscription one only, so someone who holds subscription two holds no pair of it.
    const [outside] = await markedSavedViews(accessAt(SUB_TWO_PATH), [{ query: 'rg=rg-two' }]);
    expect(outside!.outsideAccess).toEqual({ subscriptions: [], resourceGroups: ['rg-two'] });
  });

  it('marks a name no pair the viewer holds carries, though they hold a whole subscription', async () => {
    const [ghost] = await markedSavedViews(accessAt(SUB_TWO_PATH), [{ query: 'rg=rg-ghost' }]);
    expect(ghost!.outsideAccess.resourceGroups).toEqual(['rg-ghost']);
  });

  it('marks nothing for Everything or a query with neither value', async () => {
    const marked = await markedSavedViews(EVERYTHING_ACCESS, [{ query: 'rg=rg-ghost' }, { query: 'severity=high' }]);
    expect(marked.map(m => m.outsideAccess)).toEqual([{ subscriptions: [], resourceGroups: [] }, { subscriptions: [], resourceGroups: [] }]);
  });
});

describe('the Scans page', () => {
  type Props = Record<string, unknown>;
  const signIn = (name: string) => mockAuth.mockResolvedValue({ user: { uid: userIds[name] } });
  const open = async (query: Record<string, string>) => {
    const { default: ScansPage } = await import('@/app/(app)/scans/page');
    return ScansPage({ searchParams: Promise.resolve(query) });
  };
  const findElement = (node: unknown, name: string): ReactElement<Props> | undefined => {
    if (Array.isArray(node)) return node.map(child => findElement(child, name)).find(Boolean);
    if (!isValidElement(node)) return undefined;
    const element = node as ReactElement<Props>;
    return (element.type as { name?: string }).name === name ? element : findElement(element.props.children, name);
  };

  it('replaces the address of an old link whose every value reaches a held pair', async () => {
    signIn('Viewer on one subscription');
    await expect(open({ rg: 'RG-ONE', severity: 'high' })).rejects.toThrow(`REDIRECT /scans?severity=high&scope=${encodeURIComponent(GROUP_ONE_IN_ONE)}`);
  });

  it('opens a link with a value the viewer holds no pair of as it is written, with that value still a filter', async () => {
    signIn('Viewer on one subscription');
    const view = findElement(await open({ rg: 'RG-ONE,rg-ghost' }), 'ScansClient')!.props.initialView as View;
    expect(view.filters).toEqual([{ field: 'resourceGroup', values: ['RG-ONE', 'rg-ghost'] }]);
  });

  it('does not move a tab that lists no findings, or a link with no old value', async () => {
    signIn('Viewer on one subscription');
    expect(findElement(await open({ tab: 'rules', rg: 'rg-one' }), 'ScansClient')).toBeDefined();
    expect(findElement(await open({ severity: 'high' }), 'ScansClient')).toBeDefined();
  });
});
