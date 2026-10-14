'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { fetchJson } from '@/lib/fetch-json';
import type { GrantRole, ManualGrant } from '@/lib/access-model';
import { DIRECTORY_SCOPE_PATH, EVERYTHING_SCOPE_PATH } from '@/lib/access-model';
import type { HierarchyView } from '@/lib/management-group-tree';
import {
  heldAt, pickerGroups, resourceGroupScopePath, resourceGroupsHeld, setGrantRole, subscriptionScopePath, subscriptionsNamed, toggleGrant,
} from '@/lib/access-picker';
import { cn } from '@/lib/utils';

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
];

interface SubscriptionOption { id: string; name: string }

type TreeState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; view: HierarchyView };

type GroupsState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; names: string[] };

function RoleAt({ value, onChange, disabled, label }: {
  value: GrantRole;
  onChange: (role: GrantRole) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <span className="inline-block w-28 shrink-0">
      <Select
        value={value}
        onValueChange={v => onChange(v as GrantRole)}
        options={ROLE_OPTIONS}
        disabled={disabled}
        size="sm"
        aria-label={`Role at ${label}`}
      />
    </span>
  );
}

/** One Scope: a box to hold it, its name, and the Role at it once it is held. */
function ScopeRow({ label, detail, held, onToggle, onRole, disabled, depth = 0, lead }: {
  label: string;
  detail?: string;
  held: ManualGrant | undefined;
  onToggle: () => void;
  onRole: (role: GrantRole) => void;
  disabled?: boolean;
  depth?: number;
  lead?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 pr-3" style={{ paddingLeft: `${12 + depth * 20}px` }}>
      <span className="flex size-5 shrink-0 items-center justify-center">{lead}</span>
      <input
        type="checkbox"
        checked={Boolean(held)}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`Give access to ${label}`}
        className="size-3.5 shrink-0 accent-ink"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{label}</span>
        {detail && <span className="block truncate font-mono text-xs text-ink-2">{detail}</span>}
      </span>
      {held && <RoleAt value={held.role as GrantRole} onChange={onRole} disabled={disabled} label={label} />}
    </div>
  );
}

function ResourceGroupRows({ subscriptionId, state, value, onChange, defaultRole, disabled }: {
  subscriptionId: string;
  state: GroupsState | undefined;
  value: readonly ManualGrant[];
  onChange: (next: ManualGrant[]) => void;
  defaultRole: GrantRole;
  disabled?: boolean;
}) {
  const held = resourceGroupsHeld(value, subscriptionId);
  const listed = state?.status === 'ready' ? state.names : [];
  const names = [...listed, ...held.filter(h => !listed.some(n => n.toLowerCase() === h.toLowerCase()))]
    .sort((a, b) => a.localeCompare(b));
  return (
    <>
      {state?.status === 'loading' && <p className="py-1.5 pl-16 text-xs text-ink-2">Loading resource groups</p>}
      {state?.status === 'error' && (
        <p className="py-1.5 pl-16 text-xs text-ink-2">The resource groups of this subscription could not be loaded. Try again, or check the server logs.</p>
      )}
      {state?.status === 'ready' && names.length === 0 && (
        <p className="py-1.5 pl-16 text-xs text-ink-2">This subscription has no resource groups.</p>
      )}
      {names.map(name => {
        const path = resourceGroupScopePath(subscriptionId, name);
        return (
          <ScopeRow
            key={name}
            depth={2}
            label={name}
            held={heldAt(value, path)}
            disabled={disabled}
            onToggle={() => onChange(toggleGrant(value, path, defaultRole))}
            onRole={role => onChange(setGrantRole(value, path, role))}
          />
        );
      })}
    </>
  );
}

/**
 * Chooses the Scopes someone is given, each with its own Role: Everything, the Directory, subscriptions
 * management groups from RuleBeat's copy of the tree, subscriptions and, inside a subscription, resource
 * groups. Nothing is held until it is chosen, so a new list starts empty. A management group the person holds
 * that the tree no longer has is still listed, so it can be removed.
 */
