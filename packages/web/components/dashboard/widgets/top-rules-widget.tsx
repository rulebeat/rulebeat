'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { CHART_TICK } from '@/components/dashboard/dashboard-constants';
import { SeverityBadge } from '@/components/findings/severity-badge';
import type { Severity } from '@/lib/types';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref } from '@/lib/scans-link';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface RuleViolation { ruleId: string; name: string; count: number; severity: string; category: string; color?: string; }
interface Config { category?: string; limit?: number; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number; }

export function TopRulesWidget({ config, filters, refreshKey }: Props) {
  const router = useRouter();
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const params = useMemo(() => {
    const p = buildSummaryParams(merged);
    p.set('limit', String(config.limit ?? 10));
    return p.toString();
  }, [merged, config.limit]);
  const { data, loading, failed, retry } = useWidgetFetch<RuleViolation[]>(
    `/api/widgets/top-rules?${params}`,
    [refreshKey]
  );
  const items = data ?? [];

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;
  }
  if (failed) {
    return <WidgetUnavailable onRetry={retry} />;
  }
  if (!items.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No violations found</div>;
  }

  const chartData = items.map(d => ({
    name: d.name.length > 28 ? d.name.slice(0, 28) + '…' : d.name,
    fullName: d.name,
    ruleId: d.ruleId,
    count: d.count,
    severity: d.severity,
  }));

  return (
    <div className="h-full px-2 py-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ top: 2, right: 24, bottom: 2, left: 4 }}>
          <XAxis type="number" tick={CHART_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="name" width={160} tick={CHART_TICK} tickLine={false} axisLine={false} />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as typeof chartData[0];
              return (
                <div className="space-y-1 border border-rule-strong bg-surface px-3 py-2 text-xs shadow-overlay">
                  <p className="max-w-48 break-words font-medium text-ink">{d.fullName}</p>
                  <p className="text-ink">{d.count} violation{d.count !== 1 ? 's' : ''}</p>
                  {d.severity && <SeverityBadge severity={d.severity as Severity} />}
                </div>
              );
            }}
          />
          {/* One measurement, one colour. Giving each bar its category's hue turned a
              ranking into a rainbow, where length already carries the whole message. */}
          <Bar dataKey="count" minPointSize={3}>
            {chartData.map((entry, i) => (
              <Cell
                key={i}
                fill="var(--color-fill)"
                cursor="pointer"
                onClick={() => router.push(buildScansHref(merged, { ruleId: entry.ruleId }))}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
