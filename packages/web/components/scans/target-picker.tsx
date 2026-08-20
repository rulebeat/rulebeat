'use client';

import { useMemo } from 'react';
import { ChecklistDropdown } from '@/components/ui/checklist-dropdown';
import { cn } from '@/lib/utils';
import { toggleInSet } from '@/lib/toggle-set';
import type { Category, Rule } from '@/lib/types';
import type { ScheduleTargetType } from '@/lib/db/schedules';

interface TargetPickerProps {
  targetType: ScheduleTargetType;
  targetValues: Set<string>;
  onTargetTypeChange: (t: ScheduleTargetType) => void;
  onTargetValuesChange: (v: Set<string>) => void;
  categories: Category[];
  rules: Rule[];
  label?: string;
}

/** All/Categories/Tags/Rules target selector — shared between schedule creation and the
 *  ad-hoc "Run Scan" picker so both surfaces express the same targeting model. */
export function TargetPicker({
  targetType, targetValues, onTargetTypeChange, onTargetValuesChange, categories, rules, label = 'Target',
}: TargetPickerProps) {
  const categoryOptions = useMemo(() => categories.map(c => ({ value: c.id, label: c.label })), [categories]);
  const enabledRules = useMemo(() => rules.filter(r => r.enabled), [rules]);
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of enabledRules) for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, label: value, count }));
  }, [enabledRules]);
  const categoryById = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories]);
  // Disabled rules can never actually run (resolveRulesForSchedule filters to enabled rules at
  // execution time regardless of target), so offering them here would let you "target" something
  // that's silently a no-op. Excluded from the options entirely rather than shown-but-disabled.
  const ruleOptions = useMemo(() => enabledRules.map(r => ({
    value: r.id,
    label: `${r.name} · ${categoryById.get(r.category)?.label ?? r.category}`,
  })), [enabledRules, categoryById]);

  function toggleValue(value: string) {
    onTargetValuesChange(toggleInSet(targetValues, value));
  }

  // Mirrors resolveRulesForSchedule (lib/schedule-target.ts) so the picker shows the same thing
  // that will actually run — catches the case a rules-list filter alone can't: a whole category
  // or tag whose rules happen to all be disabled right now.
  const resolved = useMemo(() => {
    let matched: Rule[];
    switch (targetType) {
      case 'all':
        matched = enabledRules;
        break;
      case 'categories':
        matched = enabledRules.filter(r => targetValues.has(r.category));
        break;
      case 'tags':
        matched = enabledRules.filter(r => (r.tags ?? []).some(t => targetValues.has(t)));
        break;
      case 'rules':
        matched = enabledRules.filter(r => targetValues.has(r.id));
        break;
    }
    return { ruleCount: matched.length };
  }, [targetType, targetValues, enabledRules]);

  const hasSelection = targetType === 'all' || targetValues.size > 0;
  const nothingWillRun = hasSelection && resolved.ruleCount === 0;

  return (
    <div>
      <span className="label-grid mb-1.5 block">{label}</span>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {([
          ['all', 'All categories'],
          ['categories', 'Specific categories'],
          ['tags', 'Specific tags'],
          ['rules', 'Specific rules'],
        ] as [ScheduleTargetType, string][]).map(([value, lbl]) => (
          <button
            key={value}
            type="button"
            onClick={() => { onTargetTypeChange(value); onTargetValuesChange(new Set()); }}
            className={cn(
              'h-8 border px-3 text-xs font-medium transition-colors',
              targetType === value
                ? 'border-ink bg-ink text-surface'
                : 'border-border bg-surface text-ink-2 hover:bg-surface-hover hover:text-ink',
            )}
          >
            {lbl}
          </button>
        ))}
      </div>
      {targetType === 'categories' && (
        <ChecklistDropdown label="Categories" options={categoryOptions} selected={targetValues} onToggle={toggleValue} onClear={() => onTargetValuesChange(new Set())} />
      )}
      {targetType === 'tags' && (
        <ChecklistDropdown label="Tags" options={tagOptions} selected={targetValues} onToggle={toggleValue} onClear={() => onTargetValuesChange(new Set())} />
      )}
      {targetType === 'rules' && (
        <ChecklistDropdown label="Rules" options={ruleOptions} selected={targetValues} onToggle={toggleValue} onClear={() => onTargetValuesChange(new Set())} />
      )}
      {hasSelection && (
        <p className={cn('mt-2 text-xs', nothingWillRun ? 'text-status-warn' : 'text-ink-muted')}>
          {nothingWillRun
            ? 'No enabled rules match this target. Nothing will run.'
            : `${resolved.ruleCount} rule${resolved.ruleCount === 1 ? '' : 's'} will run`}
        </p>
      )}
    </div>
  );
}
