/**
 * #387: the Scope filter on the Results, Advisories and Activity tabs (ADR 0015). A pick is matched by the
 * access filter's placement table and then intersected with the viewer's Access, so it only ever narrows.
 * Driven through the view reads the routes call (`queryView`, `queryGroup`, `queryColumnValues`,
 * `openExport`) over the access matrix's seed, written through the real write paths, with the management
 * group tree read by the real refresh from a fake reader. Every id is fake and no Azure is called.
 *
 * The seed (tests/helpers/access-matrix.ts), by tab. Results: vm-one (subscription one, rg-one), vm-two
 * (subscription one, rg-two, suppressed), vm-other-sub (subscription two, rg-one), subscription-level
 * (subscription one), management-group-level (at mg-example), directory-app and unplaceable-thing.
 * Advisories: advisory-one (subscription one) and advisory-other-sub (subscription two). Activity:
 * workspace-user (subscription one, rg-one). One more Results finding is added here, placed at a
 * management group the stored tree does not know.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import {
  MANAGEMENT_GROUP, MATRIX_TENANT, SCOPE_DIRECTORY, SCOPE_MANAGEMENT_GROUP, SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, SUB_ONE, SUB_TWO,
  matrixHierarchy, seedMatrix, type MatrixSeed,
} from '../helpers/access-matrix';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { expandManagementGroups } from '@/lib/management-group-tree';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { findingRows as findingRowsTable } from '@/lib/db/tables';
import { FINDING_ROWS_COPY_MARKER } from '@/lib/db/finding-rows-copy';
import { deleteMeta } from '@/lib/db/meta';
import { openExport, queryColumnValues, queryGroup, queryView } from '@/lib/db/finding-views';
import { streamExport } from '@/lib/export-stream';
import { emptyView, type View } from '@/lib/finding-view';
import type { ViewTab } from '@/lib/view-response';
import { EVERYTHING_ACCESS } from '../helpers/access';

const armFetch = vi.fn(() => Promise.reject(new Error('the Scope filter must not call Azure')));
vi.mock('@/lib/arm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/arm')>('@/lib/arm');
  return { ...actual, armFetch: (...args: unknown[]) => (armFetch as (...a: unknown[]) => unknown)(...args) };
});

const UNKNOWN_GROUP = 'mg-unknown';
const groupPath = (id: string) => `/providers/Microsoft.Management/managementGroups/${id}`;
const RG_TWO_IN_ONE = `/subscriptions/${SUB_ONE}/resourceGroups/rg-two`;
const SUB_TWO_PATH = `/subscriptions/${SUB_TWO}`;
const nodes = matrixHierarchy().nodes;

/** The Access of someone who holds these Scopes as a Viewer, a group expanded against the seed's tree. */
function accessAt(...paths: string[]): Access {
  const grants = paths.map(path => ({ tenantId: MATRIX_TENANT, scope: parseScope(path)!, role: 'viewer' as const }));
  return buildAccess(grants, 'manual', expandManagementGroups(grants, nodes));
}

let seed: MatrixSeed;
const nameOf = (fingerprint: string) => Object.entries(seed.fingerprints).find(([, fp]) => fp === fingerprint)?.[0] ?? fingerprint;

beforeAll(async () => {
  await resetDb();
  seed = await seedMatrix();
  await storeScan([
    syntheticFinding('unknown-group-level', [{ zone: 'a' }], { ruleId: 'matrix-rule', category: 'security', placement: 'management-group', managementGroupId: UNKNOWN_GROUP }),
  ], { scanId: 'unknown-group-scan', finishedAt: '2026-06-03T00:00:00.000Z', ranRuleIds: ['unknown-group-rule'] });
  seed.fingerprints['unknown-group-level'] = (await queryView(emptyView(), { tab: 'results', showSuppressed: true }, EVERYTHING_ACCESS))
    .items.find(i => i.finding.resourceName === 'unknown-group-level')!.finding.fingerprint;
});

const withScope = (scope: string[] | undefined, extra: Partial<View> = {}): View => ({ ...emptyView(), ...(scope ? { scope } : {}), ...extra });
const read = (view: View, access: Access = EVERYTHING_ACCESS, tab: ViewTab = 'results') => queryView(view, { tab, showSuppressed: true }, access);
const listed = async (scope: string[] | undefined, access: Access = EVERYTHING_ACCESS, tab: ViewTab = 'results') =>
  (await read(withScope(scope), access, tab)).items.map(i => i.finding.resourceName ?? i.finding.dimensionKey).sort();

