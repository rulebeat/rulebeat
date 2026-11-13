/**
 * A management group is expanded once for a tree and reused for every subscription and every rule scoped
 * to it (ADR 0013's bench). The numbers a refresh writes must not move: an overlap answered from the shared
 * expansion is the one a fresh read of the same tree gives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Access } from '@/lib/access-model';
import type { HierarchyNode } from '@/lib/management-group-tree';
import { ruleOverlapsScopes, narrowScopes } from '@/lib/rule-overlap';
import { scopeForRule, subscriptionsAskedFor } from '@/lib/run-scope';
import type { Rule } from '@/lib/types';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { group, subscription } from '../helpers/fake-hierarchy';

const expansions = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/management-group-tree', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/management-group-tree')>();
  return {
    ...actual,
    expandManagementGroups: (...args: Parameters<typeof actual.expandManagementGroups>) => {
      expansions.calls++;
      return actual.expandManagementGroups(...args);
    },
  };
});

const TENANT = 'tenant-one';
const GROUPS = ['Top', 'north', 'South', 'north-a', 'north-b', 'empty'];
const PARENT: Record<string, string | null> = { Top: null, north: 'Top', South: 'Top', 'north-a': 'north', 'north-b': 'north', empty: 'South' };

function tree(subscriptions: number): HierarchyNode[] {
  const nodes: HierarchyNode[] = GROUPS.map(id => group(id, id, PARENT[id]!, TENANT));
  for (let i = 0; i < subscriptions; i += 1) {
    const under = GROUPS[i % GROUPS.length]!;
    nodes.push(subscription(`SUB-${i}`, `Sub ${i}`, under, TENANT));
  }
  return nodes;
}

const rule = (id: string, scope: Rule['scope']): Pick<Rule, 'id' | 'queryBackend' | 'scope'> =>
  ({ id, queryBackend: 'resource-graph', scope });

const RULES = [
  rule('all', { level: 'subscription' }),
  rule('top', { level: 'managementGroup', managementGroups: ['top'] }),
  rule('north', { level: 'managementGroup', managementGroups: ['NORTH'] }),
  rule('south-and-a', { level: 'managementGroup', managementGroups: ['south', 'north-a'] }),
  rule('empty', { level: 'managementGroup', managementGroups: ['empty'] }),
  rule('unknown', { level: 'managementGroup', managementGroups: ['not-in-the-tree'] }),
  rule('list', { level: 'subscription', subscriptions: ['sub-3', 'SUB-4'] }),
  rule('mixed', { level: 'managementGroup', subscriptions: ['sub-0'], managementGroups: ['north-b'] }),
];

beforeEach(() => { expansions.calls = 0; });

describe('the overlap of a rule scoped to a management group', () => {
  const hierarchy = tree(30);
  const levels = (): Access[] => hierarchy.filter(n => n.kind === 'subscription').map(n => narrowScopes(EVERYTHING_ACCESS, [n.id.toLowerCase()]));

  it('is the same from the shared expansion as from a fresh read of the tree, for every rule and subscription', () => {
    for (const level of levels()) {
      for (const r of RULES) {
        const fresh = [...hierarchy]; // a new array is read in full, with nothing shared
        expect(ruleOverlapsScopes(r, level, hierarchy), r.id).toBe(ruleOverlapsScopes(r, level, fresh));
        expect(scopeForRule(r.scope, level, hierarchy), r.id).toEqual(scopeForRule(r.scope, level, fresh));
      }
    }
  });

  it('matches which subscriptions sit under the group in the tree', () => {
    const under = (r: (typeof RULES)[number]) => levels()
      .filter(level => ruleOverlapsScopes(r, level, hierarchy))
      .map(level => [...level.grants][0]!.scope.path.split('/')[2]);
    const byRule = Object.fromEntries(RULES.map(r => [r.id, under(r)]));
    expect(byRule.all).toHaveLength(30);
    expect(byRule.top).toHaveLength(30); // every subscription sits somewhere under the top group
    expect(byRule.empty).toEqual(hierarchy.filter(n => n.kind === 'subscription' && n.parentId === 'empty').map(n => n.id.toLowerCase()));
    expect(byRule.unknown).toEqual([]);
    expect(byRule.list).toEqual(['sub-3', 'sub-4']);
    expect(byRule['south-and-a']!.sort()).toEqual(
      hierarchy.filter(n => n.kind === 'subscription' && ['South', 'north-a', 'empty'].includes(n.parentId!)).map(n => n.id.toLowerCase()).sort(),
    );
  });

  it('lists the same subscriptions a run asks for as before', () => {
    const asked = subscriptionsAskedFor([{ managementGroups: ['north'] }, { subscriptions: ['x'] }], hierarchy).sort();
    const expected = hierarchy.filter(n => n.kind === 'subscription' && ['north', 'north-a', 'north-b'].includes(n.parentId!)).map(n => n.id);
    expect(asked).toEqual([...expected, 'x'].sort());
  });
});

describe('expanding each management group once', () => {
  it('reads the tree once per group for any number of subscriptions and rules', () => {
    const hierarchy = tree(200);
    const levels = hierarchy.filter(n => n.kind === 'subscription').map(n => narrowScopes(EVERYTHING_ACCESS, [n.id.toLowerCase()]));
    for (const level of levels) for (const r of RULES) ruleOverlapsScopes(r, level, hierarchy);
    // Seven names are asked for, 'north' in two casings: at most one read each.
    expect(expansions.calls).toBeGreaterThan(0);
    expect(expansions.calls).toBeLessThanOrEqual(8);
  });

  it('reads a changed tree afresh', () => {
    const before = tree(10);
    const level = narrowScopes(EVERYTHING_ACCESS, ['sub-1']); // sub-1 sits under 'north'
    const r = rule('north', { level: 'managementGroup', managementGroups: ['north'] });
    expect(ruleOverlapsScopes(r, level, before)).toBe(true);
    const moved = before.map(n => (n.id === 'SUB-1' ? { ...n, parentId: 'South' } : n));
    expect(ruleOverlapsScopes(r, level, moved)).toBe(false);
  });
});
