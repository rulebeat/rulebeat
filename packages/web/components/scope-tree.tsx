'use client';

import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  anyMatch, coveredBy, pathsToMatches, treeRows, type ScopeTreeItem, type ScopeTreeKind,
} from '@/lib/scope-tree';
import { cn } from '@/lib/utils';

const KIND_LABELS: Record<ScopeTreeKind, string> = {
  directory: 'Directory',
  managementGroup: 'Management group',
  subscription: 'Subscription',
  resourceGroup: 'Resource group',
};

/** What a tree with ticks does: which nodes are ticked, and what a tick or an untick asks for. */
export interface ScopeTreeSelection {
  isTicked: (key: string) => boolean;
  onToggle: (item: ScopeTreeItem) => void;
  disabled?: boolean;
}

/** One node: the expand control, the tick when the tree has them, the name and its detail, and its kind. */
function ScopeTreeRow({ item, depth, expandable, expanded, ticked, covered, selection, onExpand }: {
  item: ScopeTreeItem;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  ticked: boolean;
  /** The ticked node above this one, which already gives it. */
  covered: string | undefined;
  selection: ScopeTreeSelection | undefined;
  onExpand: () => void;
}) {
  const name = (
    <span className="min-w-0 flex-1">
      <span className={cn('block truncate text-sm text-ink', item.kind !== 'resourceGroup' && 'font-medium')} title={item.name}>
        {item.name}
      </span>
      {item.detail && item.detail !== item.name && (
        <span className="block truncate font-mono text-xs text-ink-2" title={item.detail}>{item.detail}</span>
      )}
    </span>
  );
  return (
    <li className="flex items-center gap-2 py-1 pr-3" style={{ paddingLeft: `${8 + depth * 20}px` }}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.name}`}
          onClick={onExpand}
          className="flex size-6 shrink-0 items-center justify-center text-ink-2 hover:bg-surface-hover hover:text-ink"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      ) : (
        <span className="size-6 shrink-0" />
      )}
      {selection ? (
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-ink"
            aria-label={item.name}
            checked={ticked || covered !== undefined}
            disabled={selection.disabled || (covered !== undefined && !ticked)}
            onChange={() => selection.onToggle(item)}
          />
          {name}
        </label>
      ) : name}
      {covered !== undefined && <span className="shrink-0 text-xs text-ink-2">Covered by {covered}</span>}
      <span className="label-grid shrink-0">{KIND_LABELS[item.kind]}</span>
    </li>
  );
}

/**
 * The scope tree (#311). Every node expands and collapses; a node marked `lazy` asks for its children through
 * `onExpand` the first time it opens. The search keeps each match under its parents and opens the path to it.
 * With a `selection` each node has a tick, and a node beneath a ticked one shows as covered and cannot be ticked
 * again. Without one the tree is read-only. It lists every row in place, with no scroll box of its own.
 */
export function ScopeTree({ items, searchLabel, searchPlaceholder, defaultExpanded = [], selection, onExpand, autoFocusSearch, className }: {
  items: readonly ScopeTreeItem[];
  /** Names the search box: "Search management groups and subscriptions". */
  searchLabel: string;
  searchPlaceholder?: string;
  /** The keys open to start with. */
  defaultExpanded?: readonly string[];
  selection?: ScopeTreeSelection;
  onExpand?: (item: ScopeTreeItem) => void;
  autoFocusSearch?: boolean;
  className?: string;
}) {
  const searchId = useId();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded));
  const [query, setQuery] = useState('');

  function search(next: string) {
    setQuery(next);
    const open = pathsToMatches(items, next);
    if (open.length > 0) setExpanded(e => new Set([...e, ...open]));
  }

  function toggle(item: ScopeTreeItem, isOpen: boolean) {
    setExpanded(e => {
      const next = new Set(e);
      if (isOpen) next.delete(item.key);
      else next.add(item.key);
      return next;
    });
    if (!isOpen && item.lazy) onExpand?.(item);
  }

  const rows = treeRows(items, expanded, query);
  const covered = selection ? coveredBy(items, selection.isTicked) : new Map<string, string>();

  return (
    <div className={cn('space-y-2', className)}>
      <Input
        id={searchId}
        value={query}
        onChange={e => search(e.target.value)}
        placeholder={searchPlaceholder ?? searchLabel}
        aria-label={searchLabel}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocusSearch}
      />
      {!anyMatch(items, query) ? (
        <p className="px-2 py-1 text-sm text-ink-2">Nothing matched “{query.trim()}”. Try part of a name or an id.</p>
      ) : (
        <ul>
          {rows.map(row => (
            <ScopeTreeRowWithNote
              key={row.item.key}
              {...row}
              ticked={selection?.isTicked(row.item.key) ?? false}
              covered={covered.get(row.item.key)}
              selection={selection}
              onExpand={() => toggle(row.item, row.expanded)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A row, and the line an open node with no children says in their place. */
function ScopeTreeRowWithNote(props: Parameters<typeof ScopeTreeRow>[0]) {
  const { item, depth, expanded } = props;
  const empty = expanded && (item.children?.length ?? 0) === 0;
  return (
    <>
      <ScopeTreeRow {...props} />
      {empty && item.note && (
        <li className="py-1 pr-3 text-xs text-ink-2" style={{ paddingLeft: `${8 + (depth + 1) * 20 + 32}px` }}>{item.note}</li>
      )}
    </>
  );
}
