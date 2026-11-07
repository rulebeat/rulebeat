'use client';

import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { CHART_LEGEND_STYLE, CHART_PLOT_HEIGHT, CHART_TICK, periodToDays } from '@/components/dashboard/dashboard-constants';
import { ChartDataTable } from '@/components/dashboard/chart-data-table';
import { GapTicks } from '@/components/dashboard/gap-ticks';
import { GAP_REASON_TEXT, countRows, type CountRow } from '@/lib/chart-gaps';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { category?: string; period?: string; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

type DayRow = CountRow<'created' | 'resolved'>;

/** What one day says in the tooltip and the data table: its counts, or why it has none. A recorded
 *  day with nothing in it reads "0 new, 0 fixed", which is different from a day nobody recorded. */
export function describeDay(row: DayRow): string {
  return row.gap ? GAP_REASON_TEXT[row.gap] : `${row.created} new, ${row.resolved} fixed`;
}

export function NewVsFixedTooltip({ active, label, rows }: { active?: boolean; label?: string | number; rows: readonly DayRow[] }) {
  const row = active ? rows.find(r => r.date === label) : undefined;
  if (!row) return null;
  return (
    <div className="space-y-1 border border-rule-strong bg-surface px-3 py-2 text-xs shadow-overlay">
      <p className="font-medium text-ink">{row.date}</p>
      <p className="text-ink-2">{describeDay(row)}</p>
    </div>
  );
}

/** Remediation velocity: findings created (incl. reactivated) vs. resolved per day, from
 *  finding_events: a platform team closing more than it opens is the story this chart tells.
 *  Works under every filter dimension (see getFindingEventCounts). */
export function NewVsFixedWidget({ config, filters, refreshKey }: Props) {
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const trendDays = periodToDays(config.period ?? '30d', 180); // finding_events retention is 180 days. Anything longer is empty air
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

  const counts = summary?.newVsFixedTrend ?? [];
  if (!counts.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No remediation activity yet in this period.</div>;
  }
  const rows = countRows(counts, ['created', 'resolved'], summary?.recordedDays ?? null);
  const gapDates = rows.filter(r => r.gap).map(r => r.date);

  return (
    <div className="px-2 py-3">
      <ResponsiveContainer width="100%" height={CHART_PLOT_HEIGHT}>
        <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
          <XAxis dataKey="date" tick={CHART_TICK} tickLine={false} axisLine={false} tickMargin={gapDates.length ? 8 : undefined} />
          <YAxis tick={CHART_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip filterNull={false} content={<NewVsFixedTooltip rows={rows} />} />
          <Legend wrapperStyle={CHART_LEGEND_STYLE} />
          {/* New on the first chart colour and Fixed on the second: neither is a verdict, so
              neither is red or green. Square bars: a rounded cap is not a Grid detail. */}
          <Bar dataKey="created" name="New" fill="var(--color-chart-1)" />
          <Bar dataKey="resolved" name="Fixed" fill="var(--color-chart-2)" />
          <GapTicks dates={gapDates} />
        </BarChart>
      </ResponsiveContainer>
      <ChartDataTable
        caption="New and fixed findings per day"
        columns={['New and fixed']}
        rows={rows.map(r => ({ label: r.date, cells: [describeDay(r)] }))}
      />
    </div>
  );
}
