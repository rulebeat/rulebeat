'use client';

import { Fragment, useState } from 'react';
import { FindingsPager } from '@/components/findings/findings-pager';
import { findingRows, pageFindingRows, type FindingRow } from '@/lib/finding-rows';

/** One row's columns and, for a row made by the visual builder, the condition it violated. */
function RowEvidence({ row }: { row: FindingRow }) {
  // Support both old evidence format {field,operator,value} and new {_rule,...data}
  const isNew = '_rule' in row;
  const ruleInfo = isNew
    ? (row._rule as Record<string, unknown> | undefined)
    : { field: row['field'], operator: row['operator'], value: row['value'], values: row['values'] };
  const dataEntries = Object.entries(row).filter(([k]) =>
    isNew ? k !== '_rule' : !['field', 'operator', 'value', 'values', 'presentTags'].includes(k)
  );
  const showRule = Boolean(ruleInfo && (ruleInfo['field'] || ruleInfo['operator']));
  if (dataEntries.length === 0 && !showRule) return null;
  return (
    <div className="space-y-4">
      {dataEntries.length > 0 && (
        <div>
          <p className="label-grid mb-2">Resource Data</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-1.5">
            {dataEntries.map(([k, v]) => (
              <Fragment key={k}>
                <dt className="shrink-0 pt-0.5 font-mono text-xs text-ink-2">{k}</dt>
                <dd className="break-all font-mono text-xs text-ink">
                  {typeof v === 'object' && v !== null
                    ? <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(v, null, 2)}</pre>
                    : String(v ?? '')}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
      {showRule && ruleInfo && (
        <div>
          <p className="label-grid mb-1.5">Violated rule</p>
          <p className="font-mono text-xs text-ink">
            {String(ruleInfo['field'] ?? '')}
            {' '}
            <span className="text-ink">{String(ruleInfo['operator'] ?? '')}</span>
            {ruleInfo['value'] != null && <> <span className="font-medium text-ink">&apos;{String(ruleInfo['value'])}&apos;</span></>}
            {Array.isArray(ruleInfo['values']) && <> [{(ruleInfo['values'] as string[]).map(v => `'${v}'`).join(', ')}]</>}
          </p>
        </div>
      )}
    </div>
  );
}

/** Every row a finding holds. One row renders as it always has; several render as a numbered list
 *  of the same rendering, in query order, a page at a time so a finding with thousands of rows stays
 *  readable. Shared by the explorer detail and Run History so a
 *  finding shows the same rows whichever tab it is opened from. */
export function FindingRowsDetail({ finding }: { finding: { evidence?: FindingRow | null; rows?: FindingRow[] | null } }) {
  const [page, setPage] = useState(1);
  const rows = findingRows(finding);
  if (rows.length <= 1) return <RowEvidence row={rows[0] ?? {}} />;
  const shown = pageFindingRows(rows, page);
  return (
    <div className="space-y-6">
      <ol className="space-y-6">
        {shown.rows.map((row, i) => (
          <li key={shown.firstIndex + i}>
            <p className="label-grid mb-2">Row {shown.firstIndex + i + 1} of {shown.total}</p>
            <RowEvidence row={row} />
          </li>
        ))}
      </ol>
      <FindingsPager page={shown.page} pageCount={shown.pageCount} onPage={setPage} />
    </div>
  );
}
