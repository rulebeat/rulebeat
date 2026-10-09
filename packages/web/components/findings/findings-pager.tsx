'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The pager under the flat findings list, and under every expanded group: four controls flush as
 *  one bar with the page counter in it. `page` is 1-based. Renders nothing for a single page. */
export function FindingsPager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-center py-2">
      <div className="flex items-center border border-rule-strong">
        <Button variant="ghost" size="sm" className="h-8 rounded-none px-3"
          onClick={() => onPage(1)} disabled={page <= 1}>First</Button>
        <Button variant="ghost" size="icon-sm" className="rounded-none border-l border-rule-strong" title="Previous page"
          onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>
          <ChevronLeft />
        </Button>
        <span className="numeral-grid border-x border-rule-strong px-4 py-1.5 text-xs text-ink-muted">
          Page {page} of {pageCount}
        </span>
        <Button variant="ghost" size="icon-sm" className="rounded-none" title="Next page"
          onClick={() => onPage(Math.min(pageCount, page + 1))} disabled={page >= pageCount}>
          <ChevronRight />
        </Button>
        <Button variant="ghost" size="sm" className="h-8 rounded-none border-l border-rule-strong px-3"
          onClick={() => onPage(pageCount)} disabled={page >= pageCount}>Last</Button>
      </div>
    </div>
  );
}
