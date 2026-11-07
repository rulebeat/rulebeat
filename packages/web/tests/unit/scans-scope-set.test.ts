/**
 * #388: a long Scope list travels as `scopeset=<sha256>` (ADR 0016) and only the server opens it. Driven through
 * the view reads the routes call, over the access matrix's seed, on whichever backend the suite opened (the SQLite
 * run and the Postgres run, RULEBEAT_TEST_PG_URL, read the same). A set the server can open filters like the same
 * list written inline; one it cannot open is an unresolved Scope filter that matches nothing, never no filter.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { MATRIX_TENANT, SCOPE_DIRECTORY, SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, SUB_TWO, matrixHierarchy, seedMatrix } from '../helpers/access-matrix';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { expandManagementGroups } from '@/lib/management-group-tree';
import { createScopeSet } from '@/lib/db/scope-sets';
import { openExport, queryColumnValues, queryGroup, queryView } from '@/lib/db/finding-views';
import { streamExport } from '@/lib/export-stream';
import { emptyView, type View } from '@/lib/finding-view';
import { scopeSetHash } from '@/lib/scope-sets';
import type { ViewTab } from '@/lib/view-response';
import { EVERYTHING_ACCESS } from '../helpers/access';

const SUB_TWO_PATH = `/subscriptions/${SUB_TWO}`;
const nodes = matrixHierarchy().nodes;

function accessAt(...paths: string[]): Access {
  const grants = paths.map(path => ({ tenantId: MATRIX_TENANT, scope: parseScope(path)!, role: 'viewer' as const }));
  return buildAccess(grants, 'manual', expandManagementGroups(grants, nodes));
}

const UNKNOWN_SET = 'a'.repeat(64);

beforeAll(async () => {
  await resetDb();
  await seedMatrix();
});

const read = (view: View, access: Access = EVERYTHING_ACCESS, tab: ViewTab = 'results') => queryView(view, { tab, showSuppressed: true }, access);
const listed = async (view: View, access: Access = EVERYTHING_ACCESS) =>
  (await read(view, access)).items.map(i => i.finding.resourceName ?? i.finding.dimensionKey).sort();
const withSet = (hash: string, extra: Partial<View> = {}): View => ({ ...emptyView(), scopeSet: hash, ...extra });

describe('a Scope set the server holds is opened on the server and filters like the same list inline', () => {
  it('matches what the inline list matches', async () => {
    const paths = [SCOPE_RESOURCE_GROUP, SUB_TWO_PATH, SCOPE_DIRECTORY];
    const { hash } = await createScopeSet(paths);
    expect(await listed(withSet(hash))).toEqual(await listed({ ...emptyView(), scope: paths }));
    expect(await listed(withSet(hash))).toEqual(['directory-app', 'vm-one', 'vm-other-sub']);
  });

  it('names each pick of the set in the filter states, so the picker can show them', async () => {
    const { hash } = await createScopeSet([SCOPE_SUBSCRIPTION, SUB_TWO_PATH]);
    const response = await read(withSet(hash));
    expect(response.filterStates.scopeUnresolved).toBe(false);
    expect(response.filterStates.scope).toEqual([
      { value: SCOPE_SUBSCRIPTION, access: 'held', label: 'Subscription one' },
      { value: SUB_TWO_PATH, access: 'held', label: 'Subscription two' },
    ]);
  });

  it('opens the set under the viewer\'s own Access, so it never widens it', async () => {
    const { hash } = await createScopeSet([SCOPE_SUBSCRIPTION, SUB_TWO_PATH, SCOPE_DIRECTORY]);
    const access = accessAt(SCOPE_SUBSCRIPTION);
    expect(await listed(withSet(hash), access)).toEqual(['subscription-level', 'vm-one', 'vm-two']);
    const states = (await read(withSet(hash), access)).filterStates.scope;
    expect(states.map(s => [s.value, s.access])).toEqual([[SCOPE_SUBSCRIPTION, 'held'], [SUB_TWO_PATH, 'outside'], [SCOPE_DIRECTORY, 'outside']]);
  });

  it('is the same set whatever the case of the hash in the address', async () => {
    const { hash } = await createScopeSet([SUB_TWO_PATH]);
    expect(await listed(withSet(hash.toUpperCase()))).toEqual(['vm-other-sub']);
  });

  it('applies to the group, column values and export reads as well', async () => {
    const { hash } = await createScopeSet([SUB_TWO_PATH]);
    const grouped = await queryGroup(withSet(hash, { groupBy: ['category'] }), { tab: 'results', showSuppressed: true, groupPath: ['security'], groupPage: 1 }, EVERYTHING_ACCESS);
    expect(grouped.items.map(i => i.finding.resourceName)).toEqual(['vm-other-sub']);
    const values = await queryColumnValues(withSet(hash), { tab: 'results', showSuppressed: true, column: 'row.otherSubColumn' }, EVERYTHING_ACCESS);
    expect(values.values).toEqual([{ value: 'x', count: 1 }]);
    const body = await new Response(await streamExport(openExport(withSet(hash), { tab: 'results', showSuppressed: true }, EVERYTHING_ACCESS), 'json')).text();
    expect(JSON.parse(body) as unknown[]).toHaveLength(1);
  });
});

describe('a Scope set the server cannot open is an unresolved Scope filter', () => {
  it('matches nothing, where no Scope filter would match everything', async () => {
    const everything = await listed(emptyView());
    expect(everything.length).toBeGreaterThan(0);
    const response = await read(withSet(UNKNOWN_SET));
    expect(response.items).toEqual([]);
    expect(response.total).toBe(0);
    expect(response.filterStates.scopeUnresolved).toBe(true);
    expect(response.filterStates.scope).toEqual([]);
  });

  it('is unresolved for a hash that is a well-formed sha256 no row holds', async () => {
    const unwritten = scopeSetHash(['/subscriptions/00000000-0000-0000-0000-0000000000ee']);
    expect((await read(withSet(unwritten))).filterStates.scopeUnresolved).toBe(true);
  });

  it('is unresolved for text that is not a hash, on every tab', async () => {
    for (const tab of ['results', 'advisories', 'activity'] as const) {
      const response = await read(withSet('nothex'), EVERYTHING_ACCESS, tab);
      expect([tab, response.total, response.filterStates.scopeUnresolved]).toEqual([tab, 0, true]);
    }
  });

  it('matches nothing in the group, column values and export reads', async () => {
    const view = withSet(UNKNOWN_SET, { groupBy: ['category'] });
    expect((await queryGroup(view, { tab: 'results', showSuppressed: true, groupPath: ['security'], groupPage: 1 }, EVERYTHING_ACCESS)).items).toEqual([]);
    expect((await queryColumnValues(withSet(UNKNOWN_SET), { tab: 'results', showSuppressed: true, column: 'row.zone' }, EVERYTHING_ACCESS)).values).toEqual([]);
    const body = await new Response(await streamExport(openExport(withSet(UNKNOWN_SET), { tab: 'results', showSuppressed: true }, EVERYTHING_ACCESS), 'json')).text();
    expect(JSON.parse(body) as unknown[]).toEqual([]);
  });
});
