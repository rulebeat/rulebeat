'use client';

import { cn } from '@/lib/utils';

/* On/off. Square, like everything else in Grid.
 *
 * "On" is a solid ink fill, not red. Rules, schedules and channels are switched
 * on all over the app, and if that were the accent colour the page would be
 * covered in red for reasons that have nothing to do with anything being wrong.
 * Red stays reserved for critical. */

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function Switch({ checked, onCheckedChange, disabled, title, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onCheckedChange(!checked); }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center border transition-colors duration-200',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        /* Only lightly faded when disabled. A switch is read far more often than it is
           pressed, and in read-only mode (a viewer, the demo) every switch on the page is
           disabled — fading a solid black track to 50% turned "on" into a grey pill that
           was hard to tell from "off". Someone who cannot press it still has to be able to
           tell what it says. */
        'disabled:cursor-not-allowed disabled:opacity-75',
        checked ? 'border-ink bg-ink' : 'border-rule-strong bg-surface',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none block size-3.5 transition-[transform,background-color] duration-200',
          checked ? 'translate-x-[18px] bg-background' : 'translate-x-0.5 bg-ink-faint',
        )}
      />
    </button>
  );
}
