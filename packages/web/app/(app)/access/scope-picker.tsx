'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScopeTree } from '@/components/scope-tree';
import { fetchJson } from '@/lib/fetch-json';
import type { GrantRole, ManualGrant } from '@/lib/access-model';
import { DIRECTORY_SCOPE_PATH, EVERYTHING_SCOPE_PATH } from '@/lib/access-model';
import { noGroupsReason, type HierarchyView } from '@/lib/management-group-tree';
import {
  DIRECTORY_DETAIL, GROUPS_LOAD_FAILED_MESSAGE, heldAt, heldRows, KIND_LABELS, NO_SUBSCRIPTIONS_MESSAGE,
  resourceGroupScopePath, resourceGroupsHeld, subscriptionScopePath, tickScope, toggleGrant,
  type HeldRow, type PickerCatalogue, type SubscriptionOption,
} from '@/lib/access-picker';
import { hierarchyItems, mapTree, pathsTo, topLevelKeys, type ScopeTreeItem } from '@/lib/scope-tree';
import { cn } from '@/lib/utils';

type TreeState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; view: HierarchyView };

type GroupsState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; names: string[] };

export const GROUPS_FAILED_NOTE = 'The resource groups of this subscription could not be loaded. Try again, or check the server logs.';
export const NO_GROUPS_NOTE = 'This subscription has no resource groups.';

const subscriptionIdOf = (key: string): string => key.split('/')[2]!;

/**
 * The tree the picker draws: the Directory, then every management group with the groups and subscriptions under
 * it, then any subscription the tree does not place. A subscription opens to its resource groups, read the first
 * time it is opened; a resource group already held is listed before that, so its tick is never hidden.
 */
export function pickerItems(
  catalogue: PickerCatalogue, groups: Readonly<Record<string, GroupsState>>, grants: readonly ManualGrant[],
): ScopeTreeItem[] {
  const placed = hierarchyItems(catalogue.nodes ?? []);
  const inTree = new Set((catalogue.nodes ?? []).filter(n => n.kind === 'subscription').map(n => n.id.toLowerCase()));
  const loose: ScopeTreeItem[] = (catalogue.subscriptions ?? [])
    .filter(s => !inTree.has(s.id.toLowerCase()))
    .map(s => ({ key: subscriptionScopePath(s.id), kind: 'subscription', name: s.name, detail: s.id }));
  const withGroups = mapTree([...placed, ...loose], item => {
    if (item.kind !== 'subscription') return item;
    const id = subscriptionIdOf(item.key);
    const state = groups[id.toLowerCase()];
    const listed = state?.status === 'ready' ? state.names : [];
    const held = resourceGroupsHeld(grants, id).filter(h => !listed.some(n => n.toLowerCase() === h.toLowerCase()));
    const children: ScopeTreeItem[] = [...listed, ...held].map(name => ({
      key: resourceGroupScopePath(id, name), kind: 'resourceGroup', name,
    }));
    const note = state?.status === 'loading' ? 'Loading resource groups'
      : state?.status === 'error' ? GROUPS_FAILED_NOTE
        : state?.status === 'ready' && children.length === 0 ? NO_GROUPS_NOTE
          : undefined;
    return { ...item, lazy: true, children, note };
  });
  return [{ key: DIRECTORY_SCOPE_PATH, kind: 'directory', name: 'Directory', detail: DIRECTORY_DETAIL }, ...withGroups];
}

/** One chosen Scope above the tree: what it is, and a remove control. */
function ChosenRow({ row, disabled, onRemove }: { row: HeldRow; disabled?: boolean; onRemove: () => void }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="label-grid shrink-0">{KIND_LABELS[row.kind]}</span>
          <span className="min-w-0 truncate text-sm font-medium text-ink" title={row.label}>{row.label}</span>
        </div>
        {row.detail && (
          <div
            className={cn('truncate text-xs', row.missing ? 'text-destructive' : 'text-ink-2', row.kind === 'subscription' && 'font-mono')}
            title={row.detail}
          >
            {row.detail}
          </div>
        )}
      </div>
      <Button
        type="button" variant="ghost" size="icon-sm" disabled={disabled}
        aria-label={`Remove ${row.label}`} title={`Remove ${row.label}`}
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </li>
  );
}

/**
 * Chooses the Scopes someone is given (#311): the chosen ones listed first, each with a remove control, then the
 * tree to tick more in. The tree is the Directory, the management groups with what sits under them, and each
 * subscription's resource groups; it starts open one level, and open down to whatever is already chosen. A node
 * under a ticked one shows as covered. Every Scope takes the person's Role. A chosen management group the loaded
 * tree no longer has stays listed, flagged, so it can be removed.
 */
