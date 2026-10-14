'use client';

import { useState } from 'react';
import { Callout } from '@/components/ui/callout';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll } from '@/components/ui/table';
import { FindingsPager } from '@/components/findings/findings-pager';
import { SeverityBadge } from '@/components/findings/severity-badge';
import { CoveredScopeLabel } from '@/components/scans/covered-scope-label';
import type { CoveredScopeView } from '@/lib/run-scope';
import type { PersonalRuleResult } from '@/lib/types';

const PAGE_SIZE = 50;

export const PERSONAL_RESULTS_BANNER = 'Only you see these results. They count nowhere else: not in Results, dashboards, exports or posture.';

type RunStatus = 'success' | 'failed' | 'capped' | 'invalid';

interface Props {
  results: PersonalRuleResult[];
  /** When the latest run finished; absent when the rule has never been run. */
  lastRunAt?: string;
  lastRunStatus?: RunStatus;
  /** What the latest run covered, labelled for the reader; null before the first run. */
  covered: CoveredScopeView | null;
  /** Why Run is unavailable to this person right now, or null when it is available. */
  runBlockedReason: string | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function emptyState({ lastRunAt, lastRunStatus, runBlockedReason }: Pick<Props, 'lastRunAt' | 'lastRunStatus' | 'runBlockedReason'>): string {
  if (!lastRunAt) {
    return runBlockedReason
      ? `This rule has not been run, and it cannot run now: ${runBlockedReason}`
      : 'This rule has not been run yet. Select Run to see its results here.';
  }
  if (lastRunStatus === 'failed') return 'The last run failed before it returned results, so there is nothing to show. Run it again, or check the query.';
  if (lastRunStatus === 'invalid') return 'The last run could not use this rule as written, so there is nothing to show. Check the query and run it again.';
  return 'The last run finished and found no results.';
}

/** The latest run of one Personal rule, in the look of a Results table: severity, rule, resource, type,
 *  resource group and rows. It has no age, no suppress action and no history, since nothing here is a
 *  finding that is tracked. The banner is fixed: it says who can see this and where it counts. */
export function PersonalRuleResults({ results, lastRunAt, lastRunStatus, covered, runBlockedReason }: Props) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const visible = results.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <section className="space-y-4" aria-label="Latest results">
      <Callout tone="info">
        <span className="flex flex-col gap-2">
          <span>{PERSONAL_RESULTS_BANNER}</span>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>{lastRunAt ? `Last run ${formatDate(lastRunAt)}` : 'Never run'}</span>
            {covered && (
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="label-grid">Covered</span>
                <CoveredScopeLabel scope={covered} />
              </span>
            )}
          </span>
        </span>
      </Callout>

      {lastRunStatus === 'capped' && (
        <Callout tone="warn">The last run hit a result limit, so these results are not complete.</Callout>
      )}

      {results.length === 0 ? (
        <p role="status" className="py-10 text-center text-sm text-ink-2">{emptyState({ lastRunAt, lastRunStatus, runBlockedReason })}</p>
      ) : (
        <Card>
          <div className="px-6 py-3"><h2 className="title-grid">{`${results.length} ${results.length === 1 ? 'result' : 'results'}`}</h2></div>
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Resource group</TableHead>
                  <TableHead numeric>Rows</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((result, i) => {
                  const name = result.resourceName ?? result.resourceId ?? 'No resource';
                  return (
                    <TableRow key={`${result.resourceId ?? result.resourceName ?? 'none'}:${(current - 1) * PAGE_SIZE + i}`}>
                      <TableCell shrink><SeverityBadge severity={result.severity} /></TableCell>
                      <TableCell className="max-w-72 truncate text-xs" title={result.title}>{result.title}</TableCell>
                      <TableCell className="max-w-72">
                        <span className="block truncate text-sm font-medium text-ink" title={result.resourceId ?? name}>{name}</span>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-xs" title={result.resourceType}>{result.resourceType}</TableCell>
                      <TableCell className="max-w-48 truncate text-xs" title={result.resourceGroup}>{result.resourceGroup}</TableCell>
                      <TableCell numeric className="text-xs">{result.rows.length}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
          <FindingsPager page={current} pageCount={pageCount} onPage={setPage} />
        </Card>
      )}
    </section>
  );
}
