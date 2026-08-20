'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref } from '@/lib/scans-link';
import { CHART_LEGEND_STYLE, SEVERITY_CHART_COLOR, SEVERITY_LABEL, SEV_ORDER } from '@/components/dashboard/dashboard-constants';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { category?: string; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

export function SeverityBreakdownWidget({ config, filters, refreshKey }: Props) {
  const router = useRouter();
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const params = buildSummaryParams(merged).toString();
  const { data: summary, loading, failed, retry } = useWidgetFetch<WidgetSummary>(
    `/api/widgets/summary?${params}`,
    [refreshKey]
  );

  const data = useMemo(() => {
    if (!summary) return [];
    return SEV_ORDER
      .map(s => ({ severity: s, name: SEVERITY_LABEL[s], value: summary.current.severityCounts[s] ?? 0, color: SEVERITY_CHART_COLOR[s] }))
      .filter(d => d.value > 0);
  }, [summary]);

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;

  if (!data.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No open findings</div>;
  }

  return (
    <div className="h-full px-2 py-2">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="55%"
            outerRadius="80%"
            paddingAngle={2}
            cursor="pointer"
            onClick={(entry) => {
              const severity = (entry as unknown as { severity?: string }).severity;
              if (severity) router.push(buildScansHref(merged, { severity }));
            }}
          >
            {data.map((d) => <Cell key={d.severity} fill={d.color} fillOpacity={0.9} />)}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as typeof data[0];
              return (
                <div className="border border-rule-strong bg-surface px-3 py-2 text-xs shadow-overlay">
                  <p className="font-medium" style={{ color: d.color }}>{d.name}: {d.value}</p>
                </div>
              );
            }}
          />
          <Legend
            layout="vertical"
            verticalAlign="middle"
            align="right"
            iconType="circle"
            iconSize={8}
            wrapperStyle={CHART_LEGEND_STYLE}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
