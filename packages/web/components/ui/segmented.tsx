'use client';

import { cn } from '@/lib/utils';

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
}

/** Choices that sit flush as one bar, so they read as a single control. Each option is a toggle
 *  button: `isOn` says which are pressed (one for a pick-one control, several for a filter) and
 *  `onSelect` reports the one clicked. Selected is an ink fill, not an alert colour. `label` names
 *  the group for assistive tech. */
export function Segmented<V extends string>({ label, options, isOn, onSelect, className, optionClassName }: {
  label?: string;
  options: readonly SegmentedOption<V>[];
  isOn: (value: V) => boolean;
  onSelect: (value: V) => void;
  className?: string;
  optionClassName?: string;
}) {
  return (
    <div role={label ? 'group' : undefined} aria-label={label} className={cn('flex items-center border border-rule-strong', className)}>
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={isOn(option.value)}
          onClick={() => onSelect(option.value)}
          className={cn(
            'h-9 px-3 text-xs font-medium transition-colors outline-none',
            'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
            i > 0 && 'border-l border-rule-strong',
            isOn(option.value) ? 'bg-ink text-surface' : 'bg-surface text-ink-2 hover:bg-surface-hover hover:text-ink',
            optionClassName,
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
