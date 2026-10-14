/**
 * #272: what the Access page's Scope picker does to the list it edits. Pure, so no rendering: a Scope is
 * held once whatever its casing, taking the Role the person-level select names, and a list read from a
 * person's access leaves out what cannot be saved.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, parseScope, type ManualGrant } from '@/lib/access-model';
import {
  canInvite, describeScopePath, grantsOfAccess, heldAt, resourceGroupScopePath, resourceGroupsHeld, setEveryRole, setGrantRole,
  pickerGroups, subscriptionScopePath, subscriptionsNamed, toggleGrant,
} from '@/lib/access-picker';

const SUB = '00000000-0000-0000-0000-00000000000a';
const OTHER = '00000000-0000-0000-0000-00000000000b';

describe('building and toggling Scopes', () => {
  it('builds the paths the server parses back', () => {
    expect(parseScope(subscriptionScopePath(SUB))?.kind).toBe('subscription');
    expect(parseScope(resourceGroupScopePath(SUB, 'rg-one'))?.kind).toBe('resourceGroup');
  });

  it('holds a Scope at the given Role, and drops it when toggled again, whatever the casing', () => {
    const path = subscriptionScopePath(SUB);
    const held = toggleGrant([], path, 'editor');
    expect(held).toEqual([{ scope: path, role: 'editor' }]);
    expect(heldAt(held, path.toUpperCase())).toBeDefined();
    expect(toggleGrant(held, path.toUpperCase(), 'viewer')).toEqual([]);
  });

  it('sets the Role at one Scope and at every Scope', () => {
    const list: ManualGrant[] = [{ scope: '/', role: 'viewer' }, { scope: '@directory', role: 'viewer' }];
    expect(setGrantRole(list, '@DIRECTORY', 'editor')).toEqual([{ scope: '/', role: 'viewer' }, { scope: '@directory', role: 'editor' }]);
    expect(setEveryRole(list, 'editor').map(g => g.role)).toEqual(['editor', 'editor']);
  });
});

describe('reading a person\'s access into the picker', () => {
  it('keeps each Scope with its Role, a management group included, so an Edit saved unchanged removes nothing', () => {
    const access = buildAccess([
      { tenantId: 't', scope: parseScope(subscriptionScopePath(SUB))!, role: 'viewer' },
      { tenantId: 't', scope: parseScope('/providers/Microsoft.Management/managementGroups/mg')!, role: 'viewer' },
      { tenantId: 't', scope: parseScope('@directory')!, role: 'editor' },
    ], 'manual');
    expect(grantsOfAccess(access)).toEqual([
      { scope: subscriptionScopePath(SUB), role: 'viewer' },
      { scope: '/providers/Microsoft.Management/managementGroups/mg', role: 'viewer' },
      { scope: '@directory', role: 'editor' },
    ]);
  });

  it('finds the resource groups held in one subscription and the subscriptions a list names', () => {
    const list: ManualGrant[] = [
      { scope: resourceGroupScopePath(SUB, 'rg-one'), role: 'viewer' },
      { scope: resourceGroupScopePath(SUB.toUpperCase(), 'rg-two'), role: 'viewer' },
      { scope: resourceGroupScopePath(OTHER, 'rg-one'), role: 'editor' },
      { scope: subscriptionScopePath(OTHER), role: 'viewer' },
      { scope: '/', role: 'viewer' },
    ];
    expect(resourceGroupsHeld(list, SUB)).toEqual(['rg-one', 'rg-two']);
    expect(resourceGroupsHeld(list, OTHER)).toEqual(['rg-one']);
    expect(subscriptionsNamed(list)).toEqual([SUB, OTHER]);
  });
});

describe('naming a Scope', () => {
  it('names each kind, using a subscription\'s display name when it is known', () => {
    const names = { [SUB]: 'Production' };
    expect(describeScopePath('/')).toBe('Everything');
    expect(describeScopePath('@directory')).toBe('Directory');
    expect(describeScopePath(subscriptionScopePath(SUB), names)).toBe('Production');
    expect(describeScopePath(subscriptionScopePath(OTHER), names)).toBe(OTHER);
    expect(describeScopePath(resourceGroupScopePath(SUB, 'rg-one'), names)).toBe('rg-one in Production');
  });
});

describe('who can be invited', () => {
  it('needs an email and at least one Scope', () => {
    const one: ManualGrant[] = [{ scope: '/', role: 'viewer' }];
    expect(canInvite('a@example.com', one)).toBe(true);
    expect(canInvite('a@example.com', [])).toBe(false);
    expect(canInvite('  ', one)).toBe(false);
  });
});

describe('the management groups the picker lists (#273)', () => {
  const T = 'tenant-one';
  const node = (id: string, name: string, parentId: string | null, kind: 'managementGroup' | 'subscription' = 'managementGroup') => ({ id, kind, name, parentId });
  const loaded = { lastSuccessAt: '2026-06-02T00:00:00.000Z', lastAttemptAt: '2026-06-02T00:00:00.000Z', error: null };
  const view = {
    nodes: [node(T, 'Root', null), node('mg-b', 'Beta', T), node('mg-a', 'Alpha', T), node('mg-a-child', 'Under alpha', 'mg-a'), node('sub-1', 'One', 'mg-a', 'subscription')],
    status: loaded,
  };

  it('lists every management group in tree order with its depth, and no subscription', () => {
    const { groups, reason } = pickerGroups(view, []);
    expect(groups.map(g => [g.id, g.name, g.depth, g.missing])).toEqual([
      [T, 'Root', 0, false], ['mg-a', 'Alpha', 1, false], ['mg-a-child', 'Under alpha', 2, false], ['mg-b', 'Beta', 1, false],
    ]);
    expect(groups[1]!.path).toBe('/providers/Microsoft.Management/managementGroups/mg-a');
    expect(reason).toBeNull();
  });

  it('lists a held group the tree does not have after the others, so it can be removed', () => {
    const held: ManualGrant[] = [
      { scope: '/providers/Microsoft.Management/managementGroups/mg-gone', role: 'editor' },
      { scope: '/providers/Microsoft.Management/managementGroups/MG-A', role: 'viewer' },
      { scope: '/subscriptions/00000000-0000-0000-0000-00000000000a', role: 'viewer' },
    ];
    const { groups } = pickerGroups(view, held);
    expect(groups.map(g => [g.id, g.missing])).toEqual([
      [T, false], ['mg-a', false], ['mg-a-child', false], ['mg-b', false], ['mg-gone', true],
    ]);
    expect(groups.at(-1)!.path).toBe(held[0]!.scope);
  });

  it('lists a held group when there is no tree at all, and still says why the tree is empty', () => {
    const held: ManualGrant[] = [{ scope: '/providers/Microsoft.Management/managementGroups/mg-gone', role: 'viewer' }];
    const { groups, reason } = pickerGroups({ nodes: [], status: { lastSuccessAt: null, lastAttemptAt: null, error: null } }, held);
    expect(groups.map(g => [g.id, g.missing])).toEqual([['mg-gone', true]]);
    expect(reason).toMatch(/has not been loaded yet/);
  });

  it('says why it lists none: never refreshed, the last refresh failed, or Azure is not connected', () => {
    const reasons = [
      pickerGroups({ nodes: [], status: { lastSuccessAt: null, lastAttemptAt: null, error: null } }, []).reason,
      pickerGroups({ nodes: [], status: { lastSuccessAt: null, lastAttemptAt: 'A', error: { code: 'failed', message: 'x' } } }, []).reason,
      pickerGroups({ nodes: [], status: { lastSuccessAt: null, lastAttemptAt: 'A', error: { code: 'azure_not_configured', message: 'x' } } }, []).reason,
    ];
    expect(reasons.every(r => typeof r === 'string' && r.length > 0)).toBe(true);
    expect(new Set(reasons).size).toBe(3);
  });

  it('names a management group by its display name when it has one', () => {
    const path = '/providers/Microsoft.Management/managementGroups/mg-a';
    expect(describeScopePath(path)).toBe('Management group mg-a');
    expect(describeScopePath(path, { 'mg-a': 'Alpha' })).toBe('Management group Alpha');
  });
});
