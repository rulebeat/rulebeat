'use client';

import { useState } from 'react';
import { FindingsPager } from '@/components/findings/findings-pager';
import { RowEvidence } from '@/components/findings/finding-rows-detail';
import { ReadStatus } from '@/components/ui/read-status';
import { ROWS_PER_PAGE } from '@/lib/finding-rows';
import { rowsUrl, type ExplorerSession, type RowCondition, type ViewRequest } from '@/lib/explorer-session';
import { useLazyRead } from '@/lib/hooks/use-explorer-session';
import type { ViewItemResponse } from '@/lib/view-response';

/** Every row a finding holds, a page of 20 at a time. The first page came with the finding; each
 *  further page is read from the rows route when it is asked for, so a finding with thousands of rows
 *  sends 20. One row renders as it always has, several as a numbered list of the same rendering in
 *  query order. `conditions` are the group a finding is listed under, so its rows are the group's. */
export function LazyFindingRows({
  item, session, request, conditions,
}: {
  item: ViewItemResponse;
  session: ExplorerSession;
  request: ViewRequest;
  conditions?: readonly RowCondition[];
}) {
  const [asked, setAsked] = useState(1);
  const total = item.matchedRowCount;
  const pageCount = Math.max(1, Math.ceil(total / ROWS_PER_PAGE));
  // A view that changed under an open finding may hold fewer pages than the one it was on.
  const page = Math.min(asked, pageCount);
  const { state, retry } = useLazyRead(session.rows, page > 1 ? rowsUrl(request, item.finding.fingerprint, page, conditions) : null);

  if (total <= 1) return <RowEvidence row={item.rows[0] ?? {}} />;

  const body = (() => {
    if (page === 1) return { rows: item.rows, firstIndex: 0 };
    if (state?.status === 'ready') return { rows: state.data.rows, firstIndex: state.data.firstIndex };
    return null;
  })();

  return (
    <div className="space-y-6">
      {body ? (
        <ol className="space-y-6">
          {body.rows.map((row, i) => (
            <li key={body.firstIndex + i}>
              <p className="label-grid mb-2">Row {body.firstIndex + i + 1} of {total}</p>
              <RowEvidence row={row} />
            </li>
          ))}
        </ol>
      ) : (
        <ReadStatus failure={state?.status === 'failed' ? state.message : null} retry={retry} loading="Loading rows" />
      )}
      <FindingsPager page={page} pageCount={pageCount} onPage={setAsked} />
    </div>
  );
}
