'use client';

import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref } from '@/lib/scans-link';
import { SEVERITY_CHART_COLOR, SEVERITY_LABEL, SEV_ORDER } from '@/components/dashboard/dashboard-constants';
import { SeverityStackedBar } from '@/components/dashboard/severity-stacked-bar';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { category?: string; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

export function SeverityBreakdownWidget({ config, filters, refreshKey }: Props) {
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const params = buildSummaryParams(merged).toString();
  const { data: summary, loading, failed, retry } = useWidgetFetch<WidgetSummary>(
    `/api/widgets/summary?${params}`,
    [refreshKey]
  );

  const segments = useMemo(() => {
    if (!summary) return [];
    return SEV_ORDER
      .map(s => ({
        severity: s,
        label: SEVERITY_LABEL[s],
        value: summary.current.severityCounts[s] ?? 0,
        href: buildScansHref(merged, { severity: s }),
        color: SEVERITY_CHART_COLOR[s],
      }))
      .filter(d => d.value > 0);
  }, [summary, merged]);

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;

  if (failed) return <WidgetUnavailable onRetry={retry} />;

  if (!segments.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No open findings</div>;
  }

  return (
    <div className="flex h-full flex-col justify-center px-4 py-3">
      <SeverityStackedBar segments={segments} />
    </div>
  );
}
