'use client';

import { useMemo } from 'react';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { CATEGORY_COLORS, CATEGORY_LABELS, CHART_LEGEND_STYLE, CHART_TICK, TREND_MARKER_STROKE, chartSeriesColor, formatTrendTooltipLabel } from '@/components/dashboard/dashboard-constants';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';
import { trendUnavailableMessage } from '@/lib/trend-scope';
import { TREND_EMPTY_STATE, TREND_FILTER_TITLE, TREND_KEPT_DAYS, WIDGET_LIMITS } from '@/lib/widget-limits';
import { useReportWidgetNotes } from '@/lib/hooks/use-widget-notes';
import { trendMarkerDates } from '@/lib/trend-points';

interface Config { category?: string; period?: string; chartType?: string; showFindings?: boolean; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

interface Series { key: string; name: string; color: string; legendColor: string }

const Y_AXIS_LABEL = {
  value: 'Posture %',
  angle: -90,
  position: 'insideLeft' as const,
  style: { fill: 'var(--color-ink-muted)', fontSize: 12 },
};

function CustomTooltip({ active, payload, legendColors }: {
  active?: boolean;
  payload?: Array<{ dataKey: string; name: string; value: number; payload: Record<string, unknown> }>;
  legendColors: Record<string, string>;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="space-y-1 border border-rule-strong bg-surface px-3 py-2 text-xs shadow-overlay">
      {payload.map((p) => {
        const color = legendColors[p.dataKey] ?? 'var(--color-ink)';
        return (
          <p key={p.dataKey} className="font-medium" style={{ color }}>
            {p.name}: {formatTrendTooltipLabel(p.dataKey, p.value, p.payload)}
          </p>
        );
      })}
    </div>
  );
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
  // The date window draws the chart. A saved period is this widget's own window; 'all' is the days of trend points kept.
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>, { periodAllDays: TREND_KEPT_DAYS }), [filters, config]);
  const params = useMemo(() => buildSummaryParams(merged).toString(), [merged]);
  const { data: summary, loading, failed, retry } = useWidgetFetch<WidgetSummary>(
    `/api/widgets/summary?${params}`,
    [refreshKey]
  );

  useReportWidgetNotes(
    !loading && !failed && summary
      ? [...(summary.trendNotes ?? []), ...(!summary.trendIsCategoryScopedOnly && !summary.trendUnavailable && summary.trendRetentionNote ? [summary.trendRetentionNote] : [])]
      : [],
  );

  const { chartData, series } = useMemo(() => {
    if (!summary) return { chartData: [] as Array<Record<string, unknown>>, series: [] as Series[] };
    // RG/tag/severity/rule filters, or 2+ subscriptions, have no history in posture_snapshots
    // (see dashboard-data.ts): chartData stays empty but this is NOT "no data yet", so the
    // render below must tell those two cases apart instead of showing one generic message.
    if (summary.trendIsCategoryScopedOnly) return { chartData: [] as Array<Record<string, unknown>>, series: [] as Series[] };

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

    const categories = merged.categories ?? [];
    if (categories.length === 1) {
      const cat = categories[0];
      const color = colorFor(cat, 0);
      return {
        chartData: summary.trend,
        series: [{ key: 'pct', name: `${labelFor(cat)} %`, color, legendColor: legendColorFor(cat, color) }],
      };
    }

    // Multiple (or all) categories: one line per category, merged by date. Each category also
    // carries its own passing/total alongside its pct, prefixed since every category shares one
    // row per date.
    const byCategory = summary.trendByCategory ?? {};
    const dateMap = new Map<string, Record<string, number>>();
    for (const [catId, points] of Object.entries(byCategory)) {
      for (const p of points) {
        const entry = dateMap.get(p.date) ?? {};
        dateMap.set(p.date, entry);
        if (p.pct === null) continue;
        entry[catId] = p.pct;
        entry[`${catId}__passing`] = p.passing;
        entry[`${catId}__total`] = p.total;
      }
    }
    const sorted = Array.from(dateMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const usedCategoryIds = Object.keys(byCategory).filter(id => byCategory[id].length > 0);
    return {
      chartData: sorted.map(([date, vals]) => ({ date, ...vals })),
      series: usedCategoryIds.map((id, i) => {
        const color = colorFor(id, i);
        return { key: id, name: labelFor(id), color, legendColor: legendColorFor(id, color) };
      }),
    };
  }, [summary, merged.categories]);

  // The days a line's counting changed, from the versions on the points themselves. Only a day the chart
  // has a point for can carry a line.
  const markers = useMemo(() => {
    if (!summary?.trendByCategory) return [];
    const drawn = new Set(chartData.map(d => d['date'] as string));
    return trendMarkerDates(summary.trendLevel ?? 'install', summary.trendByCategory).filter(d => drawn.has(d));
  }, [summary, chartData]);

  const legendColors = useMemo(
    () => Object.fromEntries(series.map(s => [s.key, s.legendColor])),
    [series]
  );

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;

  if (summary?.trendIsCategoryScopedOnly) {
    return <WidgetUnavailable reason={{ title: TREND_FILTER_TITLE, detail: WIDGET_LIMITS.w4 }} />;
  }
  if (summary?.trendUnavailable) {
    return <WidgetUnavailable reason={trendUnavailableMessage(summary.trendUnavailable)} />;
  }
  if (!chartData.length) {
    return <div className="flex h-full items-center justify-center px-4 text-center text-sm text-ink-muted">{TREND_EMPTY_STATE}</div>;
  }

  /* An area fill reads as "how much is under the curve", which is only true of one series.
   * Five categories' pass rates are independent lines that happen to share an axis, so five
   * translucent fills laid over each other filled the whole panel with grey and no line could
   * be followed. More than one series is drawn as lines unless a bar chart was asked for. */
  const chartType = config.chartType === 'bar' ? 'bar'
    : config.chartType === 'line' || series.length > 1 ? 'line'
    : 'area';

  const markerLines = markers.map(date => (
    <ReferenceLine key={`marker-${date}`} x={date} stroke={TREND_MARKER_STROKE} strokeDasharray="4 3" />
  ));

  return (
    <div className="flex h-full flex-col px-2 py-3">
      <ResponsiveContainer width="100%" height="100%" className="min-h-0 flex-1">
        {chartType === 'bar' ? (
          <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
            <XAxis dataKey="date" tick={CHART_TICK} tickLine={false} axisLine={false} />
            <YAxis domain={[0, 100]} tick={CHART_TICK} tickLine={false} axisLine={false} unit="%" label={Y_AXIS_LABEL} />
            <Tooltip content={<CustomTooltip legendColors={legendColors} />} />
            {series.length > 1 && <Legend content={<CustomLegend series={series} />} />}
            {markerLines}
            {series.map(s => <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} />)}
          </BarChart>
        ) : chartType === 'line' ? (
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
            <XAxis dataKey="date" tick={CHART_TICK} tickLine={false} axisLine={false} />
            <YAxis domain={[0, 100]} tick={CHART_TICK} tickLine={false} axisLine={false} unit="%" label={Y_AXIS_LABEL} />
            <Tooltip content={<CustomTooltip legendColors={legendColors} />} />
            {series.length > 1 && <Legend content={<CustomLegend series={series} />} />}
            {markerLines}
            {series.map(s => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            ))}
          </LineChart>
        ) : (
          <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
            <defs>
              {series.map(s => (
                <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={s.color} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
            <XAxis dataKey="date" tick={CHART_TICK} tickLine={false} axisLine={false} />
            <YAxis domain={[0, 100]} tick={CHART_TICK} tickLine={false} axisLine={false} unit="%" label={Y_AXIS_LABEL} />
            <Tooltip content={<CustomTooltip legendColors={legendColors} />} />
            {series.length > 1 && <Legend content={<CustomLegend series={series} />} />}
            {markerLines}
            {series.map(s => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={1.5} fill={`url(#g-${s.key})`} dot={false} activeDot={{ r: 4 }} />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
