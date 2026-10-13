/**
 * #272: a scoped person is narrowed on the path a view takes before the upgrade's copy into finding_rows
 * has been proven too (see finding-views-fallback.test.ts). Every reader there takes a separate branch that
 * reads the old row columns whole, so the narrowing is checked on each of them, over the access matrix's data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { findingRows as findingRowsTable } from '@/lib/db/tables';
import { FINDING_ROWS_COPY_MARKER } from '@/lib/db/finding-rows-copy';
import { openExport, queryColumnValues, queryFindingRows, queryGroup, queryView } from '@/lib/db/finding-views';
import { deleteMeta } from '@/lib/db/meta';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { emptyView } from '@/lib/finding-view';
import { streamExport } from '@/lib/export-stream';
import { resetDb } from '../helpers/db';
import { SCOPE_DIRECTORY, SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, seedMatrix, type MatrixSeed } from '../helpers/access-matrix';

const QUERY = { tab: 'results', showSuppressed: false } as const;

const accessAt = (...paths: string[]): Access =>
  buildAccess(paths.map(path => ({ tenantId: '', scope: parseScope(path)!, role: 'viewer' as const })), 'manual');

let seed: MatrixSeed;
const nameOf = (fingerprint: string) => Object.entries(seed.fingerprints).find(([, fp]) => fp === fingerprint)![0];

beforeAll(async () => {
  await resetDb();
  seed = await seedMatrix();
  // The rows table is emptied and its marker removed, so only the old row columns can answer.
  await execRun(db.delete(findingRowsTable));
  await deleteMeta(FINDING_ROWS_COPY_MARKER);
});

describe('before the copy into finding_rows has been proven, a scoped person is narrowed', () => {
  it('in the view: the list, the totals, the facets and the column options', async () => {
    const response = await queryView(emptyView(), QUERY, accessAt(SCOPE_SUBSCRIPTION));
    expect(response.items.map(i => i.finding.resourceName).sort()).toEqual(['subscription-level', 'vm-one']);
    expect(response.total).toBe(2);
    expect(response.tiles.total).toBe(2);
    expect(response.facets.subscription.map(f => [f.value, f.count])).toEqual([[expect.stringContaining('0a'), 2]]);
    expect(response.suppressedCount).toBe(1);
    // vm-other-sub's extra column sits in the rule's catalogue, but no finding this person sees returns it.
    expect(response.columns).toEqual(['zone']);
  });

  it('to nothing for a person who holds no Scope', async () => {
    const response = await queryView(emptyView(), QUERY, accessAt());
    expect([response.items, response.total, response.tiles.total, response.columns, response.suppressedCount]).toEqual([[], 0, 0, [], 0]);
  });

  it('in a group, a column\'s values, one finding\'s rows and an export', async () => {
    const access = accessAt(SCOPE_RESOURCE_GROUP);
    const grouped = { ...emptyView(), groupBy: ['category' as const] };
    const group = await queryGroup(grouped, { ...QUERY, groupPath: ['security'], groupPage: 1 }, access);
    expect(group.items.map(i => i.finding.resourceName)).toEqual(['vm-one']);

    const values = await queryColumnValues(emptyView(), { ...QUERY, column: 'row.zone' }, access);
    expect(values.values).toEqual([{ value: 'a', count: 1 }]);

    const own = await queryFindingRows(emptyView(), { ...QUERY, fingerprint: seed.fingerprints['vm-one']!, rowsPage: 1 }, access);
    expect(own).toMatchObject({ rowCount: 1 });
    expect(await queryFindingRows(emptyView(), { ...QUERY, fingerprint: seed.fingerprints['vm-other-sub']!, rowsPage: 1 }, access)).toBeNull();

    const body = await new Response(await streamExport(openExport(emptyView(), QUERY, access), 'json')).text();
    expect((JSON.parse(body) as { fingerprint: string }[]).map(f => nameOf(f.fingerprint))).toEqual(['vm-one']);
    expect(body).not.toContain('otherSubColumn');
  });

  it('to the Directory alone with the Directory Scope', async () => {
    const response = await queryView(emptyView(), QUERY, accessAt(SCOPE_DIRECTORY));
    expect(response.items.map(i => i.finding.resourceName)).toEqual(['directory-app']);
  });

  it('and leaves Everything with every finding and the rule\'s whole catalogue', async () => {
    const response = await queryView(emptyView(), QUERY, buildAccess([{ tenantId: '', scope: parseScope('/')!, role: 'viewer' }], 'manual'));
    expect(response.total).toBe(6);
    expect(response.columns).toEqual(['otherSubColumn', 'zone']);
  });
});