export function ScopePicker({ value, onChange, role, disabled }: {
  value: readonly ManualGrant[];
  onChange: (next: ManualGrant[]) => void;
  /** The person's Role: what every Scope ticked here is given. */
  role: GrantRole;
  disabled?: boolean;
}) {
  const [subscriptions, setSubscriptions] = useState<SubscriptionOption[] | 'failed' | null>(null);
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });
  const [groups, setGroups] = useState<Record<string, GroupsState>>({});

  useEffect(() => {
    let live = true;
    void fetchJson<SubscriptionOption[]>('/api/azure/subscriptions').then(result => {
      if (live) setSubscriptions(result.ok ? result.data : 'failed');
    });
    void fetchJson<HierarchyView>('/api/access/management-groups').then(result => {
      if (live) setTree(result.ok ? { status: 'ready', view: result.data } : { status: 'error' });
    });
    return () => { live = false; };
  }, []);

  const catalogue: PickerCatalogue = {
    nodes: tree.status === 'ready' ? tree.view.nodes : null,
    subscriptions: Array.isArray(subscriptions) ? subscriptions : null,
  };
  const loading = tree.status === 'loading' || subscriptions === null;
  const everythingHeld = Boolean(heldAt(value, EVERYTHING_SCOPE_PATH));
  const noSubscriptions = Array.isArray(subscriptions) && subscriptions.length === 0
    && !(catalogue.nodes ?? []).some(n => n.kind === 'subscription');
  const noGroups = tree.status === 'ready' ? noGroupsReason(tree.view.nodes, tree.view.status) : null;

  function loadGroups(subscriptionId: string) {
    const key = subscriptionId.toLowerCase();
    const state = groups[key];
    if (state?.status === 'ready' || state?.status === 'loading') return;
    setGroups(g => ({ ...g, [key]: { status: 'loading' } }));
    void fetchJson<{ resourceGroups: string[] }>(`/api/azure/subscriptions/${encodeURIComponent(subscriptionId)}/resource-groups`).then(result => {
      setGroups(g => ({
        ...g,
        [key]: result.ok ? { status: 'ready', names: result.data.resourceGroups } : { status: 'error' },
      }));
    });
  }

  const items = pickerItems(catalogue, groups, value);
  const rows = heldRows(value, catalogue);

  return (
    <div className={cn('space-y-3', disabled && 'opacity-60')}>
      <div className="bg-surface">
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-sm text-ink-2">Nothing is chosen yet. Tick a Scope in the tree below.</p>
        ) : (
          <ul className="divide-y divide-border" aria-label="Chosen Scopes">
            {rows.map(row => (
              <ChosenRow
                key={row.path.toLowerCase()}
                row={row}
                disabled={disabled}
                onRemove={() => onChange(toggleGrant(value, row.path, role))}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 bg-surface px-3 py-3">
        {everythingHeld && (
          <p className="text-xs text-ink-2">Everything is chosen, so every Scope is already covered. Remove Everything to give narrower access.</p>
        )}
        {tree.status === 'loading' && <p className="text-xs text-ink-2">Loading management groups</p>}
        {tree.status === 'error' && <p className="text-xs text-ink-2">{GROUPS_LOAD_FAILED_MESSAGE}</p>}
        {noGroups && <p className="text-xs text-ink-2">{noGroups}</p>}
        {subscriptions === null && <p className="text-xs text-ink-2">Loading subscriptions</p>}
        {subscriptions === 'failed' && (
          <p className="text-xs text-ink-2">Subscriptions could not be loaded, so none can be chosen. Check the server logs.</p>
        )}
        {noSubscriptions && <p className="text-xs text-ink-2">{NO_SUBSCRIPTIONS_MESSAGE}</p>}
        {!loading && (
          <ScopeTree
            items={items}
            searchLabel="Search management groups, subscriptions and resource groups"
            searchPlaceholder="Search by name or id"
            defaultExpanded={[...topLevelKeys(items), ...pathsTo(items, value.map(g => g.scope))]}
            selection={{
              isTicked: key => Boolean(heldAt(value, key)),
              onToggle: item => onChange(heldAt(value, item.key)
                ? toggleGrant(value, item.key, role)
                : tickScope(value, catalogue.nodes ?? [], item.key, role)),
              disabled: disabled || everythingHeld,
            }}
            onExpand={item => { if (item.kind === 'subscription') loadGroups(subscriptionIdOf(item.key)); }}
          />
        )}
      </div>
    </div>
  );
}
