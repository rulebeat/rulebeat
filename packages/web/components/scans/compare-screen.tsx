'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Callout } from '@/components/ui/callout';
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card';
import { ReadStatus } from '@/components/ui/read-status';
import { ExportButton } from '@/components/findings/export-button';
import { FindingsPager } from '@/components/findings/findings-pager';
import { SeverityBadge } from '@/components/findings/severity-badge';
import type { CompareQuery } from '@/lib/compare-query';
import {
  compareAddress, compareCardQuery, compareCardTitle, compareDataOf, compareExportFileName, compareExportUrl, compareScreenOf, compareTiles, emptySideMessage, pagedCompareQuery,
  switchedCompareQuery, type CompareIds,
} from '@/lib/compare-screen';
import { CompareFeed } from '@/lib/compare-session';
import { EXPLORER_SEVERITIES } from '@/lib/explorer-filters';
import type { FetchFn } from '@/lib/explorer-session';
import { useStore } from '@/lib/hooks/use-explorer-session';
import { liveFindingHref } from '@/lib/snapshot-screen';
import type { SnapshotItem } from '@/lib/snapshot-response';
import { cn } from '@/lib/utils';
import type { Severity } from '@/lib/types';

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const isSeverity = (value: string): value is Severity => (EXPLORER_SEVERITIES as readonly string[]).includes(value);

/** One feed for the screen, made once. It reads through the browser's `fetch`, and stops reading when the
 *  screen unmounts. */
function useCompareFeed(): CompareFeed {
  const [feed] = useState(() => new CompareFeed(((url, init) => fetch(url, init)) as FetchFn));
  useEffect(() => () => feed.dispose(), [feed]);
  return feed;
}

function Row({ item }: { item: SnapshotItem }) {
  const href = liveFindingHref(item);
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        {isSeverity(item.severity) ? <SeverityBadge severity={item.severity} /> : <span className="text-xs text-ink">{item.severity}</span>}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink" title={item.title}>{item.title}</p>
          <p className="truncate text-xs text-ink">
            {item.resourceName ?? item.resourceId ?? 'No resource'}{item.resourceGroup ? ` · ${item.resourceGroup}` : ''}
          </p>
        </div>
      </div>
      {href ? (
        <Link href={href} className="shrink-0 text-xs font-medium text-ink hover:underline">View in Findings →</Link>
      ) : (
        <span className="shrink-0 text-xs text-ink">No longer exists</span>
      )}
    </div>
  );
}

/** Two past scans of one category side by side (ADR 0008): the findings added, fixed and persisted between
 *  them, one side and one page at a time, worked out in the database from each scan's own records. The
 *  request and the address are one query, written through `compareQueryToParams`. */
export function CompareScreen({
  ids, initialQuery, backHref, onUrlWrite,
}: {
  ids: CompareIds;
  /** The query the address held when the page was served. Read once; the screen writes every change back. */
  initialQuery: CompareQuery;
  backHref: string;
  /** Reports the query this screen is about to write to the address, so the page can tell its own writes from a navigation that came from elsewhere. */
  onUrlWrite?: (query: string) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const feed = useCompareFeed();
  const state = useStore(feed);
  const [query, setQuery] = useState(initialQuery);
  const [idA, idB] = ids;
  useEffect(() => { feed.request([idA, idB], query); }, [feed, idA, idB, query]);

  function change(next: CompareQuery) {
    if (next === query) return;
    setQuery(next);
    const address = compareAddress(ids, next, new URLSearchParams(searchParams.toString()));
    onUrlWrite?.(address);
    router.replace(`/scans?${address}`, { scroll: false });
  }

  const data = compareDataOf(state);
  const screen = compareScreenOf(state);
  const refused = state.status === 'not-found' || state.status === 'no-records' || state.status === 'different-categories' || state.status === 'bad-request';
  const tiles = compareTiles(data?.totals, query.side);

  return (
    <div className="space-y-6">
      <div>
        <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:underline">
          <ArrowLeft className="size-3.5" /> Back to history
        </Link>
        <h2 className="mt-2 font-heading text-lg font-semibold text-ink">Comparing scans</h2>
        {data && <p className="numeral-grid text-sm text-ink-2">{formatDate(data.older.startedAt)} → {formatDate(data.newer.startedAt)}</p>}
      </div>

      {refused && <Callout tone="info"><span role="status">{state.message}</span></Callout>}

      {!refused && (
        <>
          {/* Three tiles that are also the side control. The tile itself stays neutral so
              the only colour on screen is the count: new findings are the bad news, fixed
              ones the good news, and findings that simply carried over are neither.
              Selection is marked by weight and ground, not by another hue. */}
          <div className="grid grid-cols-3 gap-4">
            {tiles.map(tile => (
              <button
                key={tile.side}
                onClick={() => change(switchedCompareQuery(query, tile.side))}
                aria-pressed={tile.pressed}
                className={cn(
                  'border px-4 py-4 text-center transition-colors',
                  tile.pressed ? 'border-ink bg-surface-sunken' : 'border-border bg-surface hover:border-rule-strong',
                )}
              >
                <div className={cn('numeral-grid mb-1 text-2xl font-bold leading-none', tile.numeral)}>{tile.value}</div>
                <div className={cn('text-xs font-medium', tile.pressed ? 'text-ink' : 'text-ink-2')}>{tile.label}</div>
              </button>
            ))}
          </div>

          {screen === 'loading' && <ReadStatus failure={null} retry={() => feed.refresh()} loading="Loading findings" className="py-10 text-center" />}
          {screen === 'unavailable' && state.status === 'failed' && (
            <Card><ReadStatus failure={state.message} retry={() => feed.refresh()} loading="Loading findings" className="px-6 py-10 text-center" /></Card>
          )}

          {(screen === 'rows' || screen === 'empty-side') && data && (
            <Card>
              <CardHeader>
                <CardTitle>{compareCardTitle(data)}</CardTitle>
                <CardAction>
                  <ExportButton exportUrl={format => compareExportUrl(ids, compareCardQuery(data), format)} fileName={compareExportFileName(data)} />
                </CardAction>
              </CardHeader>
              {screen === 'empty-side' ? (
                <p className="py-10 text-center text-sm text-ink-muted">{emptySideMessage(data.side)}</p>
              ) : (
                <>
                  <div className="divide-y divide-border">
                    {data.items.map(item => <Row key={item.fingerprint} item={item} />)}
                  </div>
                  <FindingsPager page={data.page} pageCount={data.pageCount} onPage={page => change(pagedCompareQuery(compareCardQuery(data), page))} />
                </>
              )}
            </Card>
          )}
        </>
      )}

      <p className="text-xs text-ink-muted">
        Compare depth is bounded by scan history retention (up to 90 scans per category).
      </p>
    </div>
  );
}
