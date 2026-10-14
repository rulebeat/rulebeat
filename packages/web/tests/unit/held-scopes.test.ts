/**
 * #275: what a person holds, as the ids a picker or a rule's scope names. Pure functions, so each decision is
 * checked without a route: which subscriptions and management groups are held, how a resource group counts,
 * and what is kept of the hierarchy for a person who does not hold Everything.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';
import { heldScopes, holdsManagementGroup, holdsSubscription, limitHierarchy, type HierarchyNode } from '@/lib/held-scopes';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const MG_PATH = '/providers/Microsoft.Management/managementGroups/mg-example';

const holding = (...paths: string[]): Access =>
  buildAccess(paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })), 'manual');

describe('heldScopes', () => {
  it('holds a subscription named by a subscription Scope', () => {
    expect(heldScopes(holding(`/subscriptions/${SUB_A}`))).toEqual({ everything: false, subscriptions: [SUB_A], managementGroups: [] });
  });

  it('holds the subscription of a resource group Scope, once however many groups are held in it', () => {
    const held = heldScopes(holding(`/subscriptions/${SUB_A}/resourceGroups/rg-one`, `/subscriptions/${SUB_A}/resourceGroups/rg-two`));
    expect(held.subscriptions).toEqual([SUB_A]);
  });

  it('holds a management group by the id its path ends in, and no subscription through it', () => {
    expect(heldScopes(holding(MG_PATH))).toEqual({ everything: false, subscriptions: [], managementGroups: ['mg-example'] });
  });

  it('holds the subscriptions and groups under a management group by its expansion', () => {
    const grant = { tenantId: 't', scope: parseScope(MG_PATH)!, role: 'viewer' as const };
    const expansion = { tenantId: 't', path: MG_PATH, role: 'viewer' as const, groups: ['mg-example', 'mg-child'], subscriptions: [SUB_A.toLowerCase(), SUB_B] };
    const held = heldScopes(buildAccess([grant], 'manual', [expansion]));
    expect(held.subscriptions).toEqual([SUB_A.toLowerCase(), SUB_B]);
    expect(held.managementGroups).toEqual(['mg-example', 'mg-child']);
    expect(holdsSubscription(held, SUB_B.toUpperCase())).toBe(true);
  });

  it('holds nothing under a management group whose expansion is missing', () => {
    expect(heldScopes(holding(MG_PATH)).subscriptions).toEqual([]);
  });

  it('holds nothing through the Directory, and nothing at all with no Scope', () => {
    expect(heldScopes(holding('@directory'))).toEqual({ everything: false, subscriptions: [], managementGroups: [] });
    expect(heldScopes(buildAccess([], 'manual'))).toEqual({ everything: false, subscriptions: [], managementGroups: [] });
  });

  it('says Everything is held for a person on Everything', () => {
    expect(heldScopes(everythingAccess('editor', 'manual')).everything).toBe(true);
  });

  it('compares ids without regard to case, keeping the first casing', () => {
    const held = heldScopes(holding(`/subscriptions/${SUB_A.toUpperCase()}`, `/subscriptions/${SUB_A}/resourceGroups/rg-one`));
    expect(held.subscriptions).toEqual([SUB_A.toUpperCase()]);
    expect(holdsSubscription(held, SUB_A)).toBe(true);
    expect(holdsSubscription(held, SUB_B)).toBe(false);
    const group = heldScopes(holding('/PROVIDERS/MICROSOFT.MANAGEMENT/MANAGEMENTGROUPS/MG-Example'));
    expect(holdsManagementGroup(group, 'mg-example')).toBe(true);
    expect(holdsManagementGroup(group, 'mg-other')).toBe(false);
  });

  it('holds every id when Everything is held', () => {
    const held = heldScopes(everythingAccess('admin'));
    expect(holdsSubscription(held, SUB_B)).toBe(true);
    expect(holdsManagementGroup(held, 'anything')).toBe(true);
  });
});

describe('limitHierarchy', () => {
  const sub = (id: string): HierarchyNode => ({ id, type: 'subscription' });
  const group = (id: string, ...children: HierarchyNode[]): HierarchyNode => ({ id, type: 'managementGroup', children });
  const tree = [
    group('root-child', group('mg-example', sub(SUB_A), sub(SUB_B)), group('mg-sibling', sub('other'))),
    group('mg-empty'),
  ];
  const held = (...paths: string[]) => heldScopes(holding(...paths));

  it('keeps a held management group with all that sits under it, at the top level', () => {
    expect(limitHierarchy(tree, held(MG_PATH))).toEqual([group('mg-example', sub(SUB_A), sub(SUB_B))]);
  });

  it('keeps a held subscription alone, with no ancestor and no sibling', () => {
    expect(limitHierarchy(tree, held(`/subscriptions/${SUB_A}`))).toEqual([sub(SUB_A)]);
  });

  it('does not list a held subscription a second time when it sits inside a kept group', () => {
    expect(limitHierarchy(tree, held(MG_PATH, `/subscriptions/${SUB_B}`)).map(n => n.id)).toEqual(['mg-example']);
  });

  it('keeps a held subscription outside the kept group at the top level, beside the group', () => {
    const other = [...tree, group('mg-elsewhere', sub('third'))];
    expect(limitHierarchy(other, held(MG_PATH, '/subscriptions/third')).map(n => n.id)).toEqual(['mg-example', 'third']);
  });

  it('keeps a held group nested inside another held group only inside it', () => {
    const nested = [group('mg-outer', group('mg-inner', sub(SUB_A)))];
    const both = heldScopes(holding(
      '/providers/Microsoft.Management/managementGroups/mg-outer', '/providers/Microsoft.Management/managementGroups/mg-inner',
    ));
    expect(limitHierarchy(nested, both).map(n => n.id)).toEqual(['mg-outer']);
  });

  it('keeps nothing for a person who holds nothing in it', () => {
    expect(limitHierarchy(tree, held('@directory'))).toEqual([]);
    expect(limitHierarchy(tree, held())).toEqual([]);
  });

  it('keeps a held subscription found by its id in any casing', () => {
    expect(limitHierarchy(tree, held(`/subscriptions/${SUB_A.toUpperCase()}`)).map(n => n.id)).toEqual([SUB_A]);
  });
});
