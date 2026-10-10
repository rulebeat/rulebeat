/**
 * ADR 0007: until the upgrade's copy into finding_rows has been proven (its marker in
 * `meta`), the old row columns are where a finding's rows are read from, exactly as listFindings()
 * does. The view module reads the marker inside its own transaction, so it follows: with the marker
 * absent every answer comes from the old columns, and once it is there, from finding_rows.
 *
 * finding_rows is emptied here after the scan, so which of the two a read used shows in what it holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { findingRows as findingRowsTable, findings as findingsTable, rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { FINDING_ROWS_COPY_MARKER } from '@/lib/db/finding-rows-copy';
import { queryColumnValues, queryFindingRows, queryGroup, queryView } from '@/lib/db/finding-views';
import { deleteMeta, getMeta, setMeta } from '@/lib/db/meta';
import { emptyView, type View, type ViewFilter } from '@/lib/finding-view';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb } from '../helpers/db';
import { argRow, fakeTenantContext } from '../helpers/fake-azure';

const RULE = 'fallback-rule';
const QUERY = { tab: 'results', showSuppressed: false } as const;
const make = (patch: Partial<View> = {}): View => ({ ...emptyView(), ...patch });
const f = (field: ViewFilter['field'], ...values: string[]): ViewFilter => ({ field, values } as ViewFilter);

let oneFingerprint = '';
let marker = '';

beforeAll(async () => {
  await resetDb();
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, RULE)));
  await execRun(db.insert(rulesTable).values({
    id: RULE, name: 'Fallback rule', description: 'test rule', category: 'security', severity: 'high', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: '[]', conditions: '[]', type: 'custom',
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
  }));
  await runCategoryScan((await getCategory('security'))!, {
    ctx: fakeTenantContext({ rows: [
      argRow({ name: 'vm-one', zone: 'a' }), argRow({ name: 'vm-one', zone: 'b' }), argRow({ name: 'vm-two', zone: 'a' }),
    ] }),
    ruleIds: [RULE], now: new Date(),
  });
  const found = await queryView(make({ filters: [f('resourceName', 'vm-one')] }), QUERY);
  oneFingerprint = found.items[0]!.finding.fingerprint;
  marker = (await getMeta(FINDING_ROWS_COPY_MARKER))!;
});

describe('a finding stored without its row count', () => {
  beforeAll(async () => { await execRun(db.update(findingsTable).set({ rowCount: null }).where(eq(findingsTable.fingerprint, oneFingerprint))); });
  afterAll(async () => { await execRun(db.update(findingsTable).set({ rowCount: 2 }).where(eq(findingsTable.fingerprint, oneFingerprint))); });

  it('is counted from its rows', async () => {
    const response = await queryView(make({ filters: [f('resourceName', 'vm-one')] }), QUERY);
    expect(response.items.map(i => [i.rowCount, i.matchedRowCount, i.rows.map(r => r.zone)])).toEqual([[2, 2, ['a', 'b']]]);
  });
});

describe('before the copy into finding_rows has been proven', () => {
  beforeAll(async () => {
    // What the scan stored in finding_rows is gone, so only the old columns still hold the rows.
    await execRun(db.delete(findingRowsTable));
    await deleteMeta(FINDING_ROWS_COPY_MARKER);
  });

  it('reads each finding\'s rows from the old columns, and counts them', async () => {
    const response = await queryView(make({ sort: { field: 'resourceName', dir: 'asc' } }), QUERY);
    expect(response.items.map(i => [i.finding.resourceName, i.rowCount, i.rows.map(r => r.zone)])).toEqual([
      ['vm-one', 2, ['a', 'b']],
      ['vm-two', 1, ['a']],
    ]);
  });

  it('filters on a returned column over them', async () => {
    const response = await queryView(make({ filters: [f('row.zone', 'b')] }), QUERY);
    expect(response.items.map(i => [i.finding.resourceName, i.rowCount, i.matchedRowCount])).toEqual([['vm-one', 2, 1]]);
    // The column list is the catalogue's, written at the scan, so emptying finding_rows leaves it be.
    expect(response.columns).toEqual(['zone']);
  });

  it('answers one finding\'s rows, a group, and a column\'s values from them', async () => {
    const rows = await queryFindingRows(make(), { ...QUERY, fingerprint: oneFingerprint, rowsPage: 1 });
    expect(rows).toMatchObject({ rowCount: 2, matchedRowCount: 2, rows: [expect.objectContaining({ zone: 'a' }), expect.objectContaining({ zone: 'b' })] });

    const group = await queryGroup(make({ groupBy: ['row.zone'] }), { ...QUERY, groupPath: ['a'], groupPage: 1 });
    expect(group.items.map(i => i.finding.resourceName).sort()).toEqual(['vm-one', 'vm-two']);

    const values = await queryColumnValues(make(), { ...QUERY, column: 'row.zone' });
    expect(values.values).toEqual([{ value: 'a', count: 2 }, { value: 'b', count: 1 }]);
  });
});

describe('once the copy has been proven', () => {
  beforeAll(async () => { await setMeta(FINDING_ROWS_COPY_MARKER, marker); });

  it('reads the rows from finding_rows, which here holds none', async () => {
    const response = await queryView(make({ sort: { field: 'resourceName', dir: 'asc' } }), QUERY);
    expect(response.items.map(i => [i.finding.resourceName, i.rowCount, i.rows.length])).toEqual([['vm-one', 2, 0], ['vm-two', 1, 0]]);
    const values = await queryColumnValues(make(), { ...QUERY, column: 'row.zone' });
    expect(values.values).toEqual([]);
  });
});
