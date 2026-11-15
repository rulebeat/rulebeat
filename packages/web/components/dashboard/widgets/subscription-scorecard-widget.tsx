'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2 } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref } from '@/lib/scans-link';
import { OUTSIDE_PLACEMENTS } from '@/lib/placement';
import { useSubscriptionNames } from '@/lib/hooks/use-subscription-names';
import { postureColor } from '@/components/dashboard/dashboard-constants';
import { useReportWidgetNotes } from '@/lib/hooks/use-widget-notes';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';
import { compareRows, rowLabel, type SubscriptionRow } from '@/lib/subscription-rows';
import {
  NO_RULES_DIRECTORY, NO_RULES_SUBSCRIPTION, SUBSCRIPTIONS_EMPTY, YOUR_GROUPS_ONLY, outsideSubscriptionsNote, showingLowestFirst,
} from '@/lib/widget-limits';

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

  useReportWidgetNotes(!loading && !failed && summary ? summary.subscriptionNotes : []);

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;
  }
  if (failed) {
    return <WidgetUnavailable onRetry={retry} />;
  }
  if (!summary) return null;

  const labelOf = (row: SubscriptionRow) => rowLabel(row, subNames[row.subscriptionId]);
  const all = [...summary.perSubscription].sort((a, b) => compareRows(a, b, labelOf));
  const subs = config.limit ? all.slice(0, config.limit) : all;

  if (!all.length) {
    return <div className="flex h-full items-center justify-center px-4 text-center text-sm text-ink-muted">{SUBSCRIPTIONS_EMPTY}</div>;
  }

  const outside = summary.outsideSubscriptions;

  return (
    <div className="scroll-y grid h-full auto-rows-min gap-0">
      {/* data-widget-content marks the natural-height block the dashboard measures so it
          can shrink this widget's row span to fit. See dashboard-grid-client. */}
      <div data-widget-content className="grid content-start grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-5">
        {subs.map(sub => {
          const label = labelOf(sub);
          const allPassing = sub.totalRules > 0 && sub.passingRules === sub.totalRules;
          return (
            <button
              key={sub.subscriptionId}
              type="button"
              onClick={() => router.push(buildScansHref(merged, { subscription: sub.subscriptionId }))}
              className="flex flex-col gap-2 border border-border p-3 text-left transition-colors hover:border-ink hover:bg-surface-hover"
            >
              <span className="truncate text-xs font-semibold text-ink" title={label}>{label}</span>
              {sub.yourGroupsOnly && <span className="text-xs text-ink-muted">{YOUR_GROUPS_ONLY}</span>}
              {sub.totalRules > 0 ? (
                <>
                  <span className="numeral-grid text-2xl font-semibold leading-none" style={{ color: postureColor(sub.pct) }}>{sub.passingRules}/{sub.totalRules}</span>
                  <span className="numeral-grid text-xs text-ink-muted">{sub.pct}%</span>
                </>
              ) : (
                <span className="text-xs text-ink-2">{sub.directory ? NO_RULES_DIRECTORY : NO_RULES_SUBSCRIPTION}</span>
              )}
              {allPassing && (
                <span className="flex items-center gap-1 text-xs font-medium text-ink-2">
                  <CheckCircle2 className="size-3" />All passing
                </span>
              )}
              {sub.activeFindings > 0 && (
                <span className="numeral-grid text-xs text-ink">{sub.activeFindings} finding{sub.activeFindings !== 1 ? 's' : ''}</span>
              )}
              {!allPassing && sub.unknownRules > 0 && <span className="numeral-grid text-xs text-ink-2">{sub.unknownRules} not yet proven</span>}
            </button>
          );
        })}
        {subs.length < all.length && (
          <p className="col-span-full text-xs text-ink-muted">{showingLowestFirst(subs.length, all.length)}</p>
        )}
        {outside != null && (
          <p className="col-span-full text-xs text-ink-2">
            {outside > 0 ? (
              <Link href={buildScansHref(merged, { status: 'open', placements: OUTSIDE_PLACEMENTS })} className="underline underline-offset-2 hover:text-ink">
                {outsideSubscriptionsNote(outside)}
              </Link>
            ) : outsideSubscriptionsNote(outside)}
          </p>
        )}
      </div>
    </div>
  );
}
