'use client';

import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { fetchJson } from '@/lib/fetch-json';
import type { GrantRole, ManualGrant } from '@/lib/access-model';
import { DIRECTORY_SCOPE_PATH, EVERYTHING_SCOPE_PATH, sameScopePath } from '@/lib/access-model';
import { noGroupsReason, type HierarchyView } from '@/lib/management-group-tree';
import { ROLE_LABELS } from '@/lib/rbac';
import {
  coveringGrant, describeScopePath, GROUPS_LOAD_FAILED_MESSAGE, heldAt, heldRows, KIND_LABELS, namesOf, NO_SUBSCRIPTIONS_MESSAGE,
  nothingMatchedMessage, resourceGroupScopePath, resourceGroupsHeld, roleLocked, searchResourceGroups, searchScopes, setGrantRole, subscriptionScopePath, toggleGrant,
  type HeldRow, type PickerCatalogue, type ScopeCandidate, type SubscriptionOption,
} from '@/lib/access-picker';
import { cn } from '@/lib/utils';

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
];

/** How many matches the search lists. A longer list is read by typing more, not by scrolling a box. */
const RESULT_LIMIT = 8;

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

const linkButton = 'text-xs font-medium text-ink underline underline-offset-2 hover:no-underline disabled:opacity-60';