describe('a Scope pick matches the access filter\'s placement table', () => {
  it('a subscription matches the findings placed in it, and not the one at its group', async () => {
    expect(await listed([SCOPE_SUBSCRIPTION])).toEqual(['subscription-level', 'vm-one', 'vm-two']);
  });

  it('matches ids and the path keywords whatever their case', async () => {
    expect(await listed([`/SUBSCRIPTIONS/${SUB_ONE.toUpperCase()}`])).toEqual(['subscription-level', 'vm-one', 'vm-two']);
    expect(await listed([`/subscriptions/${SUB_ONE.toUpperCase()}/RESOURCEGROUPS/RG-ONE`])).toEqual(['vm-one']);
    expect(await listed(['@DIRECTORY'])).toEqual(['directory-app']);
    expect(await listed([groupPath(MANAGEMENT_GROUP.toUpperCase())])).toEqual(
      ['management-group-level', 'subscription-level', 'vm-one', 'vm-other-sub', 'vm-two'],
    );
  });

  it('a resource group matches the findings placed in it inside its own subscription only', async () => {
    // rg-one also exists in subscription two, where vm-other-sub sits.
    expect(await listed([SCOPE_RESOURCE_GROUP])).toEqual(['vm-one']);
    expect(await listed([RG_TWO_IN_ONE])).toEqual(['vm-two']);
  });

  it('a management group matches what is placed at it and the subscriptions under it', async () => {
    expect(await listed([SCOPE_MANAGEMENT_GROUP])).toEqual(
      ['management-group-level', 'subscription-level', 'vm-one', 'vm-other-sub', 'vm-two'],
    );
  });

  it('the Directory matches the findings placed in it', async () => {
    expect(await listed([SCOPE_DIRECTORY])).toEqual(['directory-app']);
  });

  it('several picks are any-of', async () => {
    expect(await listed([SCOPE_DIRECTORY, SUB_TWO_PATH])).toEqual(['directory-app', 'vm-other-sub']);
  });

  it('a pick of a management group the stored tree does not know still matches the findings placed at that id', async () => {
    expect(await listed([groupPath(UNKNOWN_GROUP)])).toEqual(['unknown-group-level']);
    expect(await listed([groupPath(UNKNOWN_GROUP.toUpperCase())])).toEqual(['unknown-group-level']);
  });

  it('matches nothing for a path that is no Scope, and Everything is never a pick', async () => {
    expect(await listed(['/'])).toEqual([]);
    expect(await listed([`${SCOPE_SUBSCRIPTION}/resourceGroups/rg-one/providers/Microsoft.Compute/virtualMachines/vm-one`])).toEqual([]);
    expect(await listed(['not a scope'])).toEqual([]);
  });

  it('no pick means everything held, and an empty list is Any', async () => {
    const all = await listed(undefined);
    expect(all).toHaveLength(8);
    expect(await listed([])).toEqual(all);
  });

  it('reads the Advisories and Activity tabs the same way', async () => {
    expect(await listed([SCOPE_SUBSCRIPTION], EVERYTHING_ACCESS, 'advisories')).toEqual(['advisory-one']);
    expect(await listed([SUB_TWO_PATH], EVERYTHING_ACCESS, 'advisories')).toEqual(['advisory-other-sub']);
    expect(await listed([SCOPE_RESOURCE_GROUP], EVERYTHING_ACCESS, 'activity')).toEqual(['workspace-user']);
    expect(await listed([SUB_TWO_PATH], EVERYTHING_ACCESS, 'activity')).toEqual([]);
  });

  it('narrows the totals, the tiles and the facets with the list', async () => {
    const response = await read(withScope([SUB_TWO_PATH]));
    expect(response.total).toBe(1);
    expect(response.tiles.total).toBe(1);
    expect(response.facets.subscription.map(f => f.value)).toEqual([SUB_TWO]);
    expect(response.ruleRows.map(r => [r.ruleId, r.open])).toEqual([['matrix-rule', 1]]);
  });

  it('applies together with the category, severity, rule and legacy subscription filters', async () => {
    const view = withScope([SCOPE_MANAGEMENT_GROUP], { filters: [{ field: 'subscription', values: [SUB_TWO] }, { field: 'category', values: ['security'] }] });
    expect((await read(view)).items.map(i => i.finding.resourceName)).toEqual(['vm-other-sub']);
    const none = withScope([SCOPE_DIRECTORY], { filters: [{ field: 'subscription', values: [SUB_TWO] }] });
    expect((await read(none)).items).toEqual([]);
  });

  it('never calls Azure', () => {
    expect(armFetch).not.toHaveBeenCalled();
  });
});

