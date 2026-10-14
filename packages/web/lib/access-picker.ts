/**
 * What the Access page's Scope picker does to the list it edits, as pure functions so each decision can
 * be tested without rendering anything. Client-safe: no Node, no database.
 *
 * The list is the same shape the Manual access route takes: a path and a Role, one entry a Scope. A
 * Scope is held at most once, and a path is compared without regard to case, as the server does.
 */
import {
  DIRECTORY_SCOPE_PATH, EVERYTHING_SCOPE_PATH, parseScope, sameScopePath, type Access, type GrantRole, type ManualGrant,
} from './access-model';
import { noGroupsReason, orderedGroups, type HierarchyView } from './management-group-tree';

export const subscriptionScopePath = (subscriptionId: string): string => `/subscriptions/${subscriptionId}`;
export const managementGroupScopePath = (id: string): string => `/providers/Microsoft.Management/managementGroups/${id}`;
export const resourceGroupScopePath = (subscriptionId: string, name: string): string =>
  `/subscriptions/${subscriptionId}/resourceGroups/${name}`;

export function heldAt(grants: readonly ManualGrant[], path: string): ManualGrant | undefined {
  return grants.find(g => sameScopePath(g.scope, path));
}

/** Holds the Scope at `role` when it is not held, and drops it when it is. */
export function toggleGrant(grants: readonly ManualGrant[], path: string, role: GrantRole): ManualGrant[] {
  return heldAt(grants, path) ? grants.filter(g => !sameScopePath(g.scope, path)) : [...grants, { scope: path, role }];
}

export function setGrantRole(grants: readonly ManualGrant[], path: string, role: GrantRole): ManualGrant[] {
  return grants.map(g => (sameScopePath(g.scope, path) ? { ...g, role } : g));
}

/** The Role at every Scope at once, which is what the person-level Role select means. */
export function setEveryRole(grants: readonly ManualGrant[], role: GrantRole): ManualGrant[] {
  return grants.map(g => ({ ...g, role }));
}

/** The Scopes a person holds as the picker edits them, a management group included: saving the list
 *  replaces what they hold, so a group left out here would be removed by an Edit that changed nothing. */
export function grantsOfAccess(access: Pick<Access, 'grants'>): ManualGrant[] {
  const out: ManualGrant[] = [];
  for (const g of access.grants) {
    if (g.role === 'admin') continue;
    out.push({ scope: g.scope.path, role: g.role });
  }
  return out;
}

/** One management group the picker lists. `missing` is a group the person holds that RuleBeat's tree no longer has. */
export interface PickerGroup {
  path: string;
  /** The display name, or for a missing group its id. */
  name: string;
  id: string;
  depth: number;
  missing: boolean;
}

/**
 * The management groups the Scope picker lists, and why it lists none when it has none to offer. Every group
 * of the tree comes in tree order, each choosable; a group already held that the tree lacks follows them, so
 * it can be removed. The reason is about the tree, so it is given even when a missing group is listed.
 */
export function pickerGroups(view: HierarchyView, held: readonly ManualGrant[]): { groups: PickerGroup[]; reason: string | null } {
  const groups: PickerGroup[] = orderedGroups(view.nodes).map(({ node, depth }) => ({
    path: managementGroupScopePath(node.id), name: node.name, id: node.id, depth, missing: false,
  }));
  for (const grant of held) {
    if (parseScope(grant.scope)?.kind !== 'managementGroup') continue;
    if (groups.some(g => sameScopePath(g.path, grant.scope))) continue;
    const id = grant.scope.slice(grant.scope.lastIndexOf('/') + 1);
    groups.push({ path: grant.scope, name: id, id, depth: 0, missing: true });
  }
  return { groups, reason: noGroupsReason(view.nodes, view.status) };
}

/** The resource groups held inside one subscription, by name, in the order they were chosen. */
export function resourceGroupsHeld(grants: readonly ManualGrant[], subscriptionId: string): string[] {
  const prefix = `${subscriptionScopePath(subscriptionId)}/resourcegroups/`.toLowerCase();
  return grants
    .filter(g => g.scope.toLowerCase().startsWith(prefix) && parseScope(g.scope)?.kind === 'resourceGroup')
    .map(g => g.scope.slice(prefix.length));
}

/** The subscription ids the list names, either as a subscription or through a resource group in it. */
export function subscriptionsNamed(grants: readonly ManualGrant[]): string[] {
  const ids = new Map<string, string>();
  for (const g of grants) {
    const m = /^\/subscriptions\/([^/]+)/i.exec(g.scope);
    if (m && !ids.has(m[1]!.toLowerCase())) ids.set(m[1]!.toLowerCase(), m[1]!);
  }
  return [...ids.values()];
}

/** What a Scope is called on screen. `names` maps a subscription id or a management group id to its display name. */
export function describeScopePath(path: string, names: Readonly<Record<string, string>> = {}): string {
  if (path === EVERYTHING_SCOPE_PATH) return 'Everything';
  if (path.toLowerCase() === DIRECTORY_SCOPE_PATH) return 'Directory';
  const scope = parseScope(path);
  const parts = path.split('/');
  if (scope?.kind === 'subscription') return names[parts[2]!] ?? parts[2]!;
  if (scope?.kind === 'resourceGroup') return `${parts[4]!} in ${names[parts[2]!] ?? parts[2]!}`;
  if (scope?.kind === 'managementGroup') {
    const id = parts[parts.length - 1]!;
    return `Management group ${names[id] ?? id}`;
  }
  return path;
}

/** Whether a list can be sent as an invite: an invited Viewer or Editor must be given something. */
export function canInvite(email: string, grants: readonly ManualGrant[]): boolean {
  return email.trim() !== '' && grants.length > 0;
}
