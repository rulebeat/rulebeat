/**
 * The Subscription scorecard's rows are the same numbers whichever way the overlap of a rule and a row is
 * found. `buildSubscriptionRows` finds a whole subscription's rules from one list per scope shape (the
 * bench's 2,000 subscriptions made a test per subscription and per shape the cost of the Everything summary);
 * the contract is the definition: a row counts the rules `ruleOverlapsScopes` says overlap the Scopes
 * narrowed to that row. The expected rows here are worked out from that definition, rule by rule, over the
 * bench's seeded dataset plus rules with the awkward scopes (case, blanks, a group the tree lacks, both lists).
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, accessReach, type Access, type ScopeGrant } from '@/lib/access-model';
import { expandManagementGroups } from '@/lib/management-group-tree';
import { buildSubscriptionRows, levelOf, type PlacedRuleFinding } from '@/lib/subscription-scorecard';
import { knownSubscriptions } from '@/lib/known-subscriptions';
import { narrowScopes, ruleOverlapsScopes } from '@/lib/rule-overlap';
import { posturePct } from '@/lib/posture-math';
import { DIRECTORY_SUBSCRIPTION } from '@/lib/placement';
import type { HierarchyNode } from '@/lib/management-group-tree';
import type { Rule } from '@/lib/types';
import { generateDataset, subscriptionIdOf } from '../../scripts/bench/trend-points';

const TENANT = '00000000-0000-0000-0000-0000000000b0';
type CountedRule = Pick<Rule, 'id' | 'queryBackend' | 'scope' | 'lastRunStatus'>;

const dataset = generateDataset({ subscriptions: 160, categories: 3, findings: 1500, rulesPerCategory: 30, seed: 7 });
const hierarchy: HierarchyNode[] = dataset.nodes.map(n => ({
  tenantId: TENANT, kind: n.kind, id: n.id, name: n.name, parentId: n.parentId === '' ? null : n.parentId,
}));

const planned: CountedRule[] = dataset.rules.map(r => ({
  id: r.id,
  queryBackend: r.scope === 'directory' ? 'microsoft-graph' : 'resource-graph',
  scope: {
    level: 'subscription',
    ...(r.scope === 'list' ? { subscriptions: r.subscriptions } : {}),
    ...(r.managementGroup ? { managementGroups: [r.managementGroup] } : {}),
  },
  lastRunStatus: r.lastRunStatus,
}));
const awkward = (id: string, scope: CountedRule['scope'], lastRun: 'success' | 'never' = 'success'): CountedRule =>
  ({ id, queryBackend: 'resource-graph', scope, lastRunStatus: lastRun === 'never' ? undefined : 'success' });
const rules: CountedRule[] = [
  ...planned,
  awkward('upper', { level: 'subscription', subscriptions: [subscriptionIdOf(3).toUpperCase()] }),
  awkward('blanks', { level: 'subscription', subscriptions: ['', '  '] }),
  awkward('padded', { level: 'subscription', subscriptions: [` ${subscriptionIdOf(4)} `] }),
  awkward('both', { level: 'subscription', subscriptions: [subscriptionIdOf(5)], managementGroups: [dataset.managementGroups[2]!.toUpperCase()] }),
  awkward('missing-group', { level: 'subscription', managementGroups: ['no-such-group'] }, 'never'),
  awkward('never-run', { level: 'subscription', subscriptions: [subscriptionIdOf(6)] }, 'never'),
  awkward('no-scope', undefined as unknown as CountedRule['scope']),
];

const findings: PlacedRuleFinding[] = dataset.findings.filter(f => !f.suppressed).map(f => ({
  ruleId: f.ruleId, subscriptionId: f.subscriptionId, placement: f.placement,
}));
findings.push({ ruleId: 'upper', subscriptionId: subscriptionIdOf(3), placement: 'resource' });

const grant = (kind: ScopeGrant['scope']['kind'], path: string): ScopeGrant => ({ tenantId: TENANT, scope: { kind, path }, role: 'viewer' });
const mgPath = (id: string) => `/providers/Microsoft.Management/managementGroups/${id}`;

function accessOf(grants: ScopeGrant[]): Access {
  return buildAccess(grants, 'manual', expandManagementGroups(grants.filter(g => g.scope.kind === 'managementGroup'), hierarchy));
}

const people: Record<string, Access> = {
  everything: everythingAccess('admin'),
  'some whole subscriptions': accessOf([0, 1, 2, 3, 4, 5, 6, 40, 41].map(n => grant('subscription', `/subscriptions/${subscriptionIdOf(n)}`))),
  'a management group': accessOf([grant('managementGroup', mgPath(dataset.managementGroups[1]!))]),
  'a group and a subscription of another': accessOf([
    grant('managementGroup', mgPath(dataset.managementGroups[0]!)), grant('subscription', `/subscriptions/${subscriptionIdOf(5)}`),
  ]),
  'resource groups only': accessOf([
    grant('resourceGroup', `/subscriptions/${subscriptionIdOf(4)}/resourceGroups/rg-1`),
    grant('resourceGroup', `/subscriptions/${subscriptionIdOf(3)}/resourceGroups/rg-2`),
  ]),
  'a subscription and its resource group': accessOf([
    grant('subscription', `/subscriptions/${subscriptionIdOf(3)}`),
    grant('resourceGroup', `/subscriptions/${subscriptionIdOf(3)}/resourceGroups/rg-2`),
    grant('directory', '@directory'),
  ]),
  'the directory only': accessOf([grant('directory', '@directory')]),
};

/** The definition, one rule at a time, through `ruleOverlapsScopes` over the Scopes narrowed to the row. */
function expectedRow(scopes: Access, key: string) {
  const narrowed = narrowScopes(scopes, [key]);
  const counted = rules.filter(r => ruleOverlapsScopes(r, narrowed, hierarchy));
  const inRow = findings.filter(f => levelOf(f) === key);
  const failing = new Set(inRow.map(f => f.ruleId));
  const passing = counted.filter(r => !failing.has(r.id) && r.lastRunStatus === 'success').length;
  const failingCounted = counted.filter(r => failing.has(r.id)).length;
  return {
    passingRules: passing, totalRules: counted.length, unknownRules: counted.length - failingCounted - passing,
    pct: posturePct(passing, counted.length), activeFindings: inRow.length,
  };
}

