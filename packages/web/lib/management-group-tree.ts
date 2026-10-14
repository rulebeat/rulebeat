/**
 * RuleBeat's copy of the management group tree, as data (#273). Pure, no DB or Node imports, so the
 * resolver, the Access page and the Scope picker share one reading of it.
 *
 * A node is a management group or a subscription, with the group it sits under. The tree is replaced as
 * a whole by a refresh and read as a list: expanding a grant and ordering the page both start from it.
 */
import type { ManagementGroupExpansion, ScopeGrant } from '@/lib/access-model';
import { managementGroupIdOf } from '@/lib/access-model';

export type HierarchyKind = 'managementGroup' | 'subscription';

/** A node as the Access page and the routes carry it: no tenant id, which an Admin never chooses. */
export interface TreeNode {
  /** A group's name or a subscription's id, in the casing Azure returned. */
  id: string;
  kind: HierarchyKind;
  name: string;
  /** The group this node sits under: null for the tenant root group. */
  parentId: string | null;
}

export interface HierarchyNode extends TreeNode {
  tenantId: string;
}

/** What `GET /api/access/management-groups` answers, and what the Access page starts from. */
export interface HierarchyView {
  nodes: TreeNode[];
  status: HierarchyStatus;
}

/** Why the last refresh failed, as the page tells it: a code to branch on and a message that names nothing. */
export type RefreshErrorCode = 'azure_not_configured' | 'failed';

export interface RefreshError {
  code: RefreshErrorCode;
  message: string;
}

export const NOT_CONNECTED_MESSAGE = 'Azure is not connected, so the management group tree could not be read.';
export const REFRESH_FAILED_MESSAGE =
  'The management group tree could not be read from Azure. Check the RuleBeat server logs for details.';

export function refreshError(code: RefreshErrorCode): RefreshError {
  return { code, message: code === 'azure_not_configured' ? NOT_CONNECTED_MESSAGE : REFRESH_FAILED_MESSAGE };
}

/** When the tree was last read, when it was last tried, and why the last try failed, if it did. */
export interface HierarchyStatus {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  error: RefreshError | null;
}

export const NEVER_REFRESHED: HierarchyStatus = Object.freeze({ lastSuccessAt: null, lastAttemptAt: null, error: null });

/**
 * What the Access page says about the tree's last refresh. `format` turns a stored time into the reader's own
 * reading of it. A failed refresh says so, when it was tried, and that the tree on screen is the last one that
 * loaded; it never repeats Azure's own words.
 */
export function describeHierarchyStatus(status: HierarchyStatus, format: (iso: string) => string): string {
  if (status.error) {
    const tried = status.lastAttemptAt ? ` on ${format(status.lastAttemptAt)}` : '';
    return status.lastSuccessAt
      ? `The last refresh failed${tried}. The tree shown is the last one that loaded, on ${format(status.lastSuccessAt)}.`
      : `The last refresh failed${tried}, and no tree has loaded yet.`;
  }
  if (status.lastSuccessAt) return `Last refreshed ${format(status.lastSuccessAt)}.`;
  return 'The tree has not been loaded yet. Use Refresh to read it from Azure.';
}

/**
 * Why the Scope picker lists no management group, or null when it has some to list. The reasons are the
 * three an Admin can act on: nothing has been read yet, the last read failed, Azure is not connected.
 */
export function noGroupsReason(nodes: readonly TreeNode[], status: HierarchyStatus): string | null {
  if (nodes.some(n => n.kind === 'managementGroup')) return null;
  if (status.error?.code === 'azure_not_configured') {
    return 'Azure is not connected, so there are no management groups to choose. Connect Azure in Settings.';
  }
  if (status.error) return 'The last refresh of the management group tree failed, so there are none to choose. Refresh it on this page.';
  if (!status.lastAttemptAt) return 'The management group tree has not been loaded yet, so there are none to choose. Refresh it on this page.';
  return 'Azure returned no management groups, so there are none to choose.';
}

