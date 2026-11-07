'use client';

import { Lock } from 'lucide-react';
import { WidgetWrapper } from '@/components/dashboard/widget-wrapper';
import { usePresenting } from '@/components/dashboard/present-context';
import { StatCardWidget } from '@/components/dashboard/widgets/stat-card-widget';
import { PostureRingWidget } from '@/components/dashboard/widgets/posture-ring-widget';
import { TrendWidget } from '@/components/dashboard/widgets/trend-widget';
import { TopRulesWidget } from '@/components/dashboard/widgets/top-rules-widget';
import { CategoryScorecardWidget } from '@/components/dashboard/widgets/category-scorecard-widget';
import { RecentFindingsWidget } from '@/components/dashboard/widgets/recent-findings-widget';
import { SeverityBreakdownWidget } from '@/components/dashboard/widgets/severity-breakdown-widget';
import { SubscriptionScorecardWidget } from '@/components/dashboard/widgets/subscription-scorecard-widget';
import { TopResourcesWidget } from '@/components/dashboard/widgets/top-resources-widget';
import { CoverageFreshnessWidget } from '@/components/dashboard/widgets/coverage-freshness-widget';
import { NewVsFixedWidget } from '@/components/dashboard/widgets/new-vs-fixed-widget';
import { ActivityOccurrencesWidget } from '@/components/dashboard/widgets/activity-occurrences-widget';
import { AdvisoriesWidget } from '@/components/dashboard/widgets/advisories-widget';
import type { WidgetDef } from '@/lib/types';
import { mergeWidgetFilters, type WidgetFilters } from '@/lib/dashboard-filters';
import { widgetAccessReason, type OutsideAccess } from '@/lib/outside-access';

export function WidgetRenderer({ widget, filters, filtered, refreshKey, editMode, outsideAccess, onRemove, onConfigure }: {
  widget: WidgetDef;
  filters: WidgetFilters;
  filtered: boolean;
  refreshKey: number;
  editMode: boolean;
  outsideAccess: OutsideAccess;
  onRemove?: () => void;
  onConfigure?: () => void;
}) {
  // A widget filtered only to what the person cannot see says so, instead of drawing the zero its
  // empty read would turn into a 100% posture or "No violations found".
  const accessReason = widgetAccessReason(mergeWidgetFilters(filters, widget.config), outsideAccess);
  // On Present the reason is plain text: nothing there is listening for a live region to change.
  const presenting = usePresenting();
  const inner = accessReason ? (
    <div role={presenting ? undefined : 'status'} className="flex h-full flex-col items-center justify-center gap-2 px-4 py-6 text-center">
      <Lock className="size-5 text-ink-2" aria-hidden="true" />
      <p className="text-sm font-semibold text-ink">{accessReason.title}</p>
      <p className="max-w-xs text-xs text-ink-2">{accessReason.detail}</p>
    </div>
  ) : (() => {
    switch (widget.type) {
      case 'stat-card':
        return <StatCardWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'posture-ring':
        return <PostureRingWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'trend':
        return <TrendWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'top-rules':
        return <TopRulesWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'category-scorecard':
        return <CategoryScorecardWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'recent-findings':
        return <RecentFindingsWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'severity-breakdown':
        return <SeverityBreakdownWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'subscription-scorecard':
        return <SubscriptionScorecardWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'top-resources':
        return <TopResourcesWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'coverage-freshness':
        return <CoverageFreshnessWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'new-vs-fixed':
        return <NewVsFixedWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'activity-occurrences':
        return <ActivityOccurrencesWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      case 'advisories':
        return <AdvisoriesWidget config={widget.config as never} filters={filters} refreshKey={refreshKey} />;
      default:
        return <div className="flex h-full items-center justify-center text-sm text-ink-muted">Unknown widget</div>;
    }
  })();

  return (
    <WidgetWrapper widget={widget} editMode={editMode} filtered={filtered} onRemove={onRemove} onConfigure={onConfigure}>
      {inner}
    </WidgetWrapper>
  );
}
