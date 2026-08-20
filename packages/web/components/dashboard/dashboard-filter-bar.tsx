'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ChecklistDropdown } from '@/components/ui/checklist-dropdown';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { SEVERITY_LABEL } from '@/components/dashboard/dashboard-constants';
import { toggleInSet } from '@/lib/toggle-set';
import { useSubscriptionNames } from '@/lib/hooks/use-subscription-names';
import type { DateWindow } from '@/lib/date-window';
import type { Category, FilterOptionsResponse, Severity } from '@/lib/types';

export interface DashboardFilters {
  categories: string[];
  subscriptions: string[];
  resourceGroups: string[];
  tags: string[];
  severities: Severity[];
  ruleIds: string[];
}

const SEVERITY_OPTIONS: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

interface Props {
  filters: DashboardFilters;
  dateWindow: DateWindow;
  onFiltersChange: (next: DashboardFilters) => void;
  onDateWindowChange: (w: DateWindow) => void;
}

/** Dashboard-level filter toolbar — Category/Rule/Subscription/Tags/Severity multi-selects plus a
 *  24h/7d/30d/custom window control. Persistence (debounced PUT) and refetch-triggering
 *  (refreshKey bump) both live in the parent (`dashboard-grid-client.tsx`); this component only
 *  reports changes upward via `onFiltersChange`/`onDateWindowChange`. */
export function DashboardFilterBar({ filters, dateWindow, onFiltersChange, onDateWindowChange }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [subscriptionIds, setSubscriptionIds] = useState<string[]>([]);
  const subNames = useSubscriptionNames();
  const [resourceGroups, setResourceGroups] = useState<string[]>([]);
  const [rules, setRules] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    fetch('/api/widgets/filter-options')
      .then(r => r.ok ? r.json() : null)
      .then((d: FilterOptionsResponse | null) => {
        if (!d) return;
        setCategories(d.categories);
        setTags(d.tags);
        setSubscriptionIds(d.subscriptions);
        setResourceGroups(d.resourceGroups);
        setRules(d.rules);
      })
      .catch(() => {});
  }, []);

  const categoryOptions = categories.map(c => ({ value: c.id, label: c.label }));
  const subscriptionOptions = subscriptionIds.map(id => ({ value: id, label: subNames[id] ?? id }));
  const resourceGroupOptions = resourceGroups.map(rg => ({ value: rg, label: rg }));
  const tagOptions = tags.map(t => ({ value: t, label: t }));
  const severityOptions = SEVERITY_OPTIONS.map(s => ({ value: s, label: SEVERITY_LABEL[s] }));
  const ruleOptions = rules.map(r => ({ value: r.id, label: r.name }));

  const hasActiveFilters = filters.categories.length > 0 || filters.subscriptions.length > 0
    || filters.resourceGroups.length > 0 || filters.tags.length > 0
    || filters.severities.length > 0 || filters.ruleIds.length > 0;

  function toggle(dim: keyof DashboardFilters, value: string) {
    const next = toggleInSet(new Set(filters[dim] as string[]), value);
    onFiltersChange({ ...filters, [dim]: Array.from(next) });
  }

  function clearAll() {
    onFiltersChange({ categories: [], subscriptions: [], resourceGroups: [], tags: [], severities: [], ruleIds: [] });
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-6 py-2.5">
      <ChecklistDropdown
        label="Category"
        options={categoryOptions}
        selected={new Set(filters.categories)}
        onToggle={v => toggle('categories', v)}
        onClear={() => onFiltersChange({ ...filters, categories: [] })}
      />
      <ChecklistDropdown
        label="Rule"
        options={ruleOptions}
        selected={new Set(filters.ruleIds)}
        onToggle={v => toggle('ruleIds', v)}
        onClear={() => onFiltersChange({ ...filters, ruleIds: [] })}
      />
      <ChecklistDropdown
        label="Subscription"
        options={subscriptionOptions}
        selected={new Set(filters.subscriptions)}
        onToggle={v => toggle('subscriptions', v)}
        onClear={() => onFiltersChange({ ...filters, subscriptions: [] })}
      />
      <ChecklistDropdown
        label="Resource Group"
        options={resourceGroupOptions}
        selected={new Set(filters.resourceGroups)}
        onToggle={v => toggle('resourceGroups', v)}
        onClear={() => onFiltersChange({ ...filters, resourceGroups: [] })}
      />
      <ChecklistDropdown
        label="Tags"
        options={tagOptions}
        selected={new Set(filters.tags)}
        onToggle={v => toggle('tags', v)}
        onClear={() => onFiltersChange({ ...filters, tags: [] })}
      />
      <ChecklistDropdown
        label="Severity"
        options={severityOptions}
        selected={new Set(filters.severities)}
        onToggle={v => toggle('severities', v)}
        onClear={() => onFiltersChange({ ...filters, severities: [] })}
      />

      {hasActiveFilters && (
        <button
          onClick={clearAll}
          className="flex h-9 items-center gap-1 px-2.5 text-xs font-medium text-ink-2 transition-colors hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />Clear
        </button>
      )}

      <div className="ml-auto">
        <DateRangePicker value={dateWindow} onChange={onDateWindowChange} />
      </div>
    </div>
  );
}
