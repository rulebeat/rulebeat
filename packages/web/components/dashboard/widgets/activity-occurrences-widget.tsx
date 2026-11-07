'use client';

import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { CHART_PLOT_HEIGHT, CHART_TICK, periodToDays } from '@/components/dashboard/dashboard-constants';
import { ChartDataTable } from '@/components/dashboard/chart-data-table';
import { GapTicks } from '@/components/dashboard/gap-ticks';
import { GAP_REASON_TEXT, countRows, type CountRow } from '@/lib/chart-gaps';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { category?: string; period?: string; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

type DayRow = CountRow<'count'>;

/** One day's occurrences in words, or why there is no number. */
export function describeOccurrences(row: DayRow): string {
  if (row.gap) return GAP_REASON_TEXT[row.gap];
  return `${row.count} occurrence${row.count !== 1 ? 's' : ''}`;
}

export function OccurrencesTooltip({ active, label, rows }: { active?: boolean; label?: string | number; rows: readonly DayRow[] }) {
  const row = active ? rows.find(r => r.date === label) : undefined;
  if (!row) return null;
  return (
    <div className="space-y-1 border border-rule-strong bg-surface px-3 py-2 text-xs shadow-overlay">
      <p className="font-medium text-ink">{row.date}</p>
      <p className="text-ink">{describeOccurrences(row)}</p>
    </div>
  );
}

/** Daily occurrence count for kind:'activity' findings (spec 034): rules like sign-in risk or
 *  Graph audit patterns that describe recurring behaviour rather than a resource's fixable state,
 *  so there is no pass/fail posture to show, only how often the pattern keeps occurring. Backed by
 *  getActivityOccurrenceCounts() via the shared /api/widgets/summary endpoint. */
export function ActivityOccurrencesWidget({ config, filters, refreshKey }: Props) {
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const trendDays = periodToDays(config.period ?? '30d', 180); // finding_events retention is 180 days
  const params = useMemo(() => {
    const p = buildSummaryParams(merged);
    p.set('trendDays', String(trendDays));
    return p.toString();
  }, [merged, trendDays]);
  const { data: summary, loading, failed, retry } = useWidgetFetch<WidgetSummary>(
    `/api/widgets/summary?${params}`,
    [refreshKey]
  );

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;

  const counts = summary?.activityTrend ?? [];
  if (!counts.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No activity occurrences in this period.</div>;
  }
  const rows = countRows(counts, ['count'], summary?.recordedDays ?? null);
  const gapDates = rows.filter(r => r.gap).map(r => r.date);

  return (
    <div className="px-2 py-3">
      <ResponsiveContainer width="100%" height={CHART_PLOT_HEIGHT}>
        <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
          <XAxis dataKey="date" tick={CHART_TICK} tickLine={false} axisLine={false} tickMargin={gapDates.length ? 8 : undefined} />
          <YAxis tick={CHART_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip filterNull={false} content={<OccurrencesTooltip rows={rows} />} />
          {/* One measurement, one colour, same token top-rules gives its single bar series. */}
          <Bar dataKey="count" name="Occurrences" fill="var(--color-fill)" />
          <GapTicks dates={gapDates} />
        </BarChart>
      </ResponsiveContainer>
      <ChartDataTable
        caption="Activity occurrences per day"
        columns={['Occurrences']}
        rows={rows.map(r => ({ label: r.date, cells: [describeOccurrences(r)] }))}
      />
    </div>
  );
}