/** One held Scope: what it is, the Role at it, and the controls that change or remove it. */
function HeldScopeRow({ row, personRole, locked, disabled, canLimit, limiting, onRemove, onUnlock, onRelock, onRole, onLimit }: {
  row: HeldRow;
  personRole: GrantRole;
  locked: boolean;
  disabled?: boolean;
  canLimit: boolean;
  limiting: boolean;
  onRemove: () => void;
  onUnlock: () => void;
  onRelock: () => void;
  onRole: (role: GrantRole) => void;
  onLimit: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="label-grid shrink-0">{KIND_LABELS[row.kind]}</span>
          <span className="min-w-0 truncate text-sm font-medium text-ink" title={row.label}>{row.label}</span>
        </div>
        {row.detail && (
          <div className={cn('truncate text-xs text-ink-2', row.kind === 'subscription' && 'font-mono')} title={row.detail}>{row.detail}</div>
        )}
        {canLimit && (
          <button type="button" disabled={disabled} aria-expanded={limiting} onClick={onLimit} className={cn(linkButton, 'mt-1')}>
            Limit to resource groups
          </button>
        )}
      </div>
      {locked ? (
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm text-ink">{ROLE_LABELS[row.role]}</span>
          <button type="button" disabled={disabled} onClick={onUnlock} className={linkButton}>Different Role here</button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          <RoleAt value={row.role} onChange={onRole} disabled={disabled} label={row.label} />
          <button type="button" disabled={disabled} onClick={onRelock} className={linkButton}>Use {ROLE_LABELS[personRole]}</button>
        </div>
      )}
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

/** One thing a search found, or a quick pick: an Add button, or the reason it cannot be added. */
function Offer({ title, detail, kind, coveredBy, disabled, onAdd }: {
  title: string;
  detail?: string;
  kind: string;
  coveredBy: string | null;
  disabled?: boolean;
  onAdd: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="label-grid shrink-0">{kind}</span>
          <span className="min-w-0 truncate text-sm font-medium text-ink" title={title}>{title}</span>
        </div>
        {detail && <div className="truncate font-mono text-xs text-ink-2" title={detail}>{detail}</div>}
      </div>
      {coveredBy ? (
        <span className="shrink-0 text-xs text-ink-2">Covered by {coveredBy}</span>
      ) : (
        <Button type="button" size="sm" variant="outline" disabled={disabled} aria-label={`Add ${title}`} onClick={onAdd}>Add</Button>
      )}
    </li>
  );
}

/** The resource groups of one subscription, searchable. Choosing one narrows the subscription to it. */
function ResourceGroupPanel({ subscription, state, held, value, nodes, defaultRole, disabled, onPick, onDone }: {
  subscription: SubscriptionOption;
  state: GroupsState | undefined;
  held: readonly string[];
  value: readonly ManualGrant[];
  nodes: PickerCatalogue['nodes'];
  defaultRole: GrantRole;
  disabled?: boolean;
  onPick: (name: string) => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState('');
  const listed = state?.status === 'ready' ? state.names : [];
  const names = [...listed, ...held.filter(h => !listed.some(n => n.toLowerCase() === h.toLowerCase()))];
  const found = searchResourceGroups(names, query);
  const subscriptionPath = subscriptionScopePath(subscription.id);
  const others = value.filter(g => !sameScopePath(g.scope, subscriptionPath));
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <Label>Resource groups in {subscription.name}</Label>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>Done</Button>
      </div>
      <p className="text-xs text-ink-2">Choosing a resource group replaces the whole subscription with that resource group.</p>
      <Input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search resource groups"
        aria-label={`Search the resource groups of ${subscription.name}`}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      {state?.status === 'loading' && <p className="text-xs text-ink-2">Loading resource groups</p>}
      {state?.status === 'error' && (
        <p className="text-xs text-ink-2">The resource groups of this subscription could not be loaded. Try again, or check the server logs.</p>
      )}
      {state?.status === 'ready' && names.length === 0 && <p className="text-xs text-ink-2">This subscription has no resource groups.</p>}
      {names.length > 0 && found.length === 0 && <p className="text-xs text-ink-2">No resource group in this subscription matched “{query.trim()}”.</p>}
      {found.length > 0 && (
        <ul className="divide-y divide-border">
          {found.slice(0, RESULT_LIMIT).map(name => {
            const path = resourceGroupScopePath(subscription.id, name);
            const isHeld = Boolean(heldAt(value, path));
            const covering = isHeld ? null : coveringGrant(others, nodes ?? [], path, defaultRole);
            return (
              <li key={name} className="flex items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{name}</span>
                {covering ? (
                  <span className="shrink-0 text-xs text-ink-2">Covered by {describeScopePath(covering.scope)}</span>
                ) : (
                  <Button type="button" size="sm" variant="outline" disabled={disabled} aria-pressed={isHeld} aria-label={`${isHeld ? 'Remove' : 'Add'} ${name}`} onClick={() => onPick(name)}>
                    {isHeld ? 'Added' : 'Add'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {found.length > RESULT_LIMIT && <p className="text-xs text-ink-2">Showing {RESULT_LIMIT} of {found.length}. Type more to narrow the list.</p>}
    </div>
  );
}

/**
 * Chooses the Scopes someone is given. It lists only what they hold, each row with its kind, name, Role and a
 * remove control; a new Scope is found with "Add access", a search over management groups and subscriptions, and
 * Everything and the Directory are always offered. A Scope already covered by one held at the same or a higher
 * Role is refused with the reason, and a new one takes the person's Role until "Different Role here" is chosen.
 * A held management group the loaded tree no longer has stays listed, so it can be removed.
 */
export function ScopePicker({ value, onChange, defaultRole, disabled }: {
  value: readonly ManualGrant[];
  onChange: (next: ManualGrant[]) => void;
  /** The person's Role: what a Scope is given when it is first added. */
  defaultRole: GrantRole;
  disabled?: boolean;
}) {
  const searchId = useId();
  const [subscriptions, setSubscriptions] = useState<SubscriptionOption[] | 'failed' | null>(null);
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [limiting, setLimiting] = useState<SubscriptionOption | null>(null);
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
  const names = namesOf(catalogue);
  const everythingHeld = Boolean(heldAt(value, EVERYTHING_SCOPE_PATH));
  const noSubscriptions = Array.isArray(subscriptions) && subscriptions.length === 0
    && !(catalogue.nodes ?? []).some(n => n.kind === 'subscription');
  const noGroups = tree.status === 'ready' ? noGroupsReason(tree.view.nodes, tree.view.status) : null;

  const coveredBy = (path: string): string | null => {
    const covering = coveringGrant(value, catalogue.nodes ?? [], path, defaultRole);
    return covering ? describeScopePath(covering.scope, names) : null;
  };
  const add = (path: string) => onChange(toggleGrant(value, path, defaultRole));

  const found = searchScopes(query, catalogue);
  const shown = found.slice(0, RESULT_LIMIT);
  const asking = query.trim() !== '';

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

  function limitTo(row: HeldRow) {
    const id = row.path.split('/')[2]!;
    setLimiting({ id, name: row.label });
    if (groups[id.toLowerCase()]?.status !== 'ready') loadGroups(id);
  }

  /** Takes the rows of a subscription's whole Scope for those of the resource group chosen in it. */
  function pickGroup(subscription: SubscriptionOption, name: string) {
    const path = resourceGroupScopePath(subscription.id, name);
    if (heldAt(value, path)) { onChange(toggleGrant(value, path, defaultRole)); return; }
    const whole = heldAt(value, subscriptionScopePath(subscription.id));
    const rest = value.filter(g => !sameScopePath(g.scope, subscriptionScopePath(subscription.id)));
    onChange([...rest, { scope: path, role: whole?.role ?? defaultRole }]);
  }

  const lockKey = (path: string) => path.toLowerCase();
  const rows = heldRows(value, catalogue);

  return (
    <div className={cn('space-y-3', disabled && 'opacity-60')}>
      <div className="bg-surface">
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-sm text-ink-2">Nothing is held yet. Add access below.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(row => (
              <HeldScopeRow
                key={lockKey(row.path)}
                row={row}
                personRole={defaultRole}
                locked={roleLocked({ scope: row.path, role: row.role }, defaultRole, unlocked)}
                disabled={disabled}
                canLimit={row.kind === 'subscription'}
                limiting={limiting !== null && sameScopePath(subscriptionScopePath(limiting.id), row.path)}
                onRemove={() => onChange(toggleGrant(value, row.path, defaultRole))}
                onUnlock={() => setUnlocked(u => new Set(u).add(lockKey(row.path)))}
                onRelock={() => {
                  setUnlocked(u => { const next = new Set(u); next.delete(lockKey(row.path)); return next; });
                  onChange(setGrantRole(value, row.path, defaultRole));
                }}
                onRole={role => onChange(setGrantRole(value, row.path, role))}
                onLimit={() => limitTo(row)}
              />
            ))}
          </ul>
        )}
        {limiting && (
          <div className="border-t border-border">
            <ResourceGroupPanel
              subscription={limiting}
              state={groups[limiting.id.toLowerCase()]}
              held={resourceGroupsHeld(value, limiting.id)}
              value={value}
              nodes={catalogue.nodes}
              defaultRole={defaultRole}
              disabled={disabled}
              onPick={name => pickGroup(limiting, name)}
              onDone={() => setLimiting(null)}
            />
          </div>
        )}
      </div>

      <div className="space-y-2 bg-surface px-3 py-3">
        <Label htmlFor={searchId}>Add access</Label>
        <ul className="divide-y divide-border">
          <Offer
            kind="Quick pick" title="Everything" detail="Every subscription, resource group and the Directory"
            coveredBy={coveredBy(EVERYTHING_SCOPE_PATH)} disabled={disabled} onAdd={() => add(EVERYTHING_SCOPE_PATH)}
          />
          <Offer
            kind="Quick pick" title="Directory" detail="Entra ID, and findings that sit in no subscription"
            coveredBy={coveredBy(DIRECTORY_SCOPE_PATH)} disabled={disabled} onAdd={() => add(DIRECTORY_SCOPE_PATH)}
          />
        </ul>
        <Input
          id={searchId}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search management groups and subscriptions by name or id"
          disabled={disabled || everythingHeld}
          autoComplete="off"
          spellCheck={false}
        />
        {everythingHeld && (
          <p className="text-xs text-ink-2">Everything is held, so every Scope is already covered. Remove Everything to give narrower access.</p>
        )}
        {tree.status === 'loading' && <p className="text-xs text-ink-2">Loading management groups</p>}
        {tree.status === 'error' && (
          <p className="text-xs text-ink-2">{GROUPS_LOAD_FAILED_MESSAGE}</p>
        )}
        {noGroups && <p className="text-xs text-ink-2">{noGroups}</p>}
        {subscriptions === null && <p className="text-xs text-ink-2">Loading subscriptions</p>}
        {subscriptions === 'failed' && (
          <p className="text-xs text-ink-2">Subscriptions could not be loaded, so none can be chosen. Check the server logs.</p>
        )}
        {noSubscriptions && (
          <p className="text-xs text-ink-2">{NO_SUBSCRIPTIONS_MESSAGE}</p>
        )}
        {!everythingHeld && asking && found.length === 0 && (
          <p className="text-xs text-ink-2">{nothingMatchedMessage(query)}</p>
        )}
        {!everythingHeld && shown.length > 0 && (
          <ul className="divide-y divide-border">
            {shown.map((c: ScopeCandidate) => (
              <Offer
                key={`${c.kind}:${c.id.toLowerCase()}`}
                kind={c.kind === 'managementGroup' ? 'Management group' : 'Subscription'}
                title={c.name}
                detail={c.name === c.id ? undefined : c.id}
                coveredBy={coveredBy(c.path)}
                disabled={disabled}
                onAdd={() => { add(c.path); setQuery(''); }}
              />
            ))}
          </ul>
        )}
        {!everythingHeld && found.length > RESULT_LIMIT && (
          <p className="text-xs text-ink-2">Showing {RESULT_LIMIT} of {found.length}. Type more to narrow the list.</p>
        )}
      </div>
    </div>
  );
}
