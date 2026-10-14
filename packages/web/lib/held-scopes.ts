/**
 * What a person holds, as the Azure ids a picker or a rule's scope names (#275). Pure, no DB or Node
 * imports, so a route, a page and a client component can share it.
 *
 * A Scope is stored as a path; the lists here are the ids inside it. A subscription is held when a
 * subscription Scope names it, or when a resource group Scope sits inside it (the person sees the
 * subscription to reach the group, as the Access page's picker does). A management group is held when
 * a management group Scope names it. Ids compare without regard to case, as Azure does.
 *
 * A management group Scope covers nothing below it until the hierarchy cache exists (#273), so a
 * subscription under a held group is not held through it.
 */
import type { Access } from './access-model';

export interface HeldScopes {
  /** Everything is held: no entry is outside it. */
  everything: boolean;
  subscriptions: string[];
  managementGroups: string[];
}

const MANAGEMENT_GROUP_PATH = /^\/providers\/microsoft\.management\/managementgroups\/([^/]+)$/i;

export function heldScopes(access: Access): HeldScopes {
  const subscriptions = new Map<string, string>();
  const managementGroups = new Map<string, string>();
  for (const { scope } of access.grants) {
    if (scope.kind === 'subscription' || scope.kind === 'resourceGroup') {
      const id = scope.path.split('/')[2]!;
      if (!subscriptions.has(id.toLowerCase())) subscriptions.set(id.toLowerCase(), id);
    } else if (scope.kind === 'managementGroup') {
      const id = MANAGEMENT_GROUP_PATH.exec(scope.path)?.[1];
      if (id && !managementGroups.has(id.toLowerCase())) managementGroups.set(id.toLowerCase(), id);
    }
  }
  return { everything: access.everything, subscriptions: [...subscriptions.values()], managementGroups: [...managementGroups.values()] };
}

const includes = (ids: readonly string[], id: string): boolean => ids.some(held => held.toLowerCase() === id.toLowerCase());

export const holdsSubscription = (held: HeldScopes, id: string): boolean => held.everything || includes(held.subscriptions, id);
export const holdsManagementGroup = (held: HeldScopes, id: string): boolean => held.everything || includes(held.managementGroups, id);

/** The shape of a node in the management group hierarchy, as much of it as filtering needs. */
export interface HierarchyNode {
  id: string;
  type: 'managementGroup' | 'subscription';
  children?: HierarchyNode[];
}

/**
 * What a person who does not hold Everything is shown of the hierarchy: each held management group
 * with all that sits under it, and each held subscription, every one at the top level. No ancestor and
 * no sibling of a held entry is kept, so neither their names nor the tenant root's are sent.
 */
export function limitHierarchy<N extends HierarchyNode>(nodes: readonly N[], held: HeldScopes): N[] {
  const kept: N[] = [];
  const walk = (level: readonly N[]): void => {
    for (const node of level) {
      if (node.type === 'subscription') {
        if (holdsSubscription(held, node.id)) kept.push(node);
        continue;
      }
      if (holdsManagementGroup(held, node.id)) kept.push(node);
      // A held subscription or group below an unheld or held group is found either way.
      walk((node.children ?? []) as N[]);
    }
  };
  walk(nodes);
  return kept;
}
