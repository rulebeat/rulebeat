'use client';

import { useMemo } from 'react';
import { ChevronDown, Filter } from 'lucide-react';

import { ChecklistDropdown, ColumnFilterIcon } from '@/components/ui/checklist-dropdown';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ReadStatus } from '@/components/ui/read-status';
import { ScopeTree } from '@/components/scope-tree';
import { DIRECTORY_SCOPE_PATH, sameScopePath } from '@/lib/access-model';
import { DIRECTORY_DETAIL } from '@/lib/access-picker';
import type { FilterOptionsRead } from '@/lib/hooks/use-filter-options';
import type { ScopeOptions } from '@/lib/scope-options';
import { clearFunnelPicks, funnelOptions, funnelSelected, toggleScopePick, type FunnelKind } from '@/lib/scope-funnels';
import { pathsTo, topLevelKeys, type ScopeTreeItem } from '@/lib/scope-tree';
import { cn } from '@/lib/utils';

/*
 * The shared filter component (#388). The dimensions that come from the one options read are drawn here as
 * controlled pieces: each takes the read, the value it shows and a change handler, and owns no filter state, so
 * the Scans toolbar uses them first and the dashboard bar and the widget Filters panel are built to take the same
 * pieces. A piece whose options did not load says so and offers a retry; it never shows an empty list.
 */

export const OPTIONS_FAILED_MESSAGE = 'The filter options could not be loaded.';

/** What a piece shows in place of its list while the options are not there. */
function OptionsStatus({ read, retry }: { read: FilterOptionsRead; retry: () => void }) {
  return (
    <ReadStatus
      failure={read.status === 'failed' ? OPTIONS_FAILED_MESSAGE : null}
      retry={retry}
      loading="Loading options"
      className="w-[min(20rem,calc(100vw-2rem))] px-3 py-4"
    />
  );
}

const TRIGGER_CLS = 'flex shrink-0 items-center gap-1.5 border transition-colors outline-none h-9 px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';

/** The tree of the Scope picker: the Directory (for whoever holds it) and the held scope tree, each node with a tick.
 *  A pick nested inside another reads "Covered by" it. */
export function ScopePickerTree({ scopes, picks, onChange, disabled }: {
  scopes: ScopeOptions;
  picks: readonly string[];
  onChange: (picks: string[]) => void;
  disabled?: boolean;
}) {
  const items = useMemo<ScopeTreeItem[]>(() => [
    ...(scopes.directory ? [{ key: DIRECTORY_SCOPE_PATH, kind: 'directory' as const, name: 'Directory', detail: DIRECTORY_DETAIL }] : []),
    ...scopes.tree,
  ], [scopes]);
  if (items.length === 0) return <p className="px-1 py-2 text-xs text-ink-2">You hold no Scope to filter by.</p>;
  return (
    <ScopeTree
      items={items}
      searchLabel="Search management groups, subscriptions and resource groups"
      searchPlaceholder="Search by name or id"
      defaultExpanded={[...topLevelKeys(items), ...pathsTo(items, picks), ...picks]}
      selection={{
        isTicked: key => picks.some(pick => sameScopePath(pick, key)),
        onToggle: item => onChange(toggleScopePick(picks, item.key) ?? []),
        disabled,
      }}
    />
  );
}

/** The Scope picker: the Access page's scope tree limited to the Scopes the viewer holds. */
export function ScopeFilter({ read, retry, picks, onChange, disabled, error }: {
  read: FilterOptionsRead;
  retry: () => void;
  picks: readonly string[];
  /** Called with the whole list the viewer wants after the tick. */
  onChange: (picks: string[]) => void;
  /** The picks cannot be edited right now (a set is still being saved, or the list is not open yet). */
  disabled?: boolean;
  /** Why the last change was not kept. */
  error?: string | null;
}) {
  const scopes = read.status === 'ready' ? read.options.scopes : null;
  const active = picks.length > 0;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(TRIGGER_CLS, active ? 'border-ink bg-ink text-background' : 'border-rule-strong bg-surface text-ink hover:bg-surface-hover data-[popup-open]:bg-surface-hover')}
      >
        Scope
        {active && <span className="text-xs font-semibold tabular-nums">{picks.length}</span>}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent>
        {scopes === null ? <OptionsStatus read={read} retry={retry} /> : (
          <div className="min-h-0 w-[min(32rem,calc(100vw-2rem))] scroll-y p-3">
            {error && <p role="alert" className="mb-2 text-xs text-ink">{error}</p>}
            <ScopePickerTree scopes={scopes} picks={picks} onChange={onChange} disabled={disabled} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The Rule source control: each Pack, Community and Custom. */
export function RuleSourceFilter({ read, retry, selected, onToggle, onClear }: {
  read: FilterOptionsRead;
  retry: () => void;
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  if (read.status === 'ready') {
    return (
      <ChecklistDropdown
        label="Rule source"
        options={read.options.sources}
        selected={selected as Set<string>}
        onToggle={onToggle}
        onClear={onClear}
      />
    );
  }
  return (
    <Popover>
      <PopoverTrigger className={cn(TRIGGER_CLS, 'border-rule-strong bg-surface text-ink hover:bg-surface-hover')}>
        Rule source
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent><OptionsStatus read={read} retry={retry} /></PopoverContent>
    </Popover>
  );
}

/** A column header funnel that writes Scope picks: the Subscription column lists the subscriptions (and the
 *  Directory) the viewer's findings are placed in, the Resource group column lists "rg · subscription" pairs. */
export function ScopeFunnel({ kind, label, read, retry, names, picks, onChange, disabled }: {
  kind: FunnelKind;
  label: string;
  read: FilterOptionsRead;
  retry: () => void;
  names: Readonly<Record<string, string>>;
  picks: readonly string[];
  onChange: (picks: string[]) => void;
  disabled?: boolean;
}) {
  const options = useMemo(
    () => (read.status === 'ready' ? funnelOptions(kind, read.options.placements, names) : []),
    [read, kind, names],
  );
  const selected = useMemo(() => funnelSelected(options, picks), [options, picks]);

  if (read.status === 'ready') {
    return (
      <ColumnFilterIcon
        label={label}
        options={options}
        selected={selected}
        onToggle={value => { if (!disabled) onChange(toggleScopePick(picks, value) ?? []); }}
        onClear={() => { if (!disabled) onChange(clearFunnelPicks(kind, picks) ?? []); }}
      />
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Filter ${label}`}
        title={`Filter ${label}`}
        onClick={e => e.stopPropagation()}
        className="shrink-0 p-0.5 text-ink-muted outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        <Filter className="size-3" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent><OptionsStatus read={read} retry={retry} /></PopoverContent>
    </Popover>
  );
}
