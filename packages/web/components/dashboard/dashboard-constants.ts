import type { Severity } from '@/lib/types';

/* Fallback identity colours for the categories that ship with a fresh install.
 * A category is user-extensible and carries its own colour in the database, so
 * these only fill in for a category the summary has no row for yet. They are
 * used for the small identifying swatch next to a category name, never as a
 * chart fill: a swatch is a label, and a chart fill is a measurement. */
export const CATEGORY_COLORS: Record<string, string> = {
  compliance:  '#6366f1',
  cost:        '#f59e0b',
  security:    '#10b981',
  identity:    '#8b5cf6',
  reliability: '#06b6d4',
  networking:  '#f97316',
  operations:  '#64748b',
  all:         '#6366f1',
};

export const CATEGORY_LABELS: Record<string, string> = {
  compliance:  'Compliance',
  cost:        'Cost',
  security:    'Security',
  identity:    'Identity',
  reliability: 'Reliability',
  networking:  'Networking',
  operations:  'Operations',
  all:         'All Categories',
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

/* Severity as a chart value. Anything that draws severity as text or a swatch
 * should render <SeverityBadge> instead of reaching for a colour, so this map
 * exists only for SVG fills, which cannot take a class. The values are the same
 * tokens the badge uses, so a pie slice and a table row agree, and both follow
 * the theme. Info has no severity token: it is the absence of a severity, so it
 * takes the faintest ink. */
export const SEVERITY_CHART_COLOR: Record<Severity, string> = {
  critical: 'var(--color-sev-critical)',
  high: 'var(--color-sev-high)',
  medium: 'var(--color-sev-medium)',
  low: 'var(--color-sev-low)',
  info: 'var(--color-ink-faint)',
};

export const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/* Line colours for a chart with more than one series. Cycled by position rather
 * than keyed by category, because a legend already names each line and the
 * category's own colour is not guaranteed to be legible on both grounds. */
const CHART_SERIES = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
];

export function chartSeriesColor(index: number): string {
  return CHART_SERIES[index % CHART_SERIES.length];
}

/* Recharts draws axis ticks and legend labels in its own fixed grey, which does not follow
 * the theme: on the dark ground those labels sit almost invisible against it. Every chart
 * takes its tick and legend styling from here, so a widget added later inherits the fix
 * instead of repeating the literal. */
export const CHART_TICK = { fontSize: 12, fill: 'var(--color-ink-muted)' };
export const CHART_LEGEND_STYLE = { fontSize: 12, color: 'var(--color-ink-2)' };

export function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Posture % → the colour its ring or bar is drawn in, shared by every widget
 *  that shows a pass rate so the same number never appears in two colours.
 *
 *  A healthy score is not green. Green would put a permanent block of colour on
 *  the busiest screen in the product, and a screen already full of colour is one
 *  where a real problem no longer stands out. A good score takes the neutral bar
 *  fill; the warning and alarm colours arrive only once the number is worth
 *  acting on, and neither of them appears anywhere else on a healthy dashboard. */
export function postureColor(pct: number | null): string {
  if (pct === null) return 'var(--color-ink-faint)';
  if (pct >= 80) return 'var(--color-fill)';
  if (pct >= 60) return 'var(--color-status-warn)';
  return 'var(--color-sev-critical)';
}

/** Widget "period" config values → day counts. `allDays` lets each caller pick what 'all' means
 *  for its own data source's retention window (e.g. posture_snapshots vs. finding_events). */
export function periodToDays(period: string, allDays: number): number {
  if (period === '7d') return 7;
  if (period === '90d') return 90;
  if (period === 'all') return allDays;
  return 30;
}

/** Trend chart tooltip label (spec 033): "passing/total" reads a posture trend correctly —
 *  a bare percentage doesn't say whether it moved because rules changed or resources did. Falls
 *  back to the bare percentage when a data point carries no passing/total (older snapshot rows,
 *  or the single-category chart shape, which stores them unprefixed on the row). */
export function formatTrendTooltipLabel(dataKey: string, value: number, payload: Record<string, unknown>): string {
  const passing = (payload[`${dataKey}__passing`] ?? payload.passing) as number | undefined;
  const total = (payload[`${dataKey}__total`] ?? payload.total) as number | undefined;
  return passing !== undefined && total !== undefined ? `${passing}/${total} passing (${value}%)` : `${value}%`;
}

export const REFRESH_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0,    label: 'Off' },
  { value: 30,   label: '30s' },
  { value: 60,   label: '1m' },
  { value: 300,  label: '5m' },
  { value: 900,  label: '15m' },
  { value: 1800, label: '30m' },
  { value: 3600, label: '1h' },
];
