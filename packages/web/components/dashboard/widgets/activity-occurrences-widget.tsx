'use client';

import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { CHART_TICK, periodToDays } from '@/components/dashboard/dashboard-constants';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { category?: string; period?: string; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

/** Daily occurrence count for kind:'activity' findings (spec 034) — rules like sign-in risk or
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

  const data = summary?.activityTrend ?? [];
  if (!data.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No activity occurrences in this period.</div>;
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
              const count = payload[0].value as number;
              return (
                <div className="space-y-1 border border-rule-strong bg-surface px-3 py-2 text-xs shadow-overlay">
                  <p className="font-medium text-ink">{label}</p>
                  <p className="text-ink">{count} occurrence{count !== 1 ? 's' : ''}</p>
                </div>
              );
            }}
          />
          {/* One measurement, one colour — same token top-rules gives its single bar series. */}
          <Bar dataKey="count" name="Occurrences" fill="var(--color-fill)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
