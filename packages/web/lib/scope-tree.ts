/**
 * The one scope tree RuleBeat draws (#311): the Access page's Scope choice, the Management groups card and the
 * rule form's scope picker all render it, so a management group, a subscription and a resource group read the
 * same everywhere. As pure functions over plain data, so expanding, searching and what a tick covers can be
 * tested without rendering anything. Client-safe: no Node, no database.
 */
import { orderedTree, type TreeNode } from './management-group-tree';
import { managementGroupScopePath, subscriptionScopePath } from './access-picker';

export type ScopeTreeKind = 'directory' | 'managementGroup' | 'subscription' | 'resourceGroup';

export interface ScopeTreeItem {
  /** Unique in the tree. The access pickers use the Scope path. */
  key: string;
  kind: ScopeTreeKind;
  name: string;
  /** A second line under the name: an id, or what the node means. */
  detail?: string;
  children?: ScopeTreeItem[];
  /** Its children load when it is first expanded, as a subscription's resource groups do. */
  lazy?: boolean;
  /** What an expanded node with no children says in their place: loading, failed, or none there. */
  note?: string;
}

/** One line of the tree as drawn: the node, how deep it sits, and whether it can open and is open. */
export interface TreeRow {
  item: ScopeTreeItem;
  depth: number;
  expandable: boolean;
  expanded: boolean;
}

const lower = (text: string): string => text.toLowerCase();

function matches(item: ScopeTreeItem, q: string): boolean {
  return lower(item.name).includes(q) || (item.detail !== undefined && lower(item.detail).includes(q));
}

function matchBelow(item: ScopeTreeItem, q: string): boolean {
  return (item.children ?? []).some(child => matches(child, q) || matchBelow(child, q));
}

const expandable = (item: ScopeTreeItem): boolean =>
  (item.children?.length ?? 0) > 0 || item.lazy === true || item.note !== undefined;

/**
 * The rows the tree shows. A node's children show when its key is in `expanded`. With a query, by name or
 * detail in any casing, only a match and the nodes above it are kept; below a node that matches, nothing more is
 * filtered, so opening a matched group shows all of it. Opening the path to each match is `pathsToMatches`.
 */
export function treeRows(items: readonly ScopeTreeItem[], expanded: ReadonlySet<string>, query: string): TreeRow[] {
  const q = lower(query.trim());
  const out: TreeRow[] = [];
  const walk = (nodes: readonly ScopeTreeItem[], depth: number, filtering: boolean) => {
    for (const item of nodes) {
      const self = !filtering || matches(item, q);
      if (!self && !matchBelow(item, q)) continue;
      const open = expandable(item) && expanded.has(item.key);
      out.push({ item, depth, expandable: expandable(item), expanded: open });
      if (open) walk(item.children ?? [], depth + 1, filtering && !self);
    }
  };
  walk(items, 0, q !== '');
  return out;
}

/** The keys of every node with a match somewhere beneath it: what a search opens so each match is in view. */
export function pathsToMatches(items: readonly ScopeTreeItem[], query: string): string[] {
  const q = lower(query.trim());
  if (q === '') return [];
  const out: string[] = [];
  const walk = (nodes: readonly ScopeTreeItem[]) => {
    for (const item of nodes) {
      if (matchBelow(item, q)) out.push(item.key);
      walk(item.children ?? []);
    }
  };
  walk(items);
  return out;
}

/**
 * The keys of every node with one of `keys` somewhere beneath it, in any casing: what a tree opens to start with
 * so each Scope already held is in view under its parents.
 */
export function pathsTo(items: readonly ScopeTreeItem[], keys: readonly string[]): string[] {
  const wanted = new Set(keys.map(lower));
  const out: string[] = [];
  const walk = (nodes: readonly ScopeTreeItem[]): boolean => {
    let found = false;
    for (const item of nodes) {
      const below = walk(item.children ?? []);
      if (below) out.push(item.key);
      if (below || wanted.has(lower(item.key))) found = true;
    }
    return found;
  };
  walk(items);
  return out;
}

/** Whether a search finds anything at all, so the tree can say so instead of drawing nothing. */
export function anyMatch(items: readonly ScopeTreeItem[], query: string): boolean {
  const q = lower(query.trim());
  return q === '' || items.some(item => matches(item, q) || matchBelow(item, q));
}

/**
 * For every node beneath a ticked one, the name of the highest ticked node above it. A ticked group already
 * gives everything under it, so those nodes show as covered rather than as one more thing to tick.
 */
export function coveredBy(items: readonly ScopeTreeItem[], isTicked: (key: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nodes: readonly ScopeTreeItem[], cover: string | null) => {
    for (const item of nodes) {
      if (cover !== null) out.set(item.key, cover);
      walk(item.children ?? [], cover ?? (isTicked(item.key) ? item.name : null));
    }
  };
  walk(items, null);
  return out;
}

/** The tree with `change` applied to every node, children first. */
export function mapTree(items: readonly ScopeTreeItem[], change: (item: ScopeTreeItem) => ScopeTreeItem): ScopeTreeItem[] {
  return items.map(item => change(item.children ? { ...item, children: mapTree(item.children, change) } : item));
}

/**
 * RuleBeat's copy of the management group tree as scope tree nodes, keyed by Scope path: each group with the
 * groups and subscriptions under it, in the order `orderedTree` gives (groups first, each by name).
 */
export function hierarchyItems(nodes: readonly TreeNode[]): ScopeTreeItem[] {
  const roots: ScopeTreeItem[] = [];
  const stack: ScopeTreeItem[] = [];
  for (const { node, depth } of orderedTree(nodes)) {
    const item: ScopeTreeItem = node.kind === 'managementGroup'
      ? { key: managementGroupScopePath(node.id), kind: 'managementGroup', name: node.name, detail: node.id }
      : { key: subscriptionScopePath(node.id), kind: 'subscription', name: node.name, detail: node.id };
    const parent = stack[depth - 1];
    if (parent) parent.children = [...(parent.children ?? []), item];
    else roots.push(item);
    stack[depth] = item;
  }
  return roots;
}

/** A node of the tenant's scope tree as `/api/azure/scope-tree` answers it, for the rule form's scope picker. */
export interface TenantScopeNode {
  id: string;
  name: string;
  type: 'managementGroup' | 'subscription';
  children?: TenantScopeNode[];
}

/** The key a rule scope node has in the tree: its kind and its id, since a rule scope holds bare ids. */
export const ruleScopeKey = (type: TenantScopeNode['type'], id: string): string => `${type}:${id}`;

/** The tenant's scope tree as scope tree nodes, keyed by `ruleScopeKey`. */
export function ruleScopeItems(nodes: readonly TenantScopeNode[]): ScopeTreeItem[] {
  return nodes.map(node => ({
    key: ruleScopeKey(node.type, node.id),
    kind: node.type,
    name: node.name,
    detail: node.id,
    ...(node.children && node.children.length > 0 ? { children: ruleScopeItems(node.children) } : {}),
  }));
}

/** The keys of the top-level nodes: what a tree that starts one level open expands. */
export const topLevelKeys = (items: readonly ScopeTreeItem[]): string[] => items.map(i => i.key);
