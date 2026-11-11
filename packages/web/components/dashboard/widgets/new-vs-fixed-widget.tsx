'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { CHART_LEGEND_STYLE, CHART_TICK } from '@/components/dashboard/dashboard-constants';
import { periodToDays, TREND_CAP_DAYS } from '@/lib/widget-settings';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { useWidgetUrl } from '@/components/dashboard/widget-request';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';
import { WidgetNothingToCount } from '@/components/dashboard/widgets/widget-no-count';

interface Config { category?: string; period?: string; policyIds?: string[] }
interface Props { config: Config; refreshKey: number }

/** Remediation velocity: findings created (incl. reactivated) vs. resolved per day, from
 *  finding_events: a platform team closing more than it opens is the story this chart tells.
 *  Works under every filter dimension (see getFindingEventCounts). */
export function NewVsFixedWidget({ config, refreshKey }: Props) {
  const trendDays = periodToDays(config.period ?? '30d', TREND_CAP_DAYS['new-vs-fixed']!);
  const url = useWidgetUrl('summary', { trendDays });
  const { data: summary, loading, failed, noCount, retry } = useWidgetFetch<WidgetSummary>(
    url,
    [refreshKey]
  );

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;
  if (noCount) return <WidgetNothingToCount reason={noCount} />;

  const data = summary?.newVsFixedTrend ?? [];
  if (!data.length) {
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
