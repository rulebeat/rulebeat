'use client';

import { useState } from 'react';
import { Check, ChevronDown, Filter, Search, X } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/* "Pick one or more of these values" — the filter used for Tags, Category,
 * Severity, Policy and so on.
 *
 * It used to position itself with a manual getBoundingClientRect and a fixed
 * overlay, which meant it never flipped near the bottom of the window and never
 * followed its trigger on scroll. It sits on the shared Popover now, so all of
 * that is handled in one place, and its height comes from the room the viewport
 * actually has rather than a hardcoded 240px.
 *
 * Two triggers, one panel: a labelled toolbar button, and a compact funnel icon
 * for a column header. */

export interface ChecklistOption {
  value: string;
  label: string;
  count?: number;
}

/** At module scope on purpose. Declared inside a parent's render it would be a
 *  new component type on every keystroke, React would remount it, and the search
 *  box would lose focus after the first character. */
function ChecklistPanel({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: ChecklistOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState('');
  const visible = search
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  return (
    /* Wide enough for a rule name, capped so it still fits a narrow window. The
       panel used to be a flat w-72 with every label truncated, which made the rule
       filter unusable: the names differ at the end, and nothing revealed the rest. */
    <div className="flex min-h-0 w-[min(26rem,calc(100vw-2rem))] flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Search className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        <input
          autoFocus
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Filter ${label.toLowerCase()}`}
          className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label="Clear search"
            className="shrink-0 text-ink-muted transition-colors hover:text-ink"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 scroll-y py-1">
        {visible.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-ink-muted">No matches</p>
        ) : (
          visible.map(o => {
            const checked = selected.has(o.value);
            return (
              <label
                key={o.value}
                title={o.label}
                className="flex cursor-pointer items-start gap-2.5 px-3 py-1.5 select-none hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(o.value)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 flex size-3.5 shrink-0 items-center justify-center border transition-colors',
                    checked ? 'border-ink bg-ink text-background' : 'border-rule-strong',
                  )}
                >
                  {checked && <Check className="size-2.5" />}
                </span>
                {/* Wraps rather than truncates. A checklist is how you pick the right
                    one of several similar names, so cutting them off defeats the control. */}
                <span className="min-w-0 flex-1 text-xs leading-snug break-words text-ink">{o.label}</span>
                {o.count !== undefined && (
                  <span className="mt-px shrink-0 text-xs tabular-nums text-ink">{o.count}</span>
                )}
              </label>
            );
          })
        )}
      </div>

      {selected.size > 0 && (
        <div className="shrink-0 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-ink-2 transition-colors hover:text-ink"
          >
            Clear selection
          </button>
        </div>
      )}
    </div>
  );
}

/** Labelled toolbar trigger. */
export function ChecklistDropdown({
  label,
  options,
  selected,
  onToggle,
  onClear,
  size = 'default',
}: {
  label: string;
  options: ChecklistOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
  /** `sm` matches the severity chips in a filter row; `default` matches the
   *  h-9 inputs and buttons in a page toolbar. */
  size?: 'sm' | 'default';
}) {
  const active = selected.size > 0;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'flex shrink-0 items-center gap-1.5 border transition-colors outline-none',
          size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3 text-sm',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          active
            ? 'border-ink bg-ink text-background'
            : 'border-rule-strong bg-surface text-ink hover:bg-surface-hover data-[popup-open]:bg-surface-hover',
        )}
      >
        {label}
        {active && <span className="text-xs font-semibold tabular-nums">{selected.size}</span>}
        <ChevronDown
          className="size-3.5 transition-transform data-[popup-open]:rotate-180"
          aria-hidden="true"
        />
      </PopoverTrigger>
      <PopoverContent>
        <ChecklistPanel
          label={label}
          options={options}
          selected={selected}
          onToggle={onToggle}
          onClear={onClear}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Compact column-header trigger: a funnel that fills in when the column is filtered. */
export function ColumnFilterIcon({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: ChecklistOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const active = selected.size > 0;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Filter ${label}`}
        title={`Filter ${label}`}
        onClick={e => e.stopPropagation()}
        className={cn(
          'shrink-0 p-0.5 transition-colors outline-none',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          active ? 'text-ink' : 'text-ink-faint hover:text-ink',
        )}
      >
        <Filter className="size-3" fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent>
        <ChecklistPanel
          label={label}
          options={options}
          selected={selected}
          onToggle={onToggle}
          onClear={onClear}
        />
      </PopoverContent>
    </Popover>
  );
}
