/**
 * #273: the management group tree as data. Pure, so no database: what a grant expands to, how the tree is
 * ordered for the page and the picker, when a refresh is due, and the words the page uses about the last one.
 */
import { describe, expect, it } from 'vitest';
import { parseScope, type ScopeGrant } from '@/lib/access-model';
import {
  describeHierarchyStatus, expandManagementGroups, hasManagementGroup, noGroupsReason, orderedGroups, orderedTree, refreshDue,
  REFRESH_INTERVAL_MS, type HierarchyNode, type HierarchyStatus,
} from '@/lib/management-group-tree';

const T = 'tenant-one';
const mg = (id: string): string => `/providers/Microsoft.Management/managementGroups/${id}`;
const grant = (path: string, tenantId = T): ScopeGrant => ({ tenantId, scope: parseScope(path)!, role: 'viewer' });
const g = (id: string, name: string, parentId: string | null, tenantId = T): HierarchyNode => ({ tenantId, kind: 'managementGroup', id, name, parentId });
const s = (id: string, name: string, parentId: string, tenantId = T): HierarchyNode => ({ tenantId, kind: 'subscription', id, name, parentId });

const NODES = [
  g(T, 'Root', null), g('mg-a', 'Alpha', T), g('mg-b', 'Beta', 'mg-a'), g('mg-c', 'Gamma', 'mg-b'), g('mg-side', 'Side', T),
  s('sub-1', 'One', 'mg-a'), s('sub-2', 'Two', 'mg-c'), s('sub-3', 'Three', 'mg-side'),
];

describe('expandManagementGroups', () => {
  it('lists the group, every group beneath it at any depth, and every subscription under any of them', () => {
    const [expansion] = expandManagementGroups([grant(mg('mg-a'))], NODES);
    expect(expansion!.groups.sort()).toEqual(['mg-a', 'mg-b', 'mg-c']);
    expect(expansion!.subscriptions.sort()).toEqual(['sub-1', 'sub-2']);
    expect(expansion).toMatchObject({ tenantId: T, path: mg('mg-a'), role: 'viewer' });
  });

  it('lists nothing above or beside the group', () => {
    const [expansion] = expandManagementGroups([grant(mg('mg-b'))], NODES);
    expect(expansion!.groups.sort()).toEqual(['mg-b', 'mg-c']);
    expect(expansion!.subscriptions).toEqual(['sub-2']);
  });

  it('expands every management group grant, and no other kind of grant', () => {
    const expansions = expandManagementGroups([grant(mg('mg-side')), grant('/subscriptions/sub-1'), grant('@directory'), grant('/'), grant(mg('mg-c'))], NODES);
    expect(expansions.map(e => e.path)).toEqual([mg('mg-side'), mg('mg-c')]);
  });

  it('uses only the nodes of the grant\'s own tenant', () => {
    const other = [g('mg-a', 'Alpha', null, 'tenant-two'), s('sub-9', 'Nine', 'mg-a', 'tenant-two')];
    const [one] = expandManagementGroups([grant(mg('mg-a'), T)], [...NODES, ...other]);
    expect(one!.subscriptions.sort()).toEqual(['sub-1', 'sub-2']);
    const [two] = expandManagementGroups([grant(mg('mg-a'), 'tenant-two')], [...NODES, ...other]);
    expect(two!.subscriptions).toEqual(['sub-9']);
    expect(expandManagementGroups([grant(mg('mg-a'), 'tenant-three')], NODES)).toEqual([
      { tenantId: 'tenant-three', path: mg('mg-a'), role: 'viewer', groups: [], subscriptions: [] },
    ]);
  });

  it('covers nothing for a group the tree does not hold, itself included', () => {
    expect(expandManagementGroups([grant(mg('mg-unknown'))], NODES)[0]).toMatchObject({ groups: [], subscriptions: [] });
  });

  it('compares ids without regard to case, and lowercases what it lists', () => {
    const [expansion] = expandManagementGroups([grant(mg('MG-A'))], [g('Mg-A', 'Alpha', null), s('SUB-X', 'X', 'mG-a')]);
    expect(expansion).toMatchObject({ groups: ['mg-a'], subscriptions: ['sub-x'] });
  });

  it('ends on a tree that loops back on itself', () => {
    const loop = [g('mg-a', 'A', 'mg-b'), g('mg-b', 'B', 'mg-a'), s('sub-1', 'One', 'mg-b')];
    expect(expandManagementGroups([grant(mg('mg-a'))], loop)[0]).toMatchObject({ groups: expect.arrayContaining(['mg-a', 'mg-b']), subscriptions: ['sub-1'] });
  });
});

