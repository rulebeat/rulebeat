'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { CHART_TICK } from '@/components/dashboard/dashboard-constants';
import { periodToDays, TREND_CAP_DAYS } from '@/lib/widget-settings';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { useWidgetUrl } from '@/components/dashboard/widget-request';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';
import { WidgetNothingToCount } from '@/components/dashboard/widgets/widget-no-count';

interface Config { category?: string; period?: string; policyIds?: string[] }
interface Props { config: Config; refreshKey: number }

/** Daily occurrence count for kind:'activity' findings (spec 034): rules like sign-in risk or
 *  Graph audit patterns that describe recurring behaviour rather than a resource's fixable state,
 *  so there is no pass/fail posture to show, only how often the pattern keeps occurring. Backed by
 *  getActivityOccurrenceCounts() via the shared /api/widgets/summary endpoint. */
export function ActivityOccurrencesWidget({ config, refreshKey }: Props) {
  const trendDays = periodToDays(config.period ?? '30d', TREND_CAP_DAYS['activity-occurrences']!);
  const url = useWidgetUrl('summary', { trendDays });
  const { data: summary, loading, failed, noCount, retry } = useWidgetFetch<WidgetSummary>(
    url,
    [refreshKey]
  );

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;
  if (noCount) return <WidgetNothingToCount reason={noCount} />;

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
          {/* One measurement, one colour, same token top-rules gives its single bar series. */}
          <Bar dataKey="count" name="Occurrences" fill="var(--color-fill)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
