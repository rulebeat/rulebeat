'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { timeAgo } from '@/components/dashboard/dashboard-constants';
import { SeverityBadge } from '@/components/findings/severity-badge';
import { CategoryBadge } from '@/components/findings/category-badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import type { Finding, FilterOptionsResponse } from '@/lib/types';
import { useWidgetFetch } from '@/lib/hooks/use-widget-fetch';
import { useWidgetUrl } from '@/components/dashboard/widget-request';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';
import { WidgetNothingToCount } from '@/components/dashboard/widgets/widget-no-count';

interface Config { category?: string; limit?: number; policyIds?: string[] }
interface Props { config: Config; refreshKey: number; }

/** Compact, filter-aware findings feed. The single replacement for the old findings-table and
 *  findings-explorer dashboard widgets. Anything bigger belongs on the Scans page; this is a
 *  "what's new" glance with a row click that navigates there, filtered. */
export function RecentFindingsWidget({ config, refreshKey }: Props) {
  const router = useRouter();
  const url = useWidgetUrl('findings', { limit: config.limit ?? 10 });
  const { data, loading, failed, noCount, retry } = useWidgetFetch<{ items: Array<Finding & { href: string }> }>(
    url,
    [refreshKey]
  );
  const findings = data?.items ?? [];

  const [categories, setCategories] = useState<FilterOptionsResponse['categories']>([]);
  useEffect(() => {
    // Same endpoint/pattern the dashboard filter bar and widget config panel use: categories
    // are DB-backed and user-extensible, so the raw id alone isn't a stable enough label.
    fetch('/api/widgets/filter-options')
      .then(r => r.ok ? r.json() : null)
      .then((d: FilterOptionsResponse | null) => { if (d) setCategories(d.categories); })
      .catch(() => {});
  }, []);

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-ink-muted" /></div>;
  }
  if (failed) {
    return <WidgetUnavailable onRetry={retry} />;
  }
  if (noCount) return <WidgetNothingToCount reason={noCount} />;
  if (!findings.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-muted">No findings. All rules passing</div>;
  }

  /* `fill` is the one mode where a sticky header works: the widget tile gives this
     a real height, so the scrolling happens here rather than on the page. */
  return (
    <TableScroll fill>
      {/* data-widget-content marks the natural-height block the dashboard measures so it
          can shrink this widget's row span to fit. See dashboard-grid-client. */}
      <Table data-widget-content>
        <TableHeader sticky>
          <TableRow>
            <TableHead shrink>Severity</TableHead>
            <TableHead>Resource</TableHead>
            <TableHead className="hidden sm:table-cell">Category</TableHead>
            <TableHead shrink className="hidden md:table-cell">Detected</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {findings.map((f, i) => {
            return (
              <TableRow key={f.fingerprint ?? i} interactive onClick={() => router.push(f.href)}>
                <TableCell shrink>
                  <SeverityBadge severity={f.severity} />
                </TableCell>
                <TableCell className="max-w-[180px]">
                  <p className="truncate font-medium text-ink">{f.resourceName}</p>
                  <p className="truncate text-ink">{f.title}</p>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <CategoryBadge id={f.category} categories={categories} />
                </TableCell>
                <TableCell shrink className="hidden md:table-cell">
                  {f.detectedAt ? timeAgo(f.detectedAt) : '-'}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableScroll>
  );
}
