'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Link2 } from 'lucide-react';
import { ChecklistDropdown, type ChecklistOption } from '@/components/ui/checklist-dropdown';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { SEVERITY_LABEL } from '@/components/dashboard/dashboard-constants';
import {
  ANY_WIDENS_REASON, BAR_LIST_DIMENSIONS, backToSaved, pickAny, toggleValue, vanishedText,
  type BarDimension, type BarLayers, type BarListDimension, type DashboardBarState,
} from '@/lib/dashboard-bar';
import { dashboardAddress, type DashboardFilterChanges, type DashboardFilters } from '@/lib/finding-view';
import { dateWindowLabel } from '@/lib/date-window';
import { useSubscriptionNames } from '@/lib/hooks/use-subscription-names';
import type { OutsideAccess } from '@/lib/outside-access';
import type { FilterOptionsResponse } from '@/lib/types';

const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low', 'info'];

/** The row that stands for the values outside the viewer's Access. Its value is no value any filter can hold. */
export const OUTSIDE_ROW = '\u0000outside';

const DIMENSION_LABEL: Record<BarListDimension, string> = {
  category: 'Category', rule: 'Rule', subscription: 'Subscription', resourceGroup: 'Resource group', tags: 'Tags', severity: 'Severity',
};

/** The noun a sentence uses for a dimension ("2 widgets use their own severity"). */
const DIMENSION_NOUN: Record<BarDimension, string> = {
  category: 'category', rule: 'rule', subscription: 'subscription', resourceGroup: 'resource group', tags: 'tags', severity: 'severity', window: 'date window',
};

export function outsideRowLabel(count: number): string {
  return `${count} outside your access`;
}

/** What the "N widgets use their own severity" line says. */
export function overrideNote(dimension: BarDimension, count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? `1 widget uses its own ${DIMENSION_NOUN[dimension]}`
    : `${count} widgets use their own ${DIMENSION_NOUN[dimension]}`;
}

/**
 * What one dimension's checklist shows and does. The ticked values are the effective ones the viewer
 * holds; what is outside their Access is one row they cannot tick; a value that no longer exists
 * stays ticked, named, and comes off like any other. A pick is written through `replace`, and one that
 * would widen the dimension is shown off with its reason, so it is never offered to make.
 */
export function dimensionControl(input: {
  dimension: BarListDimension;
  state: DashboardBarState;
  layers: BarLayers;
  options: readonly ChecklistOption[];
  replace: (changes: DashboardFilterChanges) => void;
  /** The name a value reads as, for those that have one (a subscription's display name). */
  nameOf?: (value: string) => string;
}): {
  options: ChecklistOption[];
  selected: Set<string>;
  count: number;
  onToggle: (value: string) => void;
  onClear: () => void;
  clearHint: string | undefined;
} {
  const { dimension, state, layers, replace } = input;
  const dim = state.dimensions[dimension];
  const nameOf = input.nameOf ?? ((value: string) => value);
  const outside = dim.inUrl ? dim.outside.url : dim.outside.saved;

  const listed = new Set(input.options.map(o => o.value));
  const gone = dim.vanished
    .filter(v => !listed.has(v.value))
    .map(v => ({ value: v.value, label: vanishedText(v, nameOf) }));
  const known = [...input.options, ...gone].map(option => {
    if (!dim.effective.includes(option.value)) return option;
    const picked = toggleValue(layers, dimension, option.value);
    return 'refused' in picked ? { ...option, disabledReason: picked.refused } : option;
  });
  const options: ChecklistOption[] = outside > 0
    ? [...known, { value: OUTSIDE_ROW, label: outsideRowLabel(outside), disabledReason: 'They stay in the filter and are not named.' }]
    : known;

  return {
    options,
    selected: new Set(outside > 0 ? [...dim.effective, OUTSIDE_ROW] : dim.effective),
    count: dim.effective.length + outside,
    onToggle: value => {
      if (value === OUTSIDE_ROW) return;
      const picked = toggleValue(layers, dimension, value);
      if ('changes' in picked) replace(picked.changes);
    },
    onClear: () => {
      const picked = pickAny(layers, dimension);
      if ('changes' in picked) replace(picked.changes);
    },
    clearHint: dim.outside.saved + dim.outside.url > 0 ? ANY_WIDENS_REASON : undefined,
  };
}

/**
 * Writes `changes` to the address: the dashboard's own params replaced, every other param kept. It is a
 * `replace`, so a pick adds no history entry, and nothing about it saves to the dashboard.
 */
export function replaceChanges(
  router: { replace: (href: string, options?: { scroll?: boolean }) => void },
  pathname: string,
  searchParams: URLSearchParams,
  saved: DashboardFilters,
  changes: DashboardFilterChanges,
): void {
  const query = dashboardAddress(saved).write(changes, searchParams).toString();
  router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
}

interface Props {
  /** The bar for this viewer, computed on the server from the address in the request. */
  state: DashboardBarState;
  /** The filters the dashboard saved. The address holds only differences from them. */
  saved: DashboardFilters;
  /** The saved, address and widget values the viewer's Access does not reach. */
  marks: OutsideAccess;
}

/** The dashboard's filter bar. A pick is written to the address with `router.replace`: nothing is saved
 *  to the dashboard, no history entry is added and leaving the page asks nothing. The page and the
 *  widgets read the same address, so the numbers and the bar change together. */
