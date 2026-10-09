/**
 * ADR 0007: one page of a finding's rows costs one page of reads. With no filter on a returned
 * column, the rows route reads the finding's stored row count and the 20 rows of the page asked for,
 * not the finding's whole row set. The rows outside the page are made unreadable here, so a read of
 * the whole set throws, and the answer must still be what the reference gives over the whole set.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, gte, lt, or } from 'drizzle-orm';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { findingRows as findingRowsTable, findings as findingsTable } from '@/lib/db/tables';
import { queryFindingRows } from '@/lib/db/finding-views';
import { emptyView, rowField, type View } from '@/lib/finding-view';
import { pageBounds, pageFindingRows } from '@/lib/finding-rows';

const RULE = 'page-read-rule';
const NAME = 'vm-page-read';
const ROWS = Array.from({ length: 45 }, (_, i) => ({ n: i, parity: i % 2 === 0 ? 'even' : 'odd' }));
const FINGERPRINT = syntheticFinding(NAME, ROWS, { ruleId: RULE }).fingerprint;

beforeEach(async () => {
  await resetDb();
  await storeScan([syntheticFinding(NAME, ROWS, { ruleId: RULE })], { scanId: 'page-read-scan', finishedAt: new Date().toISOString() });
});

const ask = (rowsPage: number, view: View = emptyView()) =>
  queryFindingRows(view, { tab: 'results', showSuppressed: false, fingerprint: FINGERPRINT, rowsPage });

/** Makes the stored rows outside [from, to) unreadable, so a read that parses one throws. */
async function corruptRowsOutside(from: number, to: number): Promise<void> {
  await execRun(db.update(findingRowsTable).set({ data: '{not json' }).where(and(
    eq(findingRowsTable.fingerprint, FINGERPRINT),
    or(lt(findingRowsTable.position, from), gte(findingRowsTable.position, to)),
  )));
}

describe('one page of a finding\'s rows, with no filter on a returned column', () => {
  it.each([
    [1, 0, 20],
    [2, 20, 40],
    [3, 40, 45],
  ])('reads only page %i, rows %i to %i, of the stored rows', async (page, from, to) => {
    await corruptRowsOutside(from, to);
    const response = await ask(page);
    expect(response).toEqual({
      fingerprint: FINGERPRINT, rows: ROWS.slice(from, to), page, pageCount: 3, matchedRowCount: 45, rowCount: 45, firstIndex: from,
    });
  });

  it('clamps a page past the end to the last page and reads only that one', async () => {
    await corruptRowsOutside(40, 45);
    const response = await ask(9);
    expect(response?.page).toBe(3);
    expect(response?.rows).toEqual(ROWS.slice(40));
    expect(response?.firstIndex).toBe(40);
  });

  it('counts the rows from the rows table for a finding stored before its count was', async () => {
    await execRun(db.update(findingsTable).set({ rowCount: null }).where(eq(findingsTable.fingerprint, FINGERPRINT)));
    await corruptRowsOutside(20, 40);
    const response = await ask(2);
    expect(response?.rowCount).toBe(45);
    expect(response?.pageCount).toBe(3);
    expect(response?.rows).toEqual(ROWS.slice(20, 40));
  });

  it('answers a finding with no rows as one empty page', async () => {
    await storeScan([syntheticFinding('vm-no-rows', [], { ruleId: RULE })], { scanId: 'page-read-empty', finishedAt: new Date().toISOString() });
    const empty = syntheticFinding('vm-no-rows', [], { ruleId: RULE });
    const response = await queryFindingRows(emptyView(), { tab: 'results', showSuppressed: false, fingerprint: empty.fingerprint, rowsPage: 1 });
    expect(response).toEqual({ fingerprint: empty.fingerprint, rows: [], page: 1, pageCount: 1, matchedRowCount: 0, rowCount: 0, firstIndex: 0 });
  });

  it('is what the reference answers over the whole set, page by page', async () => {
    for (const page of [1, 2, 3, 4]) {
      const expected = pageFindingRows(ROWS, page);
      const response = await ask(page);
      expect(response).toMatchObject({
        rows: expected.rows, page: expected.page, pageCount: expected.pageCount, matchedRowCount: 45, firstIndex: expected.firstIndex,
      });
    }
  });

  it('still reads the whole set when a returned column is filtered, since the count of matches needs it', async () => {
    const view: View = { ...emptyView(), filters: [{ field: rowField('parity'), values: ['even'] }] };
    const response = await ask(1, view);
    expect(response?.matchedRowCount).toBe(23);
    expect(response?.rowCount).toBe(45);
    expect(response?.rows.map(r => r.n)).toEqual(ROWS.filter(r => r.parity === 'even').slice(0, 20).map(r => r.n));
    await corruptRowsOutside(0, 1);
    await expect(ask(1, view)).rejects.toThrow();
  });
});

describe('the paging arithmetic both reads share', () => {
  it.each([
    [0, 1, { page: 1, pageCount: 1, firstIndex: 0 }],
    [20, 1, { page: 1, pageCount: 1, firstIndex: 0 }],
    [21, 2, { page: 2, pageCount: 2, firstIndex: 20 }],
    [45, 3, { page: 3, pageCount: 3, firstIndex: 40 }],
    [45, 99, { page: 3, pageCount: 3, firstIndex: 40 }],
    [45, 0, { page: 1, pageCount: 3, firstIndex: 0 }],
  ])('puts %i rows asked at page %i on %o', (total, page, expected) => {
    expect(pageBounds(total, page, 20)).toEqual(expected);
  });
});
