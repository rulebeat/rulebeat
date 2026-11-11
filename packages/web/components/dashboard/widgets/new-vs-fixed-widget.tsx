'use client';

import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { CHART_LEGEND_STYLE, CHART_TICK } from '@/components/dashboard/dashboard-constants';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { category?: string; period?: string; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

/** Remediation velocity: findings new vs. fixed per UTC day of the date window, counted from the live
 *  findings with the Scans predicates (a reactivated finding is not new): a platform team closing more
 *  than it opens is the story this chart tells. Works under every filter dimension. */
export function NewVsFixedWidget({ config, filters, refreshKey }: Props) {
  // The date window draws the chart. A saved period is this widget's own window; 'all' is the 180 days finding_events keeps.
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>, { periodAllDays: 180 }), [filters, config]);
  const params = useMemo(() => buildSummaryParams(merged).toString(), [merged]);
  const { data: summary, loading, failed, retry } = useWidgetFetch<WidgetSummary>(
    `/api/widgets/summary?${params}`,
    [refreshKey]
  );

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;

  const data = summary?.newVsFixedTrend ?? [];
  // The bars are zero-filled across the window, so a window with nothing in it is all zeros.
  if (!data.some(d => d.created > 0 || d.resolved > 0)) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No remediation activity yet in this period.</div>;
  }

  return (
    <div className="h-full px-2 py-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" />
          <XAxis dataKey="date" tick={CHART_TICK} tickLine={false} axisLine={false} />
          <YAxis tick={CHART_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <div className="space-y-1 border border-rule-strong bg-surface px-3 py-2 text-xs shadow-overlay">
                  <p className="font-medium text-ink">{label}</p>
                  {payload.map(p => (
                    <p key={p.name} style={{ color: p.color }}>{p.name}: {p.value}</p>
                  ))}
                </div>
              );
            }}
          />
          <Legend wrapperStyle={CHART_LEGEND_STYLE} />
          {/* The same two colours the Scans table gives new and fixed counts, so the
              same pair of numbers never appears in two different colours. Square bars:
              a rounded cap is not a Grid detail. */}
          <Bar dataKey="created" name="New" fill="var(--color-sev-critical)" />
          <Bar dataKey="resolved" name="Fixed" fill="var(--color-status-ok)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