describe('orderedTree', () => {
  it('walks each group before what is under it, groups before subscriptions, each by name', () => {
    expect(orderedTree(NODES).map(o => [o.node.id, o.depth])).toEqual([
      [T, 0], ['mg-a', 1], ['mg-b', 2], ['mg-c', 3], ['sub-2', 4], ['sub-1', 2], ['mg-side', 1], ['sub-3', 2],
    ]);
  });

  it('is not changed by the order the rows come in', () => {
    expect(orderedTree([...NODES].reverse()).map(o => o.node.id)).toEqual(orderedTree(NODES).map(o => o.node.id));
  });

  it('keeps a node whose parent is not in the list, as a root', () => {
    expect(orderedTree([s('sub-1', 'One', 'mg-gone'), g('mg-a', 'Alpha', null)]).map(o => [o.node.id, o.depth])).toEqual([['mg-a', 0], ['sub-1', 0]]);
  });

  it('lists a loop that no root reaches, each node once, from its first node by name', () => {
    const loop = [g('mg-b', 'B', 'mg-a'), g('mg-a', 'A', 'mg-b'), s('sub-1', 'One', 'mg-b')];
    expect(orderedTree(loop).map(o => [o.node.id, o.depth])).toEqual([['mg-a', 0], ['mg-b', 1], ['sub-1', 2]]);
  });

  it('lists a node once when its id comes twice under different parents', () => {
    const twice = [g('mg-a', 'A', null), g('mg-b', 'B', null), s('sub-1', 'One', 'mg-a'), s('SUB-1', 'One again', 'mg-b')];
    expect(orderedTree(twice).map(o => [o.node.id, o.depth])).toEqual([['mg-a', 0], ['sub-1', 1], ['mg-b', 0]]);
  });

  it('lists only the groups for the picker', () => {
    expect(orderedGroups(NODES).map(o => o.node.id)).toEqual([T, 'mg-a', 'mg-b', 'mg-c', 'mg-side']);
  });
});

describe('hasManagementGroup', () => {
  it('finds a group in the tenant whatever the casing, and not a subscription, another tenant or an unknown id', () => {
    expect(hasManagementGroup(NODES, T, 'MG-A')).toBe(true);
    expect(hasManagementGroup(NODES, T, 'sub-1')).toBe(false);
    expect(hasManagementGroup(NODES, 'tenant-two', 'mg-a')).toBe(false);
    expect(hasManagementGroup(NODES, T, 'mg-unknown')).toBe(false);
  });
});

describe('refreshDue', () => {
  const now = new Date('2026-06-02T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('is due when nothing has been tried, and when the last attempt is an hour old or more', () => {
    expect(refreshDue({ lastAttemptAt: null }, now)).toBe(true);
    expect(refreshDue({ lastAttemptAt: ago(REFRESH_INTERVAL_MS) }, now)).toBe(true);
    expect(refreshDue({ lastAttemptAt: ago(REFRESH_INTERVAL_MS + 1) }, now)).toBe(true);
  });

  it('is not due before the hour is up', () => {
    expect(refreshDue({ lastAttemptAt: ago(REFRESH_INTERVAL_MS - 1) }, now)).toBe(false);
    expect(refreshDue({ lastAttemptAt: ago(0) }, now)).toBe(false);
  });

  it('is due when the stored time is not a time', () => {
    expect(refreshDue({ lastAttemptAt: 'not a date' }, now)).toBe(true);
  });
});

describe('the words about the last refresh', () => {
  const format = (iso: string) => `<${iso}>`;
  const failed = { code: 'failed', message: 'x' } as const;
  const status = (over: Partial<HierarchyStatus>): HierarchyStatus => ({ lastSuccessAt: null, lastAttemptAt: null, error: null, ...over });

  it('says when the tree was last read', () => {
    expect(describeHierarchyStatus(status({ lastSuccessAt: 'A', lastAttemptAt: 'A' }), format)).toBe('Last refreshed <A>.');
  });

  it('says a failed refresh failed, when, and that the tree shown is the last one that loaded', () => {
    expect(describeHierarchyStatus(status({ lastSuccessAt: 'A', lastAttemptAt: 'B', error: failed }), format))
      .toBe('The last refresh failed on <B>. The tree shown is the last one that loaded, on <A>.');
  });

  it('says a failed refresh with nothing ever loaded left no tree', () => {
    expect(describeHierarchyStatus(status({ lastAttemptAt: 'B', error: failed }), format)).toBe('The last refresh failed on <B>, and no tree has loaded yet.');
  });

  it('says nothing has been read yet, and what to do', () => {
    expect(describeHierarchyStatus(status({}), format)).toBe('The tree has not been loaded yet. Use Refresh to read it from Azure.');
  });
});

describe('noGroupsReason: why the Scope picker lists no management group', () => {
  const status = (over: Partial<HierarchyStatus>): HierarchyStatus => ({ lastSuccessAt: null, lastAttemptAt: null, error: null, ...over });

  it('is null when the tree has a group, whatever the status says', () => {
    expect(noGroupsReason(NODES, status({ error: { code: 'failed', message: 'x' } }))).toBeNull();
  });

  it('says the tree has never been read', () => {
    expect(noGroupsReason([], status({}))).toMatch(/has not been loaded yet/);
  });

  it('says the last refresh failed', () => {
    expect(noGroupsReason([], status({ lastAttemptAt: 'B', error: { code: 'failed', message: 'x' } }))).toMatch(/last refresh .* failed/);
  });

  it('says Azure is not connected', () => {
    expect(noGroupsReason([], status({ lastAttemptAt: 'B', error: { code: 'azure_not_configured', message: 'x' } }))).toMatch(/Azure is not connected/);
  });

  it('says Azure returned none when a read succeeded with no group, and a tree of subscriptions alone is still none', () => {
    expect(noGroupsReason([], status({ lastSuccessAt: 'A', lastAttemptAt: 'A' }))).toMatch(/Azure returned no management groups/);
    expect(noGroupsReason([s('sub-1', 'One', 'mg-a')], status({ lastSuccessAt: 'A', lastAttemptAt: 'A' }))).toMatch(/Azure returned no management groups/);
  });
});