export function DashboardFilterBar({ state, saved, marks }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const subNames = useSubscriptionNames();
  const [options, setOptions] = useState<FilterOptionsResponse | null>(null);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);

  useEffect(() => {
    fetch('/api/widgets/filter-options')
      .then(r => r.ok ? r.json() : null)
      .then((d: FilterOptionsResponse | null) => { if (d) setOptions(d); })
      .catch(() => {});
  }, []);

  const address = dashboardAddress(saved);
  const changes = address.read(searchParams);
  const layers: BarLayers = { saved, changes, marks };

  const replace = (next: DashboardFilterChanges) => replaceChanges(router, pathname, searchParams, saved, next);

  const categoryLabels = new Map((options?.categories ?? []).map(c => [c.id, c.label]));
  const ruleNames = new Map((options?.rules ?? []).map(r => [r.id, r.name]));
  const nameOfSubscription = (id: string) => subNames[id] ?? id;
  const lists: Record<BarListDimension, ChecklistOption[]> = {
    category: (options?.categories ?? []).map(c => ({ value: c.id, label: c.label })),
    rule: (options?.rules ?? []).map(r => ({ value: r.id, label: r.name })),
    subscription: (options?.subscriptions ?? []).map(id => ({ value: id, label: nameOfSubscription(id) })),
    resourceGroup: (options?.resourceGroups ?? []).map(rg => ({ value: rg, label: rg })),
    tags: (options?.tags ?? []).map(t => ({ value: t, label: t })),
    severity: SEVERITY_OPTIONS.map(s => ({ value: s, label: SEVERITY_LABEL[s as keyof typeof SEVERITY_LABEL] ?? s })),
  };
  const nameOf: Partial<Record<BarListDimension, (value: string) => string>> = {
    category: id => categoryLabels.get(id) ?? id,
    rule: id => ruleNames.get(id) ?? id,
    subscription: nameOfSubscription,
    severity: s => SEVERITY_LABEL[s as keyof typeof SEVERITY_LABEL] ?? s,
  };

  const savedLine = (dimension: BarListDimension): string => {
    const dim = state.dimensions[dimension];
    const gone = new Map(dim.savedVanished.map(v => [v.value, v]));
    const named = dim.saved.map(v => {
      const vanished = gone.get(v);
      return vanished ? vanishedText(vanished, nameOf[dimension]) : nameOf[dimension]?.(v) ?? v;
    });
    const parts = dim.outside.saved > 0 ? [...named, outsideRowLabel(dim.outside.saved)] : named;
    return parts.length > 0 ? parts.join(', ') : 'Any';
  };

  const anyChanged = BAR_LIST_DIMENSIONS.some(d => state.dimensions[d].changed) || state.window.changed;

  async function copyLink() {
    const query = address.write(changes).toString();
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${pathname}${query ? `?${query}` : ''}`);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-start gap-x-2 gap-y-2 border-b border-border bg-surface px-6 py-2.5">
      {BAR_LIST_DIMENSIONS.map(dimension => {
        const control = dimensionControl({
          dimension, state, layers, options: lists[dimension], replace, nameOf: nameOf[dimension],
        });
        const dim = state.dimensions[dimension];
        const note = overrideNote(dimension, state.overriddenBy[dimension]);
        return (
          <div key={dimension} className="flex min-w-0 flex-col items-start gap-1">
            <ChecklistDropdown
              label={DIMENSION_LABEL[dimension]}
              options={control.options}
              selected={control.selected}
              count={control.count}
              onToggle={control.onToggle}
              onClear={control.onClear}
              clearHint={control.clearHint}
            />
            {dim.changed && (
              <div className="flex max-w-56 flex-col items-start gap-0.5 text-xs">
                <span className="font-semibold text-ink">Changed</span>
                <span className="break-words text-ink-2">Saved: {savedLine(dimension)}</span>
                <button type="button" onClick={() => replace(backToSaved(changes, dimension))} className="text-ink underline underline-offset-2">
                  Back to saved
                </button>
              </div>
            )}
            {note && <span className="max-w-56 text-xs text-ink-2">{note}</span>}
          </div>
        );
      })}

      <div className="ml-auto flex min-w-0 flex-col items-end gap-1">
        <DateRangePicker value={state.window.effective} onChange={w => replace({ ...changes, window: w })} />
        {state.window.changed && (
          <div className="flex flex-col items-end gap-0.5 text-xs">
            <span className="font-semibold text-ink">Changed</span>
            <span className="text-ink-2">Saved: {dateWindowLabel(state.window.saved)}</span>
            <button type="button" onClick={() => replace(backToSaved(changes, 'window'))} className="text-ink underline underline-offset-2">
              Back to saved
            </button>
          </div>
        )}
        {overrideNote('window', state.overriddenBy.window) && (
          <span className="text-xs text-ink-2">{overrideNote('window', state.overriddenBy.window)}</span>
        )}
      </div>

      <div className="flex basis-full flex-wrap items-center gap-3 text-xs text-ink-2">
        {anyChanged && (
          <button type="button" onClick={() => replace({})} className="font-medium text-ink underline underline-offset-2">
            Reset to saved filters
          </button>
        )}
        <button type="button" onClick={copyLink} className="flex items-center gap-1 font-medium text-ink underline underline-offset-2">
          <Link2 className="size-3.5" aria-hidden="true" />Copy link
        </button>
        <span>
          {copied === 'copied' ? 'Link copied. ' : copied === 'failed' ? 'The link could not be copied. Copy it from the address bar. ' : ''}The link carries only the changes. Each person sees what their own Access allows.
        </span>
      </div>
    </div>
  );
}
