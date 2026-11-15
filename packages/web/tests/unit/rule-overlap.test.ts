/**
 * Which rules can look at what a person holds (posture formula v3). The pure half, over
 * `lib/rule-overlap.ts`: the Scopes a posture number is read over (a person's Access narrowed by the
 * subscription filter) and whether a rule's own scope overlaps them. It reads the same way a run does
 * (`scopeForRule()` and its management group expansion), so a rule counted here is a rule a run of
 * that person would send a request for.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, type Access, type ManagementGroupExpansion, type ScopeGrant } from '@/lib/access-model';
import { narrowScopes, ruleOverlapsScopes } from '@/lib/rule-overlap';
import { DIRECTORY_SUBSCRIPTION } from '@/lib/placement';
import type { HierarchyNode } from '@/lib/management-group-tree';
import type { QueryBackend, RuleScope } from '@/lib/types';

const T = 'tenant-1';
const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const SUB_THREE = '00000000-0000-0000-0000-00000000000c';
const mgPath = (name: string) => `/providers/Microsoft.Management/managementGroups/${name}`;

const subscriptionGrant = (sub: string): ScopeGrant =>
  ({ tenantId: T, scope: { kind: 'subscription', path: `/subscriptions/${sub}` }, role: 'viewer' });
const resourceGroupGrant = (sub: string, rg: string): ScopeGrant =>
  ({ tenantId: T, scope: { kind: 'resourceGroup', path: `/subscriptions/${sub}/resourceGroups/${rg}` }, role: 'viewer' });
const directoryGrant: ScopeGrant = { tenantId: T, scope: { kind: 'directory', path: '@directory' }, role: 'viewer' };
const managementGroupGrant = (name: string): ScopeGrant =>
  ({ tenantId: T, scope: { kind: 'managementGroup', path: mgPath(name) }, role: 'viewer' });

const holds = (...grants: ScopeGrant[]): Access => buildAccess(grants, 'manual');
const expansion = (name: string, groups: string[], subscriptions: string[]): ManagementGroupExpansion =>
  ({ tenantId: T, path: mgPath(name), role: 'viewer', groups, subscriptions });

const rule = (scope: RuleScope | undefined, queryBackend: QueryBackend = 'resource-graph') =>
  ({ queryBackend, scope: scope ?? { level: 'subscription' as const } });

// mg-parent holds mg-child, which holds SUB_ONE and SUB_TWO. SUB_THREE sits under mg-other.
const TREE: HierarchyNode[] = [
  { tenantId: T, kind: 'managementGroup', id: 'mg-parent', name: 'Parent', parentId: null },
  { tenantId: T, kind: 'managementGroup', id: 'mg-child', name: 'Child', parentId: 'mg-parent' },
  { tenantId: T, kind: 'managementGroup', id: 'mg-other', name: 'Other', parentId: null },
  { tenantId: T, kind: 'subscription', id: SUB_ONE, name: 'One', parentId: 'mg-child' },
  { tenantId: T, kind: 'subscription', id: SUB_TWO, name: 'Two', parentId: 'mg-child' },
  { tenantId: T, kind: 'subscription', id: SUB_THREE, name: 'Three', parentId: 'mg-other' },
];

describe('ruleOverlapsScopes: Resource Graph rules', () => {
  const one = holds(subscriptionGrant(SUB_ONE));

  it('an unscoped rule overlaps every subscription a person holds', () => {
    expect(ruleOverlapsScopes(rule(undefined), one, [])).toBe(true);
  });

  it('a rule that names a subscription overlaps a person who holds it, and not one who holds another', () => {
    expect(ruleOverlapsScopes(rule({ level: 'subscription', subscriptions: [SUB_ONE] }), one, [])).toBe(true);
    expect(ruleOverlapsScopes(rule({ level: 'subscription', subscriptions: [SUB_TWO] }), one, [])).toBe(false);
  });

  it('a rule\'s list overlaps when any one entry does', () => {
    expect(ruleOverlapsScopes(rule({ level: 'subscription', subscriptions: [SUB_TWO, SUB_ONE] }), one, [])).toBe(true);
  });

  it('ids compare without regard to case', () => {
    expect(ruleOverlapsScopes(rule({ level: 'subscription', subscriptions: [SUB_ONE.toUpperCase()] }), one, [])).toBe(true);
  });

  it('a resource group Scope overlaps through its subscription', () => {
    const group = holds(resourceGroupGrant(SUB_ONE, 'rg-one'));
    expect(ruleOverlapsScopes(rule({ level: 'subscription', subscriptions: [SUB_ONE] }), group, [])).toBe(true);
    expect(ruleOverlapsScopes(rule({ level: 'subscription', subscriptions: [SUB_TWO] }), group, [])).toBe(false);
  });

  it('a rule that names a management group overlaps a person who holds it or one above it', () => {
    const child = holds(managementGroupGrant('mg-child'));
    const childAccess = buildAccess(child.grants, 'manual', [expansion('mg-child', ['mg-child'], [SUB_ONE, SUB_TWO])]);
    const parentAccess = buildAccess([managementGroupGrant('mg-parent')], 'manual',
      [expansion('mg-parent', ['mg-parent', 'mg-child'], [SUB_ONE, SUB_TWO])]);
    const ofChild = rule({ level: 'managementGroup', managementGroups: ['mg-child'] });
    expect(ruleOverlapsScopes(ofChild, childAccess, TREE)).toBe(true);
    expect(ruleOverlapsScopes(ofChild, parentAccess, TREE)).toBe(true);
  });

  it('a rule that names a management group overlaps a subscription held inside it, from the stored tree', () => {
    const ofParent = rule({ level: 'managementGroup', managementGroups: ['mg-parent'] });
    expect(ruleOverlapsScopes(ofParent, one, TREE)).toBe(true);
    expect(ruleOverlapsScopes(rule({ level: 'managementGroup', managementGroups: ['mg-other'] }), one, TREE)).toBe(false);
  });

  it('a management group the tree does not hold overlaps no one below Everything', () => {
    expect(ruleOverlapsScopes(rule({ level: 'managementGroup', managementGroups: ['mg-parent'] }), one, [])).toBe(false);
  });

  it('a person who holds only the Directory overlaps no Resource Graph rule', () => {
    expect(ruleOverlapsScopes(rule(undefined), holds(directoryGrant), [])).toBe(false);
  });

  it('a person who holds nothing overlaps nothing', () => {
    expect(ruleOverlapsScopes(rule(undefined), holds(), [])).toBe(false);
  });
});

describe('ruleOverlapsScopes: Microsoft Graph rules', () => {
  const graph = rule(undefined, 'microsoft-graph');

  it('overlap only the Directory', () => {
    expect(ruleOverlapsScopes(graph, holds(directoryGrant), [])).toBe(true);
    expect(ruleOverlapsScopes(graph, holds(subscriptionGrant(SUB_ONE)), [])).toBe(false);
    expect(ruleOverlapsScopes(graph, holds(managementGroupGrant('mg-parent')), [])).toBe(false);
  });
});

describe('ruleOverlapsScopes: Everything', () => {
  const everything = everythingAccess('admin');

  it('overlaps every rule, including a management group rule the tree cannot expand', () => {
    expect(ruleOverlapsScopes(rule(undefined), everything, [])).toBe(true);
    expect(ruleOverlapsScopes(rule({ level: 'subscription', subscriptions: [SUB_THREE] }), everything, [])).toBe(true);
    expect(ruleOverlapsScopes(rule({ level: 'managementGroup', managementGroups: ['mg-gone'] }), everything, [])).toBe(true);
    expect(ruleOverlapsScopes(rule(undefined, 'microsoft-graph'), everything, [])).toBe(true);
  });
});

describe('narrowScopes: the Access intersected with the subscription filter', () => {
  const reads = (scopes: Access, subscription: string) =>
    ruleOverlapsScopes(rule({ level: 'subscription', subscriptions: [subscription] }), scopes, TREE);

  it('is the Access itself when there is no filter', () => {
    const access = holds(subscriptionGrant(SUB_ONE));
    expect(narrowScopes(access, undefined)).toBe(access);
  });

  it('keeps only the filtered subscriptions of a person who holds several', () => {
    const scopes = narrowScopes(holds(subscriptionGrant(SUB_ONE), subscriptionGrant(SUB_TWO)), [SUB_ONE]);
    expect(reads(scopes, SUB_ONE)).toBe(true);
    expect(reads(scopes, SUB_TWO)).toBe(false);
  });

  it('holds nothing of a subscription the person does not hold', () => {
    const scopes = narrowScopes(holds(subscriptionGrant(SUB_ONE)), [SUB_TWO]);
    expect(reads(scopes, SUB_TWO)).toBe(false);
    expect(ruleOverlapsScopes(rule(undefined), scopes, TREE)).toBe(false);
  });

  it('reaches a subscription held through a management group', () => {
    const access = buildAccess([managementGroupGrant('mg-child')], 'manual', [expansion('mg-child', ['mg-child'], [SUB_ONE, SUB_TWO])]);
    const scopes = narrowScopes(access, [SUB_TWO]);
    expect(reads(scopes, SUB_TWO)).toBe(true);
    expect(reads(scopes, SUB_ONE)).toBe(false);
  });

  it('keeps the resource groups a person holds in a filtered subscription', () => {
    const scopes = narrowScopes(holds(resourceGroupGrant(SUB_ONE, 'rg-one'), resourceGroupGrant(SUB_TWO, 'rg-two')), [SUB_ONE]);
    expect(reads(scopes, SUB_ONE)).toBe(true);
    expect(reads(scopes, SUB_TWO)).toBe(false);
  });

  it('narrows Everything to the filtered subscriptions, so a rule of another subscription drops out', () => {
    const scopes = narrowScopes(everythingAccess('admin'), [SUB_ONE]);
    expect(reads(scopes, SUB_ONE)).toBe(true);
    expect(reads(scopes, SUB_TWO)).toBe(false);
    expect(ruleOverlapsScopes(rule({ level: 'managementGroup', managementGroups: ['mg-parent'] }), scopes, TREE)).toBe(true);
  });

  it('keeps the Directory only when it is filtered and held', () => {
    const access = holds(subscriptionGrant(SUB_ONE), directoryGrant);
    const graph = rule(undefined, 'microsoft-graph');
    expect(ruleOverlapsScopes(graph, narrowScopes(access, [SUB_ONE]), TREE)).toBe(false);
    expect(ruleOverlapsScopes(graph, narrowScopes(access, [DIRECTORY_SUBSCRIPTION]), TREE)).toBe(true);
    expect(ruleOverlapsScopes(graph, narrowScopes(holds(subscriptionGrant(SUB_ONE)), [DIRECTORY_SUBSCRIPTION]), TREE)).toBe(false);
    expect(ruleOverlapsScopes(graph, narrowScopes(everythingAccess('admin'), [DIRECTORY_SUBSCRIPTION]), TREE)).toBe(true);
  });

  it('an empty list is a filter that matches nothing, not no filter', () => {
    expect(ruleOverlapsScopes(rule(undefined), narrowScopes(everythingAccess('admin'), []), TREE)).toBe(false);
  });
});
