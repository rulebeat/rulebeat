'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from './theme-provider';
import type { ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Three-way ground control. `System` follows the operating system and is the default.
 *
 *  A segmented control rather than a two-state switch because "follow my machine" is a
 *  real third answer, and hiding it behind a long-press on a sun icon is the kind of thing
 *  people never find. */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={cn('inline-flex border border-rule-strong', className)}
    >
      {OPTIONS.map(({ value, label, icon: Icon }, index) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setPreference(value)}
            className={cn(
              'inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium transition-colors',
              index > 0 && 'border-l border-rule-strong',
              selected
                ? 'bg-ink text-surface'
                : 'bg-surface text-ink-2 hover:bg-surface-hover hover:text-ink',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
