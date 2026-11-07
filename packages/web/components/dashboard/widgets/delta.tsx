import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';

/** Shared change indicator: used by stat-card and posture-ring widgets. A change reads in ink
 *  with a sign, an arrow and words ("+12% since 30 days ago"), so it carries its meaning without
 *  colour. It is never green or red: whether a rise is good depends on the number, and red
 *  belongs to problems. */
export function Delta({ value, suffix = '%', since, title, size = 'sm', display = 'flex' }: {
  value: number | null;
  suffix?: string;
  /** The comparison in words, e.g. 'since 30 days ago' (see `sinceLabel`). */
  since?: string;
  title?: string;
  size?: 'sm' | 'xs';
  display?: 'flex' | 'inline-flex';
}) {
  if (value === null) return null;
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : ArrowRight;
  const iconCls = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  const textCls = size === 'xs' ? 'text-xs' : 'text-sm';
  const text = value === 0
    ? `No change${since ? ` ${since}` : ''}`
    : `${value > 0 ? '+' : ''}${value}${suffix}${since ? ` ${since}` : ''}`;

  return (
    <span title={title} className={`${display} items-center gap-1 font-medium text-ink ${textCls}`}>
      <Icon className={iconCls} aria-hidden="true" />
      {text}
    </span>
  );
}
