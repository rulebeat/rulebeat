'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { SeverityBadge } from '@/components/findings/severity-badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import { mergeWidgetFilters, buildSummaryParams, type WidgetFilters } from '@/lib/dashboard-filters';
import { buildScansHref } from '@/lib/scans-link';
import {
  advisoriesWidgetView, formatLastSeen, ADVISORIES_WIDGET_DEFAULT_LIMIT, ADVISORIES_WIDGET_EMPTY,
  type AdvisoriesWidgetData,
} from '@/lib/advisories-widget';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

interface Config { category?: string; limit?: number; policyIds?: string[] }
interface Props { config: Config; filters: WidgetFilters; refreshKey: number; }

/** Open Advisories, by severity then most recently seen, so a dashboard shows what needs action without counting it as a
 *  failure. Backed by /api/widgets/advisories, the same read as the Advisories tab. A row opens
 *  that tab filtered to the Advisory's rule and resource. The empty state says whether no Advisory
 *  rule is enabled or the enabled ones have nothing open; a failed fetch never shows either. */
export function AdvisoriesWidget({ config, filters, refreshKey }: Props) {
  const router = useRouter();
  const merged = useMemo(() => mergeWidgetFilters(filters, config as unknown as Record<string, unknown>), [filters, config]);
  const params = useMemo(() => {
    const p = buildSummaryParams(merged);
    p.set('limit', String(config.limit ?? ADVISORIES_WIDGET_DEFAULT_LIMIT));
    return p.toString();
  }, [merged, config.limit]);
  const { data, loading, failed, retry } = useWidgetFetch<AdvisoriesWidgetData>(
    `/api/widgets/advisories?${params}`,
    [refreshKey]
  );

  const view = advisoriesWidgetView({ loading, failed, data });

  if (view === 'loading') {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-2" /></div>;
  }
  if (view === 'unavailable') {
    return <WidgetUnavailable onRetry={retry} />;
  }
  if (view === 'no-rules' || view === 'none-open') {
    const { title, hint } = ADVISORIES_WIDGET_EMPTY[view];
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
        <p className="text-sm text-ink">{title}</p>
        <p className="max-w-xs text-xs text-ink-2">{hint}</p>
      </div>
    );
  }

  const { items, total } = data!;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TableScroll fill>
        {/* data-widget-content marks the natural-height block the dashboard measures so it
            can shrink this widget's row span to fit. See dashboard-grid-client. */}
        <Table data-widget-content>
          <TableHeader sticky>
            <TableRow>
              <TableHead shrink>Severity</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead shrink>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(item => {
              const href = buildScansHref(merged, { tab: 'advisories', ruleId: item.ruleId, search: item.resourceName });
              return (
                <TableRow key={item.fingerprint} interactive onClick={() => router.push(href)}>
                  <TableCell shrink>
                    <SeverityBadge severity={item.severity} />
                  </TableCell>
                  <TableCell className="max-w-[160px]">
                    <p className="truncate text-ink">{item.ruleName}</p>
                  </TableCell>
                  <TableCell className="max-w-[160px]">
                    <p className="truncate font-medium text-ink">{item.resourceName}</p>
                  </TableCell>
                  <TableCell shrink>
                    <span className="text-xs tabular-nums text-ink-2">{formatLastSeen(item.lastSeenAt)}</span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableScroll>
      {total > items.length && (
        <p className="shrink-0 px-3 py-2 text-xs text-ink-2">Showing {items.length} of {total} open Advisories</p>
      )}
    </div>
  );
}
