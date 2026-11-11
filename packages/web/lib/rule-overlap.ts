/**
 * Which rules can look at what a person holds (posture formula v3). Pure, no DB or Node imports, like
 * `lib/run-scope.ts`, whose reading of a rule's scope it shares: a rule overlaps the Scopes when a run
 * of those Scopes would send it a request (`scopeForRule()`, with a management group expanded over the
 * stored tree). A Microsoft Graph rule reads the directory, so it overlaps only the Directory.
 * Everything overlaps every rule, including one that names a management group the tree cannot expand.
 */
import {
  DIRECTORY_SCOPE_PATH, EVERYTHING_TENANT_ID, accessReach, buildAccess, type Access, type ScopeGrant,
} from '@/lib/access-model';
import type { HierarchyNode } from '@/lib/management-group-tree';
import { DIRECTORY_SUBSCRIPTION } from '@/lib/placement';
import { coversDirectory, scopeForRule } from '@/lib/run-scope';
import type { Rule } from '@/lib/types';

const subscriptionOf = (path: string): string => path.split('/')[2]!.toLowerCase();

/**
 * The Scopes a posture number is read over: the person's Access intersected with the subscription
 * filter, whose values are subscription ids and the reserved Directory value. No filter is the Access
 * itself; an empty list is a filter that matches nothing. A subscription held whole, directly or under
 * a management group, stays whole; a resource group stays as the group; and Everything becomes the
 * filtered subscriptions. The grants it builds carry a Role only to be well formed: nothing reads it.
 */
export function narrowScopes(access: Access, subscriptions: readonly string[] | undefined): Access {
  if (!subscriptions) return access;
  const wanted = new Set(subscriptions.map(s => s.toLowerCase()));
  const reach = accessReach(access);
  const grants: ScopeGrant[] = [];
  const whole = new Set<string>();

  for (const grant of access.grants) {
    const { kind, path } = grant.scope;
    if ((kind === 'subscription' || kind === 'resourceGroup') && wanted.has(subscriptionOf(path))) {
      grants.push(grant);
      if (kind === 'subscription') whole.add(subscriptionOf(path));
    }
  }
  for (const sub of wanted) {
    if (sub === DIRECTORY_SUBSCRIPTION || whole.has(sub)) continue;
    if (access.everything || reach.subscriptions.has(sub)) {
      grants.push({ tenantId: EVERYTHING_TENANT_ID, scope: { kind: 'subscription', path: `/subscriptions/${sub}` }, role: 'viewer' });
    }
  }
  if (wanted.has(DIRECTORY_SUBSCRIPTION) && (access.everything || access.directory)) {
    grants.push({ tenantId: EVERYTHING_TENANT_ID, scope: { kind: 'directory', path: DIRECTORY_SCOPE_PATH }, role: 'viewer' });
  }
  return buildAccess(grants, access.source);
}

/** Whether the rule's own scope overlaps `scopes`. `hierarchy` is RuleBeat's copy of the management group tree. */
export function ruleOverlapsScopes(
  rule: Pick<Rule, 'queryBackend' | 'scope'>, scopes: Access, hierarchy: readonly HierarchyNode[],
): boolean {
  if (scopes.everything) return true;
  if (rule.queryBackend === 'microsoft-graph') return coversDirectory(scopes);
  return scopeForRule(rule.scope, scopes, hierarchy) !== null;
}

/** The ids of the rules that look at what `access` holds: the Rules tab's "Rules that look at what you hold". */
export function ruleIdsInReach(
  rules: readonly Pick<Rule, 'id' | 'queryBackend' | 'scope'>[], access: Access, hierarchy: readonly HierarchyNode[],
): Set<string> {
  return new Set(rules.filter(r => ruleOverlapsScopes(r, access, hierarchy)).map(r => r.id));
}

/**
 * The enabled rules of a category, of any kind, whose last run did not finish (failed, capped or invalid)
 * and that look at what `access` holds. A rule that has never run is not one. Scan Coverage's count, and
 * so the length of the Rules list the count opens. It reads no Scope, tag, rule or severity filter.
 */
export function incompleteRulesOf(
  category: string, rules: readonly Rule[], access: Access, hierarchy: readonly HierarchyNode[],
): Rule[] {
  return rules.filter(r =>
    r.enabled && r.category === category
    && (r.lastRunStatus === 'failed' || r.lastRunStatus === 'capped' || r.lastRunStatus === 'invalid')
    && ruleOverlapsScopes(r, access, hierarchy));
}

/**
 * Whether an enabled rule is scoped to a management group the stored tree does not hold. Such a rule counts
 * install-wide but for no subscription until RuleBeat has read the tree (W3), because a group the tree cannot
 * expand has no subscriptions under it.
 */
export function namesUnexpandableGroup(
  rules: readonly Pick<Rule, 'enabled' | 'scope'>[], hierarchy: readonly HierarchyNode[],
): boolean {
  const known = new Set(hierarchy.filter(n => n.kind === 'managementGroup').map(n => n.id.toLowerCase()));
  return rules.some(r => r.enabled && (r.scope?.managementGroups ?? []).some(g => g.trim() !== '' && !known.has(g.toLowerCase())));
}
