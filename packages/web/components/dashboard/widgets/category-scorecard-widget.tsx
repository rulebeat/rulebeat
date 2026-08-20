'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Loader2, CheckCircle2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref } from '@/lib/scans-link';
import { CATEGORY_COLORS } from '@/components/dashboard/dashboard-constants';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { category?: string; policyIds?: string[]; categories?: string[] /* legacy multi-select, pre-ScopeSection */ }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

export function CategoryScorecardWidget({ config, filters, refreshKey }: Props) {
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const params = buildSummaryParams(merged).toString();
  const { data: summary, loading, failed, retry } = useWidgetFetch<WidgetSummary>(
    `/api/widgets/summary?${params}`,
    [refreshKey]
  );

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;
  }
  if (failed) {
    return <WidgetUnavailable onRetry={retry} />;
  }
  if (!summary) return null;

  // `summary.perCategory` is already narrowed by the merged category filter server-side; the
  // legacy `categories` config key (from the pre-ScopeSection config panel) is still honored
  // for dashboards saved before the shared Scope section existed.
  const mods = config.categories?.length
    ? summary.perCategory.filter(m => config.categories!.includes(m.category))
    : summary.perCategory;

  return (
    <div className="grid h-full auto-rows-min gap-0 scroll-y">
      {/* data-widget-content marks the natural-height block the dashboard measures so it
          can shrink this widget's row span to fit. See dashboard-grid-client. */}
      <div data-widget-content className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 p-3 content-start">
        {mods.map(mod => {
          const color = mod.color ?? CATEGORY_COLORS[mod.category] ?? 'var(--color-ink-faint)';

          return (
            <Link
              key={mod.category}
              href={buildScansHref(merged, { category: mod.category })}
              className="group flex flex-col gap-2 border border-border p-3 transition-colors hover:border-ink hover:bg-surface-hover"
            >
              <div className="flex items-center gap-2">
                <span className="size-2 shrink-0" style={{ backgroundColor: color }} />
                <span className="truncate text-xs font-semibold text-ink">{mod.label}</span>
              </div>

              {mod.pct !== null ? (
                <>
                  <span className="numeral-grid text-2xl font-bold leading-none text-ink">{mod.passing}/{mod.total}</span>
                  <span className="numeral-grid text-xs text-ink-muted">{mod.pct}%</span>
                  {mod.activeFindings === 0 ? (
                    <span className="flex items-center gap-1 text-xs font-medium text-ink-2">
                      <CheckCircle2 className="size-3" />All passing
                    </span>
                  ) : (
                    <span className="text-xs text-ink">{mod.activeFindings} finding{mod.activeFindings !== 1 ? 's' : ''}</span>
                  )}
                </>
              ) : (
                <span className="text-xs text-ink-muted">No data</span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
