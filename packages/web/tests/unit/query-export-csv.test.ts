/**
 * The query-results export button's CSV text. Its column names come from the user's KQL query
 * result columns, so a column name can hold a comma, a quote, a newline or a leading formula
 * character; the header row must be guarded the same way a data cell is. Tested at the extracted
 * pure function rather than by rendering QueryExportButton (no React render layer here; see
 * tests/unit/trend-tooltip-label.test.ts for the same pattern).
 */
import { describe, expect, it } from 'vitest';
import { buildQueryCsv } from '@/components/query/query-export-button';

describe('buildQueryCsv', () => {
  it('guards a column name holding a comma, a quote, a newline, and a leading formula character', () => {
    const csv = buildQueryCsv([
      { 'a,b': 1, 'say "hi"': 2, 'one\ntwo': 3, '=SUM(A1)': 4 },
    ]);
    // Columns are sorted, so the quoted-newline column sits mid-header; a naive split('\n') on
    // the whole CSV would cut at that embedded newline, so compare the known header prefix.
    const expectedHeader = '\'=SUM(A1),"a,b","one\ntwo","say ""hi"""';
    expect(csv.startsWith(`${expectedHeader}\n`)).toBe(true);
  });
});