export function ScopePicker({ value, onChange, defaultRole, disabled }: {
  value: readonly ManualGrant[];
  onChange: (next: ManualGrant[]) => void;
  /** The Role a Scope is given when it is first chosen. */
  defaultRole: GrantRole;
  disabled?: boolean;
}) {
  const [subscriptions, setSubscriptions] = useState<SubscriptionOption[] | 'failed' | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<Record<string, GroupsState>>({});
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });

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

  function loadGroups(subscriptionId: string) {
    const key = subscriptionId.toLowerCase();
    setGroups(g => ({ ...g, [key]: { status: 'loading' } }));
    void fetchJson<{ resourceGroups: string[] }>(`/api/azure/subscriptions/${encodeURIComponent(subscriptionId)}/resource-groups`).then(result => {
      setGroups(g => ({
        ...g,
        [key]: result.ok ? { status: 'ready', names: result.data.resourceGroups } : { status: 'error' },
      }));
    });
  }

  function toggleOpen(subscriptionId: string) {
    const key = subscriptionId.toLowerCase();
    const opening = !open.has(key);
    setOpen(o => { const next = new Set(o); if (opening) next.add(key); else next.delete(key); return next; });
    if (opening && groups[key]?.status !== 'ready') loadGroups(subscriptionId);
  }

  const listed = Array.isArray(subscriptions) ? subscriptions : [];
  const extra = subscriptionsNamed(value)
    .filter(id => !listed.some(s => s.id.toLowerCase() === id.toLowerCase()))
    .map(id => ({ id, name: id }));
  const rows = [...listed, ...extra];

  const { groups: mgRows, reason: noGroups } = tree.status === 'ready' ? pickerGroups(tree.view, value) : { groups: [], reason: null };

  return (
    <div className={cn('bg-surface-sunken py-1', disabled && 'opacity-60')}>
      <ScopeRow
        label="Everything"
        detail="Every subscription, resource group and the Directory, including anything added later"
        held={heldAt(value, EVERYTHING_SCOPE_PATH)}
        disabled={disabled}
        onToggle={() => onChange(toggleGrant(value, EVERYTHING_SCOPE_PATH, defaultRole))}
        onRole={role => onChange(setGrantRole(value, EVERYTHING_SCOPE_PATH, role))}
      />
      <ScopeRow
        label="Directory"
        detail="Entra ID: app registrations, users and the other findings that sit in no subscription"
        held={heldAt(value, DIRECTORY_SCOPE_PATH)}
        disabled={disabled}
        onToggle={() => onChange(toggleGrant(value, DIRECTORY_SCOPE_PATH, defaultRole))}
        onRole={role => onChange(setGrantRole(value, DIRECTORY_SCOPE_PATH, role))}
      />
      {tree.status === 'loading' && <p className="px-3 py-1.5 text-xs text-ink-2">Loading management groups</p>}
      {tree.status === 'error' && (
        <p className="px-3 py-1.5 text-xs text-ink-2">Management groups could not be loaded, so none can be chosen. Check the server logs.</p>
      )}
      {noGroups && <p className="px-3 py-1.5 text-xs text-ink-2">{noGroups}</p>}
      {mgRows.map(g => (
        <ScopeRow
          key={`mg:${g.path.toLowerCase()}`}
          depth={g.depth}
          label={g.name}
          detail={g.missing ? 'Not in the tree RuleBeat has loaded. Remove it, or refresh the tree.' : `Management group ${g.id}`}
          held={heldAt(value, g.path)}
          disabled={disabled}
          onToggle={() => onChange(toggleGrant(value, g.path, defaultRole))}
          onRole={role => onChange(setGrantRole(value, g.path, role))}
        />
      ))}
      {subscriptions === null && <p className="px-3 py-1.5 text-xs text-ink-2">Loading subscriptions</p>}
      {subscriptions === 'failed' && (
        <p className="px-3 py-1.5 text-xs text-ink-2">Subscriptions could not be loaded, so none can be chosen. Check the server logs.</p>
      )}
      {Array.isArray(subscriptions) && rows.length === 0 && (
        <p className="px-3 py-1.5 text-xs text-ink-2">No subscriptions were found. Connect Azure in Settings to choose a subscription or a resource group.</p>
      )}
      {rows.map(sub => {
        const path = subscriptionScopePath(sub.id);
        const isOpen = open.has(sub.id.toLowerCase());
        return (
          <div key={sub.id}>
            <ScopeRow
              label={sub.name}
              detail={sub.name === sub.id ? undefined : sub.id}
              held={heldAt(value, path)}
              disabled={disabled}
              onToggle={() => onChange(toggleGrant(value, path, defaultRole))}
              onRole={role => onChange(setGrantRole(value, path, role))}
              lead={(
                <button
                  type="button"
                  onClick={() => toggleOpen(sub.id)}
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? 'Hide' : 'Show'} the resource groups of ${sub.name}`}
                  disabled={disabled}
                  className="flex size-5 items-center justify-center text-ink-2 hover:text-ink"
                >
                  {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
              )}
            />
            {isOpen && (
              <ResourceGroupRows
                subscriptionId={sub.id}
                state={groups[sub.id.toLowerCase()]}
                value={value}
                onChange={onChange}
                defaultRole={defaultRole}
                disabled={disabled}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
