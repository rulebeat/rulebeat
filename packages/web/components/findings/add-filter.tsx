'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Search, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ChecklistPanel, type ChecklistOption } from '@/components/ui/checklist-dropdown';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { ViewField } from '@/lib/finding-view';

export interface AddFilterField {
  field: ViewField;
  label: string;
}

/** The one generic filter control: pick a field (a built-in one or anything the rules returned),
 *  then tick values among those the current findings hold. Each tick is applied at once. */
export function AddFilter({
  fields, optionsFor, selectedFor, onToggle, onClear,
}: {
  fields: AddFilterField[];
  optionsFor: (field: ViewField) => ChecklistOption[];
  selectedFor: (field: ViewField) => Set<string>;
  onToggle: (field: ViewField, value: string) => void;
  onClear: (field: ViewField) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<AddFilterField | null>(null);
  const [search, setSearch] = useState('');

  const visible = search
    ? fields.filter(f => f.label.toLowerCase().includes(search.toLowerCase()))
    : fields;

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) { setPicked(null); setSearch(''); }
      }}
    >
      <PopoverTrigger
        className={cn(
          'flex h-9 shrink-0 items-center gap-1.5 border border-rule-strong bg-surface px-3 text-sm text-ink outline-none transition-colors',
          'hover:bg-surface-hover data-[popup-open]:bg-surface-hover',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        )}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Add filter
      </PopoverTrigger>
      <PopoverContent>
        {picked ? (
          <div className="flex min-h-0 flex-col">
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2 text-left text-xs font-medium text-ink outline-none hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
              <span className="min-w-0 truncate">{picked.label}</span>
            </button>
            <ChecklistPanel
              label={picked.label}
              options={optionsFor(picked.field)}
              selected={selectedFor(picked.field)}
              onToggle={value => onToggle(picked.field, value)}
              onClear={() => onClear(picked.field)}
            />
          </div>
        ) : (
          <div className="flex min-h-0 w-[min(26rem,calc(100vw-2rem))] flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <Search className="size-3.5 shrink-0 text-ink-2" aria-hidden="true" />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter by field"
                aria-label="Filter by field"
                className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-muted"
              />
            </div>
            <ul className="min-h-0 flex-1 scroll-y py-1">
              {visible.length === 0 && <li className="px-3 py-4 text-center text-xs text-ink-2">No matching field</li>}
              {visible.map(f => (
                <li key={f.field}>
                  <button
                    type="button"
                    onClick={() => { setPicked(f); setSearch(''); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink outline-none hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <span className="min-w-0 flex-1 break-words">{f.label}</span>
                    <ChevronRight className="size-3.5 shrink-0 text-ink-2" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export interface FilterChip {
  field: ViewField;
  value: string;
  fieldLabel: string;
  valueLabel: string;
}

/** The active filters, one soft-filled chip per value, each removable. */
export function FilterChips({ chips, onRemove }: { chips: FilterChip[]; onRemove: (chip: FilterChip) => void }) {
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
      {chips.map(chip => (
        <li key={`${chip.field}\u0000${chip.value}`}>
          <Badge variant="secondary" className="h-7 max-w-full gap-1 pr-1">
            <span className="text-ink-2">{chip.fieldLabel}</span>
            <span className="min-w-0 truncate" title={chip.valueLabel}>{chip.valueLabel === '' ? 'Empty' : chip.valueLabel}</span>
            <button
              type="button"
              onClick={() => onRemove(chip)}
              aria-label={`Remove filter ${chip.fieldLabel}: ${chip.valueLabel === '' ? 'Empty' : chip.valueLabel}`}
              className="flex size-5 shrink-0 items-center justify-center text-ink-2 outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </Badge>
        </li>
      ))}
    </ul>
  );
}
