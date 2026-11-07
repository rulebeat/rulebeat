/**
 * The Scope filter's picks, read the way Access reads Scopes (ADR 0015). Pure, no database: the stored
 * management group tree comes in as a list of nodes.
 *
 * A pick is turned into an `Access` that holds just the picks, so the same derivation (`accessReach`) and the
 * same SQL (`accessFilterSql`) that decide what a person sees decide what a pick matches, and the two cannot
 * disagree about whether one finding is inside a Scope. The one difference from Access is a management group
 * the tree does not know: Access reads a group only through the tree, a pick also matches findings placed at
 * the group's own id.
 */
import {
  accessReach, buildAccess, managementGroupIdOf, parseScope,
  type Access, type ManagementGroupExpansion, type Scope, type ScopeGrant,
} from './access-model';
import { expandManagementGroups, type HierarchyNode } from './management-group-tree';
import type { ScopePickAccess, ScopePickState } from './filter-states';

/** The kinds a pick can be. Everything is the absence of a pick, never one. */
function pickableScope(pick: string): Scope | null {
  const scope = parseScope(pick);
  return scope && scope.kind !== 'everything' ? scope : null;
}

/** The picks that are Scopes, read once. */
export function readPicks(picks: readonly string[]): Scope[] {
  return picks.map(pickableScope).filter((s): s is Scope => s !== null);
}

/** The picks as an Access: each management group expanded against `nodes` in every tenant that holds it,
 *  plus the group's own id even when no tenant does. */
export function picksAsAccess(picks: readonly Scope[], nodes: readonly HierarchyNode[]): Access {
  const tenants = [...new Set(nodes.map(n => n.tenantId))];
  const grants: ScopeGrant[] = [];
  for (const scope of picks) {
    if (scope.kind === 'managementGroup') {
      for (const tenantId of tenants.length > 0 ? tenants : ['']) grants.push({ tenantId, scope, role: 'viewer' });
    } else {
      grants.push({ tenantId: '', scope, role: 'viewer' });
    }
  }
  const expansions: ManagementGroupExpansion[] = expandManagementGroups(grants, nodes);
  for (const scope of picks) {
    if (scope.kind !== 'managementGroup') continue;
    expansions.push({ tenantId: '', path: scope.path, role: 'viewer', groups: [managementGroupIdOf(scope.path).toLowerCase()], subscriptions: [] });
  }
  return buildAccess(grants, null, expansions);
}

function nodeName(nodes: readonly HierarchyNode[], kind: HierarchyNode['kind'], id: string): string | null {
  const wanted = id.toLowerCase();
  return nodes.find(n => n.kind === kind && n.id.toLowerCase() === wanted)?.name ?? null;
}

/** What a pick is called, from the stored tree and never from Azure: a node's display name, else the id. */
export function pickLabel(pick: string, nodes: readonly HierarchyNode[]): string {
  const scope = pickableScope(pick);
  if (!scope) return pick;
  const parts = scope.path.split('/');
  switch (scope.kind) {
    case 'directory': return 'Directory';
    case 'managementGroup': return nodeName(nodes, 'managementGroup', managementGroupIdOf(scope.path)) ?? managementGroupIdOf(scope.path);
    case 'subscription': return nodeName(nodes, 'subscription', parts[2]!) ?? parts[2]!;
    default: return `${parts[4]} in ${nodeName(nodes, 'subscription', parts[2]!) ?? parts[2]}`;
  }
}

/** How one pick sits against `access`: all of it held, a subscription held in part, a pick held in part whose
 *  name the viewer may not read, or none of it. A path that is no Scope is held by nobody but Everything. */
export function classifyPick(access: Access, pick: string, nodes: readonly HierarchyNode[]): ScopePickAccess {
  if (access.everything) return 'held';
  const scope = pickableScope(pick);
  if (!scope) return 'outside';
  const held = accessReach(access);
  const asked = accessReach(picksAsAccess([scope], nodes));
  const wholeSubscription = (sub: string) => held.subscriptions.has(sub);
  const partOfSubscription = (sub: string) => (held.resourceGroups.get(sub)?.size ?? 0) > 0;

  switch (scope.kind) {
    case 'directory':
      return held.directory ? 'held' : 'outside';
    case 'resourceGroup': {
      const [sub, groups] = [...asked.resourceGroups][0]!;
      return wholeSubscription(sub) || [...groups].every(g => held.resourceGroups.get(sub)?.has(g)) ? 'held' : 'outside';
    }
    case 'subscription': {
      const sub = [...asked.subscriptions][0]!;
      return wholeSubscription(sub) ? 'held' : partOfSubscription(sub) ? 'narrowed' : 'outside';
    }
    default: {
      const groups = [...asked.managementGroups];
      const subs = [...asked.subscriptions];
      const whole = groups.every(g => held.managementGroups.has(g)) && subs.every(wholeSubscription);
      if (whole) return 'held';
      const some = groups.some(g => held.managementGroups.has(g)) || subs.some(s => wholeSubscription(s) || partOfSubscription(s));
      return some ? 'outside-narrowed' : 'outside';
    }
  }
}

/** The state of each pick, in the order given. A pick is named only when the viewer holds all of it, or holds
 *  a subscription in part. */
export function scopePickStates(access: Access, picks: readonly string[], nodes: readonly HierarchyNode[]): ScopePickState[] {
  return picks.map((value): ScopePickState => {
    const state = classifyPick(access, value, nodes);
    const named = state === 'held' || state === 'narrowed';
    return { value, access: state, label: named ? pickLabel(value, nodes) : null };
  });
}
