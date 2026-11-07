/**
 * The Scope picker's tree (#388): the Access page's scope tree limited to the Scopes the viewer holds. Pure, no
 * database and no Node, so the options read builds it and the picker and the tests read the same shape.
 *
 * The tree is RuleBeat's stored copy of the management group tree, never a live listing. A person sees each
 * management group they hold with what sits under it, and each subscription they hold or hold a resource group
 * in, every one at the top level: no ancestor and no sibling, so neither their names nor the tenant root's are
 * sent (the same rule as `limitHierarchy`). A held subscription the stored tree does not have is not on the tree,
 * so the listing is what says it was not found. A subscription lists the resource groups the findings the viewer sees
 * are placed in, and the resource groups they hold, since no listing of a subscription's resource groups is stored.
 */
import { accessReach, type Access } from './access-model';
import { heldScopes, holdsManagementGroup, holdsSubscription } from './held-scopes';
import type { HierarchyStatus, TreeNode } from './management-group-tree';
import { resourceGroupScopePath } from './access-picker';
import { hierarchyItems, mapTree, type ScopeTreeItem } from './scope-tree';
import type { ScopeFunnelPlacements } from './scope-funnels';

/** Whether the latest listing of the tree can say a Scope is gone. A failed or never-run refresh cannot. */
export type ScopeListingStatus = 'listed' | 'failed';

export interface ScopeOptions {
  listing: ScopeListingStatus;
  /** The viewer holds the Directory (Everything holds it), so it is offered at the top of the picker. */
  directory: boolean;
  /** The held tree, keyed by Scope path. */
  tree: ScopeTreeItem[];
}

const lower = (text: string): string => text.toLowerCase();

/**
 * The tree `access` holds, from the stored `nodes`, with the resource groups in `groups` (the ones the viewer's
 * findings sit in) under their subscription. `status` is how the last refresh of the stored tree went.
 */
export function buildScopeOptions(
  access: Access, nodes: readonly TreeNode[], status: HierarchyStatus, groups: ScopeFunnelPlacements['resourceGroups'],
): ScopeOptions {
  const held = heldScopes(access);
  const kept = nodes.filter(n => (n.kind === 'managementGroup' ? holdsManagementGroup(held, n.id) : holdsSubscription(held, n.id)));

  const groupsBySubscription = new Map<string, Map<string, string>>();
  const add = (subscription: string, name: string) => {
    const names = groupsBySubscription.get(lower(subscription)) ?? new Map<string, string>();
    if (!names.has(lower(name))) names.set(lower(name), name);
    groupsBySubscription.set(lower(subscription), names);
  };
  for (const g of groups) add(g.subscription, g.name);
  for (const { scope } of access.grants) {
    if (scope.kind === 'resourceGroup') add(scope.path.split('/')[2]!, scope.path.split('/')[4]!);
  }

  const tree = mapTree(hierarchyItems(kept), item => {
    if (item.kind !== 'subscription') return item;
    const id = item.key.split('/')[2]!;
    const names = [...(groupsBySubscription.get(lower(id))?.values() ?? [])].sort((a, b) => a.localeCompare(b));
    if (names.length === 0) return item;
    return { ...item, children: names.map(name => ({ key: resourceGroupScopePath(id, name), kind: 'resourceGroup' as const, name })) };
  });

  return {
    listing: status.error === null && status.lastSuccessAt !== null ? 'listed' : 'failed',
    directory: access.everything || accessReach(access).directory,
    tree,
  };
}

/** The lower-case Scope path of every management group and subscription on the tree: what the listing knows. */
export function listedPaths(tree: readonly ScopeTreeItem[]): Set<string> {
  const out = new Set<string>();
  const walk = (items: readonly ScopeTreeItem[]) => {
    for (const item of items) {
      if (item.kind === 'managementGroup' || item.kind === 'subscription') out.add(lower(item.key));
      walk(item.children ?? []);
    }
  };
  walk(tree);
  return out;
}

/** The display name of every subscription on the tree by its id, for the funnels that list a subscription by name. */
export function subscriptionNames(tree: readonly ScopeTreeItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (items: readonly ScopeTreeItem[]) => {
    for (const item of items) {
      if (item.kind === 'subscription') out[item.key.split('/')[2]!] = item.name;
      walk(item.children ?? []);
    }
  };
  walk(tree);
  return out;
}
