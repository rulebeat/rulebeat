'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref } from '@/lib/scans-link';
import { useSubscriptionNames } from '@/lib/hooks/use-subscription-names';
import { postureColor } from '@/components/dashboard/dashboard-constants';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { limit?: number; category?: string; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

export function SubscriptionScorecardWidget({ config, filters, refreshKey }: Props) {
  const router = useRouter();
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const subNames = useSubscriptionNames();
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

  const subs = config.limit ? summary.perSubscription.slice(0, config.limit) : summary.perSubscription;

  if (!subs.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No findings yet. Subscriptions appear here once findings exist</div>;
  }

  return (
    <div className="scroll-y grid h-full auto-rows-min gap-0">
      {/* data-widget-content marks the natural-height block the dashboard measures so it
          can shrink this widget's row span to fit. See dashboard-grid-client. */}
      <div data-widget-content className="grid content-start grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-5">
        <p
          className="col-span-full text-xs text-ink-muted"
          title="Each subscription's total reflects every rule enabled for the category — it isn't narrowed to that subscription's own resources, so subscriptions with fewer applicable resource types will always show more headroom than they really have."
        >
          Totals are per category, not per subscription
        </p>
        {subs.map(sub => {
          const color = postureColor(sub.pct);
          const label = subNames[sub.subscriptionId] ?? sub.subscriptionId;
          return (
            <button
              key={sub.subscriptionId}
              type="button"
              onClick={() => router.push(buildScansHref(merged, { subscription: sub.subscriptionId }))}
              className="flex flex-col gap-2 border border-border p-3 text-left transition-colors hover:border-ink hover:bg-surface-hover"
            >
              <span className="truncate text-xs font-semibold text-ink" title={label}>{label}</span>
              {sub.pct !== null ? (
                <>
                  <span className="numeral-grid text-2xl font-semibold leading-none" style={{ color }}>{sub.passingRules}/{sub.totalRules}</span>
                  <span className="numeral-grid text-xs text-ink-muted">{sub.pct}%</span>
                  {sub.activeFindings === 0 ? (
                    <span className="flex items-center gap-1 text-xs font-medium text-ink-2">
                      <CheckCircle2 className="size-3" />All passing
                    </span>
                  ) : (
                    <span className="numeral-grid text-xs text-ink">{sub.activeFindings} finding{sub.activeFindings !== 1 ? 's' : ''}</span>
                  )}
                </>
              ) : (
                <span className="text-xs text-ink-muted">No data</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
