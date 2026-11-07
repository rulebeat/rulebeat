'use client';

import { useMemo } from 'react';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { CATEGORY_COLORS, CATEGORY_LABELS, CHART_LEGEND_STYLE, CHART_PLOT_HEIGHT, CHART_TICK, chartSeriesColor, formatTrendTooltipLabel, periodToDays } from '@/components/dashboard/dashboard-constants';
import { ChartDataTable } from '@/components/dashboard/chart-data-table';
import { GapTicks } from '@/components/dashboard/gap-ticks';
import { GAP_REASON_TEXT, trendDays as spanTrendDays, trendRows, type GapReason, type TrendRow } from '@/lib/chart-gaps';
import { todayKey } from '@/lib/date-window';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';
import { trendUnavailableMessage } from '@/lib/trend-scope';

interface Config { category?: string; period?: string; chartType?: string; showFindings?: boolean; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

interface Series { key: string; name: string; color: string; legendColor: string }

const Y_AXIS_LABEL = {
  value: 'Posture %',
  angle: -90,
  position: 'insideLeft' as const,
  style: { fill: 'var(--color-ink-muted)', fontSize: 12 },
};

/** One series on one day, in words: its value with the counts behind it, or why there is none. */
export function describeTrendPoint(row: TrendRow, key: string): string {
  const value = row[key] as number | null;
  if (value === null) return GAP_REASON_TEXT[row[`${key}__gap`] as GapReason];
  return formatTrendTooltipLabel(key, value, row);
}

export function TrendTooltip({ active, label, rows, series }: {
  active?: boolean;
  label?: string | number;
  rows: readonly TrendRow[];
  series: readonly Series[];
}) {
  const row = active ? rows.find(r => r.date === label) : undefined;
  if (!row) return null;
  return (
    <div className="space-y-1 border border-rule-strong bg-surface px-3 py-2 text-xs shadow-overlay">
      <p className="font-medium text-ink">{row.date}</p>
      {series.map(s => (
        <p key={s.key} className="font-medium" style={{ color: s.legendColor }}>
          {s.name}: {describeTrendPoint(row, s.key)}
        </p>
      ))}
    </div>
  );
}

/** A line cannot join a point to nothing, so a day recorded between two gaps is drawn as a dot. */
function loneDot(key: string, color: string) {
  return function LoneDot(props: { cx?: number; cy?: number; index?: number; payload?: Record<string, unknown> }) {
    const k = `${key}-${props.index}`;
    return props.payload?.[`${key}__lone`] && props.cx !== undefined && props.cy !== undefined
      ? <circle key={k} cx={props.cx} cy={props.cy} r={3.5} fill={color} />
      : <g key={k} />;
  };
}

function CustomLegend({ series }: { series: Series[] }) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-1" style={CHART_LEGEND_STYLE}>
      {series.map(s => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.legendColor }} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

export function TrendWidget({ config, filters, refreshKey }: Props) {
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const trendDays = periodToDays(config.period ?? '30d', 365);
  const params = useMemo(() => {
    const p = buildSummaryParams(merged);
    p.set('trendDays', String(trendDays));
    return p.toString();
  }, [merged, trendDays]);
  const { data: summary, loading, failed, retry } = useWidgetFetch<WidgetSummary>(
    `/api/widgets/summary?${params}`,
    [refreshKey]
  );

  const { chartData, series } = useMemo(() => {
    const empty = { chartData: [] as TrendRow[], series: [] as Series[] };
    if (!summary) return empty;
    // RG/tag/severity/rule filters, or 2+ subscriptions, have no history in posture_snapshots
    // (see dashboard-data.ts): chartData stays empty but this is NOT "no data yet", so the
    // render below must tell those two cases apart instead of showing one generic message.
    if (summary.trendIsCategoryScopedOnly) return empty;

    // `summary.perCategory` carries each category's live DB label/color: prefer it, falling back
    // to the hardcoded constants only when a category isn't present there (e.g. no scan data yet).
    const catInfo = new Map(summary.perCategory.map(m => [m.category, m]));
    const labelFor = (id: string) => catInfo.get(id)?.label ?? CATEGORY_LABELS[id] ?? id;
    // Series colour comes from position, not from the category's own colour: the legend
    // names each line, and a user-picked hue is not guaranteed to read on both grounds.
    const colorFor = (_id: string, index: number) => chartSeriesColor(index);
    // The legend swatch and tooltip text, unlike the drawn line itself, show the category's real
    // identity colour (the same one every other widget uses for this category) so a user can
    // match "this colour = this category" consistently even though the line uses a
    // guaranteed-legible position colour instead.
    const legendColorFor = (id: string, fallback: string) => catInfo.get(id)?.color ?? CATEGORY_COLORS[id] ?? fallback;

    // Every day of the span is a row, so a day with no record is a gap in the line rather than
    // two neighbours joined across it.
    const categories = merged.categories ?? [];
    const byCategory = summary.trendByCategory ?? {};
    const single = categories.length === 1;
    const points = single ? { pct: summary.trend } : byCategory;
    const recorded = Object.values(points).flatMap(list => list.map(p => p.date));
    const days = spanTrendDays(recorded, trendDays, todayKey());

    if (single) {
      const cat = categories[0];
      const color = colorFor(cat, 0);
      return {
        chartData: trendRows(days, points),
        series: [{ key: 'pct', name: `${labelFor(cat)} %`, color, legendColor: legendColorFor(cat, color) }],
      };
    }

    // Multiple (or all) categories: one line per category. Each category also carries its own
    // passing/total alongside its pct, prefixed since every category shares one row per date.
    const usedCategoryIds = Object.keys(byCategory).filter(id => byCategory[id].length > 0);
    return {
      chartData: trendRows(days, byCategory),
      series: usedCategoryIds.map((id, i) => {
        const color = colorFor(id, i);
        return { key: id, name: labelFor(id), color, legendColor: legendColorFor(id, color) };
      }),
    };
  }, [summary, merged.categories, trendDays]);

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;

  if (summary?.trendIsCategoryScopedOnly) {
    return <div className="flex h-full items-center justify-center px-4 text-center text-sm text-ink-muted">Not available with a resource group/tag/severity/rule filter, or more than one subscription selected. Trend is tracked by category (and optionally a single subscription) only.</div>;
  }
  if (summary?.trendUnavailable) {
    const { title, detail } = trendUnavailableMessage(summary.trendUnavailable);
    return (
      <div role="status" className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="max-w-xs text-xs text-ink-2">{detail}</p>
      </div>
    );
  }
  if (!chartData.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No trend data yet. Run scans to build history.</div>;
  }

  /* An area fill reads as "how much is under the curve", which is only true of one series.
   * Five categories' pass rates are independent lines that happen to share an axis, so five
   * translucent fills laid over each other filled the whole panel with grey and no line could
   * be followed. More than one series is drawn as lines unless a bar chart was asked for. */
  const chartType = config.chartType === 'bar' ? 'bar'
    : config.chartType === 'line' || series.length > 1 ? 'line'
    : 'area';

  const showSubscriptionDenominatorCaveat = merged.subscriptions?.length === 1;
  const gapDates = chartData.filter(r => series.every(s => r[s.key] === null)).map(r => r.date as string);
  const margin = { top: 4, right: 8, bottom: 0, left: 4 };
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
      <XAxis dataKey="date" tick={CHART_TICK} tickLine={false} axisLine={false} tickMargin={chartType === 'bar' && gapDates.length ? 8 : undefined} />
      <YAxis domain={[0, 100]} tick={CHART_TICK} tickLine={false} axisLine={false} unit="%" label={Y_AXIS_LABEL} />
      <Tooltip filterNull={false} content={<TrendTooltip rows={chartData} series={series} />} />
      {series.length > 1 && <Legend content={<CustomLegend series={series} />} />}
    </>
  );

