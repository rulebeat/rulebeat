'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card } from '@/components/ui/card';
import { ChecklistDropdown } from '@/components/ui/checklist-dropdown';
import { Input } from '@/components/ui/input';
import { ReadStatus } from '@/components/ui/read-status';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll } from '@/components/ui/table';
import { ExportButton } from '@/components/findings/export-button';
import { FindingsPager } from '@/components/findings/findings-pager';
import { SeverityBadge } from '@/components/findings/severity-badge';
import { EXPLORER_SEVERITIES } from '@/lib/explorer-filters';
import type { FetchFn } from '@/lib/explorer-session';
import { useStore } from '@/lib/hooks/use-explorer-session';
import { SNAPSHOT_COLUMNS, type SnapshotItem } from '@/lib/snapshot-response';
import { snapshotQueryToParams, type SnapshotQuery } from '@/lib/snapshot-query';
import {
  LIVE_FINDING_NOTE, clearedSnapshotQuery, isSnapshotFiltered, liveFindingHref, searchedSnapshotQuery, snapshotDataOf,
  snapshotExportUrl, snapshotFacetOptions, snapshotScreenOf, toggledSnapshotQuery,
} from '@/lib/snapshot-screen';
import { SnapshotFeed } from '@/lib/snapshot-session';
import type { Category, Severity } from '@/lib/types';

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const isSeverity = (value: string): value is Severity => (EXPLORER_SEVERITIES as readonly string[]).includes(value);

/** One feed for the screen, made once. It reads through the browser's `fetch`, and stops reading when the
 *  screen unmounts. */
function useSnapshotFeed(): SnapshotFeed {
  const [feed] = useState(() => new SnapshotFeed(((url, init) => fetch(url, init)) as FetchFn));
  useEffect(() => () => feed.dispose(), [feed]);
  return feed;
}

function Cell({ item, column }: { item: SnapshotItem; column: (typeof SNAPSHOT_COLUMNS)[number]['key'] }) {
  switch (column) {
    case 'severity':
      return <TableCell shrink>{isSeverity(item.severity) ? <SeverityBadge severity={item.severity} /> : <span className="text-xs text-ink">{item.severity}</span>}</TableCell>;
    case 'title':
      return <TableCell className="max-w-72 truncate text-xs" title={item.title}>{item.title}</TableCell>;
    case 'resourceName': {
      const name = item.resourceName ?? item.resourceId ?? 'No resource';
      const href = liveFindingHref(item);
      return (
        <TableCell className="max-w-72">
          {href ? (
            <Link href={href} className="block truncate text-sm font-medium text-ink underline-offset-4 hover:underline" title={name}>{name}</Link>
          ) : (
            <>
              <span className="block truncate text-sm font-medium text-ink" title={name}>{name}</span>
              <span className="block text-xs text-ink-muted">No longer exists</span>
            </>
          )}
        </TableCell>
      );
    }
    case 'resourceType':
      return <TableCell className="max-w-64 truncate text-xs" title={item.resourceType ?? undefined}>{item.resourceType}</TableCell>;
    case 'resourceGroup':
      return <TableCell className="max-w-48 truncate text-xs" title={item.resourceGroup ?? undefined}>{item.resourceGroup}</TableCell>;
    case 'rowCount':
      return <TableCell numeric className="text-xs">{item.rowCount}</TableCell>;
  }
}

/** One past scan's findings as they were found (ADR 0008): a paged table of records with filters, a
 *  search and an export. A finding links to its live finding, where its rows and status are. The request
 *  and the address are one query, written through `snapshotQueryToParams`. */
