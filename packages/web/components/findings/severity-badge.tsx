import type { Severity } from '@/lib/types';
import { cn } from '@/lib/utils';

/* Severity is one ordered ramp that cools as it descends, plus weight.
 *
 * The first version gave each level its own hue: red, orange, amber, blue, slate.
 * Five hues of equal saturation sitting next to each other read as five categories
 * rather than one ordered scale, so nothing stood out and the table looked like a
 * bag of sweets.
 *
 * The second version overcorrected into red-then-greyscale, on the theory that the
 * order could be carried by weight alone. That failed in use for two reasons. High
 * was pure black, which made it the heaviest mark on a screen that is supposed to
 * lead with the red one. And Medium and Low were two greys, which is not an order
 * anybody can read at a glance.
 *
 * What is here now runs red, burnt orange, ochre, grey: temperature carries the
 * order, weight reinforces it, and the hue never leaves the hot-to-neutral axis, so
 * it stays one scale rather than a set of labels. Anyone who cannot separate red
 * from orange still gets the order from the weight, which is why the font weight
 * steps down alongside the colour rather than being decorative.
 *
 * The swatch is a filled square rather than a dot: it holds its weight at 8px,
 * and hard corners are the house style. Info stays hollow on purpose — filled
 * versus outline is the one bit that survives with no colour at all.
 */
const config: Record<Severity, { label: string; swatch: string; text: string }> = {
  critical: { label: 'Critical', swatch: 'bg-sev-critical', text: 'text-sev-critical font-semibold' },
  high: { label: 'High', swatch: 'bg-sev-high', text: 'text-sev-high font-semibold' },
  medium: { label: 'Medium', swatch: 'bg-sev-medium', text: 'text-sev-medium font-medium' },
  low: { label: 'Low', swatch: 'bg-sev-low', text: 'text-sev-low' },
  info: { label: 'Info', swatch: 'bg-transparent border border-ink-faint', text: 'text-ink-faint' },
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const { label, swatch, text } = config[severity];
  return (
    <span
      className={cn('inline-flex w-fit items-center gap-2 text-xs whitespace-nowrap', text, className)}
    >
      <span className={cn('h-2 w-2 shrink-0', swatch)} aria-hidden="true" />
      {label}
    </span>
  );
}

/** The same scale as a filter chip. Unselected chips stay quiet so the row of
 *  them does not compete with the table underneath; the selected one inverts. */
export function SeverityChip({
  severity,
  active,
  onClick,
}: {
  severity: Severity;
  active: boolean;
  onClick: () => void;
}) {
  const { label, swatch } = config[severity];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 items-center gap-2 px-2.5 text-xs transition-colors',
        active
          ? 'bg-ink text-background'
          : 'bg-surface-sunken text-ink-2 hover:bg-surface-sunken-hover hover:text-ink',
      )}
    >
      <span
        className={cn('h-2 w-2 shrink-0', active ? 'bg-surface' : swatch)}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}