describe('the pick is intersected with the viewer\'s Access, so it never widens it', () => {
  it('a subscription holder who picks the group sees only their subscription', async () => {
    const access = accessAt(SCOPE_SUBSCRIPTION);
    expect(await listed([SCOPE_MANAGEMENT_GROUP], access)).toEqual(['subscription-level', 'vm-one', 'vm-two']);
    expect(await listed(undefined, access)).toEqual(['subscription-level', 'vm-one', 'vm-two']);
  });

  it('sees nothing of a subscription they do not hold, or of a Directory they do not hold', async () => {
    const access = accessAt(SCOPE_SUBSCRIPTION);
    expect(await listed([SUB_TWO_PATH], access)).toEqual([]);
    expect(await listed([SCOPE_DIRECTORY], access)).toEqual([]);
    expect(await listed([groupPath(UNKNOWN_GROUP)], access)).toEqual([]);
  });

  it('a resource group holder who picks the whole subscription is narrowed to the group', async () => {
    const access = accessAt(SCOPE_RESOURCE_GROUP);
    expect(await listed([SCOPE_SUBSCRIPTION], access)).toEqual(['vm-one']);
    expect(await listed([RG_TWO_IN_ONE], access)).toEqual([]);
  });

  it('a group holder who picks a subscription under it sees that subscription', async () => {
    const access = accessAt(SCOPE_MANAGEMENT_GROUP);
    expect(await listed([SUB_TWO_PATH], access)).toEqual(['vm-other-sub']);
    expect(await listed([SCOPE_DIRECTORY], access)).toEqual([]);
  });

  it('the Directory holder who picks the group sees nothing, and holding nothing sees nothing', async () => {
    expect(await listed([SCOPE_MANAGEMENT_GROUP], accessAt(SCOPE_DIRECTORY))).toEqual([]);
    expect(await listed([SCOPE_DIRECTORY], accessAt(SCOPE_DIRECTORY))).toEqual(['directory-app']);
    expect(await listed([SCOPE_SUBSCRIPTION], accessAt())).toEqual([]);
  });

  it('applies to the group, column values and export reads as well', async () => {
    const access = accessAt(SCOPE_SUBSCRIPTION);
    const view = withScope([SCOPE_MANAGEMENT_GROUP], { groupBy: ['category'] });
    const opened = await queryGroup(view, { tab: 'results', showSuppressed: true, groupPath: ['security'], groupPage: 1 }, access);
    expect(opened.items.map(i => i.finding.resourceName).sort()).toEqual(['subscription-level', 'vm-one', 'vm-two']);

    const values = await queryColumnValues(withScope([SUB_TWO_PATH]), { tab: 'results', showSuppressed: true, column: 'row.otherSubColumn' }, EVERYTHING_ACCESS);
    expect(values.values).toEqual([{ value: 'x', count: 1 }]);
    expect((await queryColumnValues(withScope([SCOPE_SUBSCRIPTION]), { tab: 'results', showSuppressed: true, column: 'row.otherSubColumn' }, EVERYTHING_ACCESS)).values).toEqual([]);

    const body = await new Response(await streamExport(openExport(withScope([SCOPE_MANAGEMENT_GROUP]), { tab: 'results', showSuppressed: true }, access), 'json')).text();
    expect((JSON.parse(body) as { fingerprint: string }[]).map(f => nameOf(f.fingerprint)).sort()).toEqual(['subscription-level', 'vm-one', 'vm-two']);
  });
});

