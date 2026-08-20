import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

/** Shared Up/Down/flat trend indicator — used by stat-card and posture-ring widgets, which
 *  each render a numeric delta with the same icon/color-by-sign logic but slightly different
 *  wrapping text and sizing. */
export function Delta({ value, suffix = '%', title, neutralLabel, size = 'sm', display = 'flex' }: {
  value: number | null;
  suffix?: string;
  title?: string;
  /** Text shown when value === 0 (e.g. 'flat'); when unset, renders the numeric value like the non-zero cases. */
  neutralLabel?: string;
  size?: 'sm' | 'xs';
  display?: 'flex' | 'inline-flex';
}) {
  if (value === null) return null;
  const positive = value > 0;
  const negative = value < 0;
  const Icon = positive ? TrendingUp : negative ? TrendingDown : Minus;
  // A trend is an outcome, not a severity, so it uses the status tokens. Those are deliberately
  // deep and desaturated: a rise in posture should read as good without shouting over a
  // genuine critical finding elsewhere on the same screen.
  const color = positive ? 'text-status-ok' : negative ? 'text-sev-critical' : 'text-ink-muted';
  const iconCls = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  const textCls = size === 'xs' ? 'text-xs' : 'text-sm';
  const useNeutralLabel = !positive && !negative && neutralLabel !== undefined;
  const weightCls = useNeutralLabel ? '' : 'font-medium';
  const text = useNeutralLabel ? neutralLabel : `${positive ? '+' : ''}${value}${suffix}`;

  return (
    <span title={title} className={`${display} items-center gap-1 ${color} ${textCls} ${weightCls}`}>
      <Icon className={iconCls} />
      {text}
    </span>
  );
}