/** How long after the last attempt the scheduler tries again. */
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** Whether an attempt is due at `now`: none has been made, or the last was an hour ago or more. */
export function refreshDue(status: Pick<HierarchyStatus, 'lastAttemptAt'>, now: Date): boolean {
  if (!status.lastAttemptAt) return true;
  const last = Date.parse(status.lastAttemptAt);
  return Number.isNaN(last) || now.getTime() - last >= REFRESH_INTERVAL_MS;
}

/**
 * What each management group grant covers: the group itself and every group beneath it, and every
 * subscription under any of them. Only nodes of the grant's own tenant count, and ids compare without
 * regard to case, so a group the tree does not hold under that tenant covers nothing. A grant that is not
 * for a management group has no expansion. The walk keeps what it
 * has visited, so a tree that loops back on itself still ends.
 */
export function expandManagementGroups(grants: readonly ScopeGrant[], nodes: readonly HierarchyNode[]): ManagementGroupExpansion[] {
  const out: ManagementGroupExpansion[] = [];
  for (const grant of grants) {
    if (grant.scope.kind !== 'managementGroup') continue;
    const inTenant = nodes.filter(n => n.tenantId === grant.tenantId);
    const own = managementGroupIdOf(grant.scope.path).toLowerCase();
    const groups = new Set<string>();
    const subscriptions = new Set<string>();
    if (inTenant.some(n => n.kind === 'managementGroup' && n.id.toLowerCase() === own)) groups.add(own);
    let frontier = [...groups];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const node of inTenant) {
        const parent = node.parentId?.toLowerCase();
        if (parent === undefined || !frontier.includes(parent)) continue;
        const id = node.id.toLowerCase();
        if (node.kind === 'subscription') subscriptions.add(id);
        else if (!groups.has(id)) { groups.add(id); next.push(id); }
      }
      frontier = next;
    }
    out.push({
      tenantId: grant.tenantId,
      path: grant.scope.path,
      role: grant.role,
      groups: [...groups],
      subscriptions: [...subscriptions],
    });
  }
  return out;
}

export interface OrderedNode<T extends TreeNode = TreeNode> {
  node: T;
  /** 0 for a root: how many groups sit above it. */
  depth: number;
}

/**
 * The nodes in tree order: each group, then what is under it, groups before subscriptions at every level
 * and each by display name. A node whose parent is not in the list is a root, so a tree is never lost for
 * want of its top. The walk keeps what it has visited, so a loop ends too, and a loop no root reaches is
 * still listed, once each.
 */
export function orderedTree<T extends TreeNode>(nodes: readonly T[]): OrderedNode<T>[] {
  const byParent = new Map<string, T[]>();
  const groupIds = new Set(nodes.filter(n => n.kind === 'managementGroup').map(n => n.id.toLowerCase()));
  const roots: T[] = [];
  for (const node of nodes) {
    const parent = node.parentId?.toLowerCase() ?? null;
    if (parent === null || !groupIds.has(parent)) roots.push(node);
    else byParent.set(parent, [...(byParent.get(parent) ?? []), node]);
  }
  const rank = (n: T) => (n.kind === 'managementGroup' ? 0 : 1);
  const compare = (a: T, b: T) =>
    rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

  const out: OrderedNode<T>[] = [];
  const seen = new Set<string>();
  const walk = (node: T, depth: number) => {
    const key = `${node.kind}:${node.id.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ node, depth });
    if (node.kind === 'managementGroup') {
      for (const child of (byParent.get(node.id.toLowerCase()) ?? []).sort(compare)) walk(child, depth + 1);
    }
  };
  for (const root of roots.sort(compare)) walk(root, 0);
  // What no root reaches (a loop with no top) is still listed, from its first node by name.
  for (const node of [...nodes].sort(compare)) walk(node, 0);
  return out;
}

/** The groups only, in tree order: what the Scope picker offers. */
export function orderedGroups<T extends TreeNode>(nodes: readonly T[]): OrderedNode<T>[] {
  return orderedTree(nodes).filter(o => o.node.kind === 'managementGroup');
}

/** Whether the tree holds a management group by id, case aside. */
export function hasManagementGroup(nodes: readonly HierarchyNode[], tenantId: string, id: string): boolean {
  const wanted = id.toLowerCase();
  return nodes.some(n => n.kind === 'managementGroup' && n.tenantId === tenantId && n.id.toLowerCase() === wanted);
}