describe('each pick says how it sits against the viewer\'s Access', () => {
  const states = async (scope: string[], access: Access) => (await read(withScope(scope), access)).filterStates.scope;

  it('Everything sees every pick named', async () => {
    expect(await states([SCOPE_SUBSCRIPTION, SCOPE_MANAGEMENT_GROUP, SCOPE_DIRECTORY, SCOPE_RESOURCE_GROUP, groupPath(UNKNOWN_GROUP)], EVERYTHING_ACCESS)).toEqual([
      { value: SCOPE_SUBSCRIPTION, access: 'held', label: 'Subscription one' },
      { value: SCOPE_MANAGEMENT_GROUP, access: 'held', label: 'Example group' },
      { value: SCOPE_DIRECTORY, access: 'held', label: 'Directory' },
      { value: SCOPE_RESOURCE_GROUP, access: 'held', label: 'rg-one in Subscription one' },
      { value: groupPath(UNKNOWN_GROUP), access: 'held', label: UNKNOWN_GROUP },
    ]);
  });

  it('a held pick is named, one with no held part is outside and never named', async () => {
    expect(await states([SCOPE_SUBSCRIPTION, SCOPE_RESOURCE_GROUP, SUB_TWO_PATH, SCOPE_DIRECTORY], accessAt(SCOPE_SUBSCRIPTION))).toEqual([
      { value: SCOPE_SUBSCRIPTION, access: 'held', label: 'Subscription one' },
      { value: SCOPE_RESOURCE_GROUP, access: 'held', label: 'rg-one in Subscription one' },
      { value: SUB_TWO_PATH, access: 'outside', label: null },
      { value: SCOPE_DIRECTORY, access: 'outside', label: null },
    ]);
  });

  it('a subscription held in part stays named and says it is narrowed', async () => {
    expect(await states([SCOPE_SUBSCRIPTION], accessAt(SCOPE_RESOURCE_GROUP))).toEqual([
      { value: SCOPE_SUBSCRIPTION, access: 'narrowed', label: 'Subscription one' },
    ]);
  });

  it('a management group held in part is not named, and says it is narrowed', async () => {
    expect(await states([SCOPE_MANAGEMENT_GROUP], accessAt(SCOPE_SUBSCRIPTION))).toEqual([
      { value: SCOPE_MANAGEMENT_GROUP, access: 'outside-narrowed', label: null },
    ]);
    expect(await states([SCOPE_MANAGEMENT_GROUP], accessAt(SCOPE_RESOURCE_GROUP))).toEqual([
      { value: SCOPE_MANAGEMENT_GROUP, access: 'outside-narrowed', label: null },
    ]);
  });

  it('a management group held whole is named, and so is a subscription under it', async () => {
    expect(await states([SCOPE_MANAGEMENT_GROUP, SCOPE_SUBSCRIPTION], accessAt(SCOPE_MANAGEMENT_GROUP))).toEqual([
      { value: SCOPE_MANAGEMENT_GROUP, access: 'held', label: 'Example group' },
      { value: SCOPE_SUBSCRIPTION, access: 'held', label: 'Subscription one' },
    ]);
  });

  it('a person who holds nothing has every pick outside', async () => {
    expect((await states([SCOPE_SUBSCRIPTION, SCOPE_DIRECTORY], accessAt())).map(s => s.access)).toEqual(['outside', 'outside']);
  });

  it('is empty when the view has no Scope filter', async () => {
    expect(await states([], EVERYTHING_ACCESS)).toEqual([]);
    expect((await read(withScope(undefined))).filterStates.scope).toEqual([]);
  });

  it('says a Scope set the server cannot open is unresolved, and matches nothing rather than everything', async () => {
    const response = await read({ ...emptyView(), scopeSet: 'a'.repeat(64) });
    expect(response.filterStates.scopeUnresolved).toBe(true);
    expect(response.items).toEqual([]);
    expect((await read(withScope([SCOPE_SUBSCRIPTION]))).filterStates.scopeUnresolved).toBe(false);
  });
});

describe('before the copy into finding_rows has been proven', () => {
  beforeAll(async () => {
    await execRun(db.delete(findingRowsTable));
    await deleteMeta(FINDING_ROWS_COPY_MARKER);
  });

  it('the Scope filter narrows the whole-finding reads too', async () => {
    expect(await listed([SCOPE_RESOURCE_GROUP])).toEqual(['vm-one']);
    expect(await listed([SCOPE_MANAGEMENT_GROUP], accessAt(SCOPE_SUBSCRIPTION))).toEqual(['subscription-level', 'vm-one', 'vm-two']);
    const response = await read(withScope([SUB_TWO_PATH]));
    expect([response.total, response.filterStates.scope.map(s => s.access)]).toEqual([1, ['held']]);
  });
});