describe('the rows of the Subscription scorecard', () => {
  for (const [who, scopes] of Object.entries(people)) {
    it(`count what the overlap definition counts for ${who}`, () => {
      const reach = accessReach(scopes);
      const subscriptions = knownSubscriptions({
        hierarchy, rules: rules.map(r => ({ enabled: true, scope: r.scope })), findingSubscriptions: findings.map(f => f.subscriptionId),
      }).filter(s => scopes.everything || reach.subscriptions.has(s.key) || reach.resourceGroups.has(s.key));

      const rows = buildSubscriptionRows({ subscriptions, includeDirectory: scopes.everything || scopes.directory, rules, findings, scopes, hierarchy });

      expect(rows.length).toBe(subscriptions.length + (scopes.everything || scopes.directory ? 1 : 0));
      for (const row of rows) {
        const { passingRules, totalRules, unknownRules, pct, activeFindings } = row;
        const key = row.directory ? DIRECTORY_SUBSCRIPTION : row.subscriptionId.toLowerCase();
        expect({ passingRules, totalRules, unknownRules, pct, activeFindings }, `${row.subscriptionId} for ${who}`).toEqual(expectedRow(scopes, key));
      }
      // Not a vacuous pass: the rows differ from one another and some are graded by a rule or a finding.
      expect(rows.some(r => r.totalRules > 0)).toBe(true);
      if (rows.length > 1) expect(new Set(rows.map(r => r.totalRules)).size).toBeGreaterThan(1);
      if (who !== 'the directory only') expect(rows.some(r => r.activeFindings > 0)).toBe(true);
    });
  }
});