  return (
    <div className="px-2 py-3">
      {showSubscriptionDenominatorCaveat && (
        <p
          className="px-2 pb-1 text-xs text-ink-muted"
          title="This subscription's total reflects every rule enabled for the category. It isn't narrowed to this subscription's own resources."
        >
          Total is per category, not per subscription
        </p>
      )}
      <ResponsiveContainer width="100%" height={CHART_PLOT_HEIGHT}>
        {chartType === 'bar' ? (
          <BarChart data={chartData} margin={margin}>
            {axes}
            {series.map(s => <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} />)}
            <GapTicks dates={gapDates} />
          </BarChart>
        ) : chartType === 'line' ? (
          <LineChart data={chartData} margin={margin}>
            {axes}
            {series.map(s => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} connectNulls={false} dot={loneDot(s.key, s.color)} activeDot={{ r: 4 }} />
            ))}
          </LineChart>
        ) : (
          <AreaChart data={chartData} margin={margin}>
            <defs>
              {series.map(s => (
                <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={s.color} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            {axes}
            {series.map(s => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={1.5} fill={`url(#g-${s.key})`} connectNulls={false} dot={loneDot(s.key, s.color)} activeDot={{ r: 4 }} />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
      <ChartDataTable
        caption="Posture trend by day"
        columns={series.map(s => s.name)}
        rows={chartData.map(r => ({ label: r.date as string, cells: series.map(s => describeTrendPoint(r, s.key)) }))}
      />
    </div>
  );
}