export function SnapshotScreen({
  scanId, initialQuery, categories, backHref, onUrlWrite,
}: {
  scanId: string;
  /** The query the address held when the page was served. Read once; the screen writes every change back. */
  initialQuery: SnapshotQuery;
  categories: Category[];
  backHref: string;
  /** Reports the query this screen is about to write to the address, so the page can tell its own writes from a navigation that came from elsewhere. */
  onUrlWrite?: (query: string) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const feed = useSnapshotFeed();
  const state = useStore(feed);
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => { feed.request(scanId, query); }, [feed, scanId, query]);

  function change(next: SnapshotQuery) {
    setQuery(next);
    const address = snapshotQueryToParams(next, new URLSearchParams(searchParams.toString())).toString();
    onUrlWrite?.(address);
    router.replace(`/scans?${address}`, { scroll: false });
  }

  const data = snapshotDataOf(state);
  const screen = snapshotScreenOf({ state, query });
  const filtered = isSnapshotFiltered(query);
  const categoryLabel = data ? (categories.find(c => c.id === data.scan.category)?.label ?? data.scan.category) : null;

  return (
    <div className="space-y-4">
      {/* You are looking at a past scan, not the current state. That is worth saying, but it is not a
          problem, so it reads as info rather than a warning. */}
      <Callout tone="info" className="items-center justify-between">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {data && categoryLabel
              ? `${categoryLabel} · ${formatDate(data.scan.startedAt)} · ${data.total} ${filtered ? 'matching ' : ''}${data.total === 1 ? 'finding' : 'findings'}`
              : 'Past run'}
          </span>
          <Link href={backHref} className="flex items-center gap-1 font-medium text-ink underline hover:no-underline">
            <ArrowLeft className="size-3" /> Back
          </Link>
        </span>
      </Callout>

      {data && screen !== 'empty-run' && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-64 shrink-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-2" />
            <Input
              value={query.search}
              onChange={e => change(searchedSnapshotQuery(query, e.target.value))}
              placeholder="Search resource, rule, type…"
              aria-label="Search this run's findings"
              className="pl-9"
            />
          </div>
          <ChecklistDropdown
            label="Severity"
            options={snapshotFacetOptions(data.facets.severity, query.severity, 'severity')}
            selected={new Set(query.severity)}
            onToggle={v => change(toggledSnapshotQuery(query, 'severity', v))}
            onClear={() => change(clearedSnapshotQuery(query, 'severity'))}
          />
          <ChecklistDropdown
            label="Rule"
            options={snapshotFacetOptions(data.facets.rule, query.rule, 'rule')}
            selected={new Set(query.rule)}
            onToggle={v => change(toggledSnapshotQuery(query, 'rule', v))}
            onClear={() => change(clearedSnapshotQuery(query, 'rule'))}
          />
          {filtered && (
            <Button variant="outline" size="sm" onClick={() => change({ ...query, severity: [], rule: [], search: '', page: 1 })}>
              <X /> Clear
            </Button>
          )}
          <div className="ml-auto">
            <ExportButton exportUrl={format => snapshotExportUrl(scanId, query, format)} fileName="snapshot" />
          </div>
        </div>
      )}

      {screen === 'loading' && <ReadStatus failure={null} retry={() => feed.refresh()} loading="Loading findings" className="py-10 text-center" />}
      {screen === 'unavailable' && state.status === 'failed' && (
        <Card><ReadStatus failure={state.message} retry={() => feed.refresh()} loading="Loading findings" className="px-6 py-10 text-center" /></Card>
      )}
      {(screen === 'not-found' || screen === 'no-records') && (state.status === 'not-found' || state.status === 'no-records') && (
        <p role="status" className="py-10 text-center text-sm text-ink-2">{state.message}</p>
      )}
      {screen === 'empty-run' && <p className="py-10 text-center text-sm text-ink-2">This run returned no findings.</p>}
      {screen === 'no-match' && <p className="py-10 text-center text-sm text-ink-2">No findings in this run match the search and filters.</p>}

      {screen === 'rows' && data && (
        <Card>
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  {SNAPSHOT_COLUMNS.map(column => (
                    <TableHead key={column.key} numeric={column.key === 'rowCount'}>{column.header}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map(item => (
                  <TableRow key={item.fingerprint}>
                    {SNAPSHOT_COLUMNS.map(column => <Cell key={column.key} item={item} column={column.key} />)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
          <FindingsPager page={data.page} pageCount={data.pageCount} onPage={page => change({ ...query, page })} />
          <p className="border-t border-border px-6 py-3 text-xs text-ink-2">{LIVE_FINDING_NOTE}</p>
        </Card>
      )}
    </div>
  );
}
