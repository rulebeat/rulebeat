'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Layers, Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Segmented, type SegmentedOption } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import type { GroupSort, ViewField } from '@/lib/finding-view';
import type { AddFilterField } from '@/components/findings/add-filter';

const SORT_BY: SegmentedOption<GroupSort['by']>[] = [
  { value: 'value', label: 'Value' },
  { value: 'count', label: 'Resource count' },
];
const SORT_DIR: SegmentedOption<GroupSort['dir']>[] = [
  { value: 'asc', label: 'Ascending' },
  { value: 'desc', label: 'Descending' },
];

/** Group by: pick fields in order (the same list Add filter offers: built-in fields and anything the
 *  rules returned), reorder or remove them, and choose how groups are sorted. Each change applies
 *  at once. */
export function GroupBy({
  fields, groupBy, groupSort, fieldLabel, onGroupBy, onGroupSort,
}: {
  fields: AddFilterField[];
  groupBy: ViewField[];
  groupSort: GroupSort;
  fieldLabel: (field: ViewField) => string;
  onGroupBy: (groupBy: ViewField[]) => void;
  onGroupSort: (groupSort: GroupSort) => void;
}) {
  const [search, setSearch] = useState('');

  const remaining = fields
    .filter(f => !groupBy.includes(f.field))
    .filter(f => !search || f.label.toLowerCase().includes(search.toLowerCase()));
  const move = (index: number, by: -1 | 1) => {
    const next = [...groupBy];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onGroupBy(next);
  };

  return (
    <Popover onOpenChange={open => { if (!open) setSearch(''); }}>
      <PopoverTrigger
        className={cn(
          'flex h-9 shrink-0 items-center gap-1.5 border bg-surface px-3 text-sm text-ink outline-none transition-colors',
          groupBy.length > 0 ? 'border-ink' : 'border-rule-strong',
          'hover:bg-surface-hover data-[popup-open]:bg-surface-hover',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        )}
      >
        <Layers className="size-3.5" aria-hidden="true" />
        Group by
        {groupBy.length > 0 && <span className="numeral-grid text-xs text-ink-2">{groupBy.length}</span>}
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))]">
        <div className="min-h-0 flex-1 scroll-y">
          <div className="border-b border-border px-3 py-2">
            <p className="label-grid mb-1.5">Grouped by</p>
            {groupBy.length === 0 ? (
              <p className="py-1 text-xs text-ink-2">No grouping. Pick a field below to group the list.</p>
            ) : (
              <ol className="space-y-px">
                {groupBy.map((field, i) => (
                  <li key={field} className="flex items-center gap-1">
                    <span className="numeral-grid w-5 shrink-0 text-xs text-ink-2">{i + 1}</span>
                    <span className="min-w-0 flex-1 break-words text-xs text-ink">{fieldLabel(field)}</span>
                    <Button variant="ghost" size="icon-xs" title="Move earlier" aria-label={`Move ${fieldLabel(field)} earlier`}
                      disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp />
                    </Button>
                    <Button variant="ghost" size="icon-xs" title="Move later" aria-label={`Move ${fieldLabel(field)} later`}
                      disabled={i === groupBy.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown />
                    </Button>
                    <Button variant="ghost" size="icon-xs" title="Remove" aria-label={`Stop grouping by ${fieldLabel(field)}`}
                      onClick={() => onGroupBy(groupBy.filter(g => g !== field))}>
                      <X />
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="space-y-2 border-b border-border px-3 py-2">
            <p className="label-grid">Sort groups by</p>
            <Segmented label="Sort groups by" optionClassName="flex-1" options={SORT_BY}
              isOn={by => groupSort.by === by} onSelect={by => onGroupSort({ ...groupSort, by })} />
            <Segmented label="Group direction" optionClassName="flex-1" options={SORT_DIR}
              isOn={dir => groupSort.dir === dir} onSelect={dir => onGroupSort({ ...groupSort, dir })} />
          </div>

          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-3.5 shrink-0 text-ink-2" aria-hidden="true" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Add a field to group by"
              aria-label="Add a field to group by"
              className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-2"
            />
          </div>
          <ul className="py-1">
            {remaining.length === 0 && <li className="px-3 py-4 text-center text-xs text-ink-2">No matching field</li>}
            {remaining.map(f => (
              <li key={f.field}>
                <button
                  type="button"
                  onClick={() => onGroupBy([...groupBy, f.field])}
                  className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink outline-none hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="min-w-0 flex-1 break-words">{f.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
