import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StepperStep {
  id: number;
  label: string;
}

/** Presentational only — no state of its own.
 *  Progress reads as weight rather than colour: a done step is filled solid, the
 *  current one is outlined, and the ones still ahead sit faint. Nothing here is a
 *  severity, so nothing here takes a hue. */
export function Stepper({ steps, current }: { steps: StepperStep[]; current: number }) {
  return (
    <ol className="flex items-center">
      {steps.map((s, i) => (
        <li key={s.id} className="flex items-center">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'numeral-grid flex size-7 shrink-0 items-center justify-center text-xs font-semibold',
                s.id < current && 'bg-ink text-surface',
                s.id === current && 'border border-ink text-ink',
                s.id > current && 'border border-border text-ink-faint',
              )}
            >
              {s.id < current ? <Check className="size-3.5" /> : s.id}
            </span>
            <span
              className={cn(
                'whitespace-nowrap text-sm',
                s.id === current ? 'font-medium text-ink' : 'text-ink-2',
              )}
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && <span className="mx-3 h-px w-8 shrink-0 bg-border" />}
        </li>
      ))}
    </ol>
  );
}
