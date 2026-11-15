'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Loader2, CheckCircle2, AlertTriangle, Clock, HelpCircle } from 'lucide-react';
import type { WidgetSummary } from '@/lib/dashboard-data';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref } from '@/lib/scans-link';
import { incompleteRulesHref } from '@/lib/rules-tab-query';
import { timeAgo } from '@/components/dashboard/dashboard-constants';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { staleAfterHours?: number; category?: string; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number }

type Freshness = 'fresh' | 'recent' | 'stale' | 'never';

function classify(lastScanAt: string | null, staleAfterHours: number): Freshness {
  if (!lastScanAt) return 'never';
  const hrs = (Date.now() - new Date(lastScanAt).getTime()) / 3_600_000;
  if (hrs < 24) return 'fresh';
  if (hrs < staleAfterHours) return 'recent';
  return 'stale';
}

/* Fresh is the ordinary case, so it stays neutral and unfilled. Only the two
   states worth acting on carry a hue, and never-scanned is a gap rather than a
   failure, so it reads faint instead of red. */
const BADGE: Record<Freshness, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  fresh:  { label: 'Fresh',         className: 'border-border text-ink-muted',              icon: CheckCircle2 },
  recent: { label: 'Recent',        className: 'border-status-warn/40 text-status-warn',    icon: Clock },
  stale:  { label: 'Stale',         className: 'border-sev-critical/40 text-sev-critical',  icon: AlertTriangle },
  never:  { label: 'Never scanned', className: 'border-border text-ink-faint',              icon: HelpCircle },
};

const FRESHNESS_DEFINITION_EVERYTHING = 'Last scanned is the newest scan of this category, whatever it covered.';
const FRESHNESS_DEFINITION_SCOPED = 'Last scanned is the newest scan that covered part of what you hold.';
const INCOMPLETE_DEFINITION = 'Incomplete rules are enabled rules whose last run failed, was capped or was invalid. They look at what you hold and ignore the Scope, tag, rule and severity filters.';

/** A high posture % means nothing if the underlying scan is weeks old. This widget surfaces
 *  per-category scan recency so that trust signal is visible next to the score, not implied. */
export function CoverageFreshnessWidget({ config, filters, refreshKey }: Props) {
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const staleAfterHours = config.staleAfterHours ?? 168; // 7 days
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

  return (
    <div className="h-full scroll-y">
      {/* data-widget-content marks the natural-height block the dashboard measures so it
          can shrink this widget's row span to fit. See dashboard-grid-client. */}
      <div data-widget-content className="divide-y divide-border">
        {summary.perCategory.map(cat => {
          const freshness = classify(cat.lastScanAt, staleAfterHours);
          const badge = BADGE[freshness];
          const Icon = badge.icon;
          return (
            <div key={cat.category} className="flex items-center gap-3 pr-4 transition-colors hover:bg-surface-hover">
              <Link
                href={buildScansHref(merged, { category: cat.category })}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 py-2.5 pl-4"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="size-2 shrink-0" style={{ backgroundColor: cat.color ?? 'var(--color-ink-faint)' }} />
                  <span className="truncate text-sm font-medium text-ink">{cat.label}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-ink-muted">
                    {cat.lastScanAt ? timeAgo(cat.lastScanAt) : '-'}
                  </span>
                  <span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>
                    <Icon className="size-3" />{badge.label}
                  </span>
                </div>
              </Link>
              {/* A fixed-width slot, filled or not, so the time and freshness badge line up row to row. */}
              <div className="flex w-36 shrink-0 justify-end">
                {cat.incompleteRuleCount > 0 && (
                  <Link
                    href={incompleteRulesHref(cat.category, summary.holdsEverything)}
                    className="bg-status-warn-soft px-1.5 py-0.5 text-xs font-medium text-status-warn"
                  >
                    {cat.incompleteRuleCount === 1 ? '1 rule incomplete' : `${cat.incompleteRuleCount} rules incomplete`}
                  </Link>
                )}
              </div>
            </div>
          );
        })}
        <p className="px-4 py-2.5 text-xs text-ink-muted">
          {summary.holdsEverything ? FRESHNESS_DEFINITION_EVERYTHING : FRESHNESS_DEFINITION_SCOPED} {INCOMPLETE_DEFINITION}
        </p>
      </div>
    </div>
  );
}
