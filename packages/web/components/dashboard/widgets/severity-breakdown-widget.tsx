'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import type { WidgetSummaryResponse } from '@/lib/widget-links';
import type { Severity } from '@/lib/types';
import { CHART_LEGEND_STYLE, SEVERITY_CHART_COLOR, SEVERITY_LABEL, SEV_ORDER } from '@/components/dashboard/dashboard-constants';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { useWidgetUrl } from '@/components/dashboard/widget-request';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';
import { WidgetNothingToCount } from '@/components/dashboard/widgets/widget-no-count';

interface Props { refreshKey: number }

export function SeverityBreakdownWidget({ refreshKey }: Props) {
  const router = useRouter();
  const url = useWidgetUrl('summary');
  const { data: summary, loading, failed, noCount, retry } = useWidgetFetch<WidgetSummaryResponse>(
    url,
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
  if (noCount) return <WidgetNothingToCount reason={noCount} />;

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
              const href = severity && summary ? summary.severityHrefs[severity as Severity] : null;
              if (href) router.push(href);
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
