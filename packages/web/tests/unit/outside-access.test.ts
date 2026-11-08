/**
 * Held-back values (#363): which stored filter values sit outside a person's Access, and how a dashboard or a
 * saved view comes back without them. Scope values are decided from the Access alone; a resourceName or
 * `row.*` value is decided by whether a finding inside the Access carries it, read once through the access
 * filter. The seeded matrix supplies the findings: `vm-one` (subscription one, `rg-one`, zone `a`), `vm-two`
 * (subscription one, `rg-two`, zone `b`, suppressed), `vm-other-sub` (subscription two, zone `a` and a column
 * `otherSubColumn` of `x` no other finding has) and the Directory, group and workspace findings.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { seedMatrix, SUB_ONE as MATRIX_SUB_ONE, SUB_TWO as MATRIX_SUB_TWO } from '../helpers/access-matrix';
import { buildAccess, everythingAccess, NO_ACCESS, parseScope, type Access } from '@/lib/access-model';
import { filterValues, viewFromSearchParams } from '@/lib/finding-view';
import { heldBackCount, heldBackNote, OUTSIDE_ACCESS_LABEL, onlyHeldBack, valuesWithoutPlaceholder, widgetHeldBackReason, type HeldBack } from '@/lib/held-back';
import {
  heldBackValues, holdBackDashboards, holdBackSavedViews, type StoredValues,
} from '@/lib/db/held-back';
import { deleteMeta, getMeta, setMeta } from '@/lib/db/meta';
import { FINDING_ROWS_COPY_MARKER } from '@/lib/db/finding-rows-copy';
import type { DashboardConfig } from '@/lib/types';

/** The SQL of every query run through `many`, so a test can count the selects made on the findings table. */
const statements = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/db/exec', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/db/exec')>();
  return {
    ...original,
    many: <T,>(query: { all(): T[] }) => {
      statements.push((query as unknown as { toSQL(): { sql: string } }).toSQL().sql);
      return original.many(query);
    },
  };
});
const findingsSelects = () => statements.filter(sql => /\bfrom "findings"/.test(sql)).length;

const SUB_ONE = MATRIX_SUB_ONE;
const SUB_TWO = MATRIX_SUB_TWO;
const SUB_THREE = '00000000-0000-0000-0000-00000000000c';
const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';

const holding = (paths: string[], expansion?: { groups: string[]; subscriptions: string[] }): Access =>
  buildAccess(
    paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })),
    'manual',
    expansion ? [{ tenantId: 't', path: GROUP, role: 'viewer', ...expansion }] : [],
  );

const stored = (dimension: string, ...values: string[]): StoredValues => ({ place: 'savedView', id: 'v', dimension, values });
const heldOf = async (access: Access, dimension: string, ...values: string[]) =>
  [...(await heldBackValues(access, [stored(dimension, ...values)])).get(dimension) ?? []];

beforeAll(async () => {
  await resetDb();
  await seedMatrix();
});

describe('Scope values', () => {
  it('holds nothing back for Everything, and does not read a finding to say so', async () => {
    const read = () => { throw new Error('Everything must not query'); };
    const held = await heldBackValues(
      everythingAccess('editor'),
      [stored('subscription', SUB_TWO, 'directory'), stored('resourceGroup', 'rg-x'), stored('resourceName', 'nothing-has-this'), stored('row.zone', 'q')],
      read,
    );
    expect(held.size).toBe(0);
  });

  it('holds back every subscription and resource group for a person who holds no Scope', async () => {
    expect(await heldOf(NO_ACCESS, 'subscription', SUB_ONE)).toEqual([SUB_ONE]);
    expect(await heldOf(NO_ACCESS, 'resourceGroup', 'rg-one')).toEqual(['rg-one']);
  });

  it('keeps a held subscription and holds back another', async () => {
    expect(await heldOf(holding([`/subscriptions/${SUB_ONE}`]), 'subscription', SUB_ONE, SUB_TWO)).toEqual([SUB_TWO]);
  });

  it('keeps a subscription that holds one of the person\'s resource groups (a Scope inside it)', async () => {
    const access = holding([`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]);
    expect(await heldOf(access, 'subscription', SUB_ONE, SUB_TWO)).toEqual([SUB_TWO]);
  });

  it('keeps a subscription under a management group at any depth, and holds back one outside it', async () => {
    const access = holding([GROUP], { groups: ['mg-example', 'mg-child'], subscriptions: [SUB_ONE, SUB_TWO] });
    expect(await heldOf(access, 'subscription', SUB_ONE, SUB_TWO, SUB_THREE)).toEqual([SUB_THREE]);
  });

  it('holds back a management group Scope the tree does not expand', async () => {
    expect(await heldOf(holding([GROUP]), 'subscription', SUB_ONE)).toEqual([SUB_ONE]);
  });

  it('holds back the reserved Directory value unless the person holds the Directory Scope', async () => {
    expect(await heldOf(holding([`/subscriptions/${SUB_ONE}`]), 'subscription', 'directory')).toEqual(['directory']);
    expect(await heldOf(holding(['@directory']), 'subscription', 'directory', 'DIRECTORY')).toEqual([]);
  });

  it('holds back a Directory-only person\'s subscription and resource group values', async () => {
    const access = holding(['@directory']);
    expect(await heldOf(access, 'subscription', SUB_ONE)).toEqual([SUB_ONE]);
    expect(await heldOf(access, 'resourceGroup', 'rg-one')).toEqual(['rg-one']);
  });

  it('holds back a resource group name unless the person holds a resource group Scope of that name', async () => {
    const access = holding([`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]);
    expect(await heldOf(access, 'resourceGroup', 'rg-one', 'rg-two')).toEqual(['rg-two']);
  });

  it('holds back no resource group name for a person who holds a whole subscription', async () => {
    expect(await heldOf(holding([`/subscriptions/${SUB_ONE}`]), 'resourceGroup', 'rg-one', 'rg-anything')).toEqual([]);
  });

  it('compares without regard to case and reports the value as it was stored', async () => {
    const access = holding([`/SUBSCRIPTIONS/${SUB_ONE.toUpperCase()}/RESOURCEGROUPS/RG-ONE`]);
    expect(await heldOf(access, 'subscription', SUB_ONE, SUB_TWO.toUpperCase())).toEqual([SUB_TWO.toUpperCase()]);
    expect(await heldOf(access, 'resourceGroup', 'Rg-One', 'Rg-Two')).toEqual(['Rg-Two']);
  });
});

describe('resourceName and row values', () => {
  const oneSubscription = holding([`/subscriptions/${SUB_ONE}`]);
  const oneGroup = holding([`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]);

  it('holds back a resource name no finding inside the Access carries', async () => {
    expect(await heldOf(oneSubscription, 'resourceName', 'vm-one', 'vm-other-sub', 'no-such-vm')).toEqual(['vm-other-sub', 'no-such-vm']);
  });

  it('counts a suppressed finding as carrying its name', async () => {
    expect(await heldOf(oneSubscription, 'resourceName', 'vm-two')).toEqual([]);
    expect(await heldOf(oneGroup, 'resourceName', 'vm-two')).toEqual(['vm-two']);
  });

  it('reads the name the Resource column shows, so an Activity finding\'s dimension key counts', async () => {
    expect(await heldOf(oneSubscription, 'resourceName', 'workspace-user')).toEqual([]);
    expect(await heldOf(holding(['@directory']), 'resourceName', 'workspace-user')).toEqual(['workspace-user']);
  });

  it('holds back a row value unless a finding inside the Access returned it', async () => {
    expect(await heldOf(oneSubscription, 'row.zone', 'a', 'b', 'c')).toEqual(['c']);
    expect(await heldOf(oneGroup, 'row.zone', 'a', 'b')).toEqual(['b']);
  });

  it('holds back a value only a finding outside the Access returned', async () => {
    expect(await heldOf(oneSubscription, 'row.otherSubColumn', 'x')).toEqual(['x']);
    expect(await heldOf(holding([`/subscriptions/${SUB_TWO}`]), 'row.otherSubColumn', 'x')).toEqual([]);
  });

  it('holds back everything for a person who holds no Scope', async () => {
    expect(await heldOf(NO_ACCESS, 'resourceName', 'vm-one')).toEqual(['vm-one']);
    expect(await heldOf(NO_ACCESS, 'row.zone', 'a')).toEqual(['a']);
  });

  it('reads findings once for every value asked about', async () => {
    let reads = 0;
    const read = async () => { reads++; return { names: new Set(['vm-one']), rows: new Map<string, Set<string>>() }; };
    await heldBackValues(oneSubscription, [stored('resourceName', 'a'), stored('row.zone', 'a'), stored('row.sku', 'b'), stored('resourceName', 'c')], read);
    expect(reads).toBe(1);
  });
});

describe('the findings query behind a request', () => {
  const oneSubscription = holding([`/subscriptions/${SUB_ONE}`]);
  const asked = [stored('resourceName', 'vm-one', 'vm-other-sub'), stored('row.zone', 'a'), stored('row.otherSubColumn', 'x')];
  beforeEach(() => { statements.length = 0; });

  it('selects from the findings table once when the rows are in finding_rows', async () => {
    const held = await heldBackValues(oneSubscription, asked);
    expect([...held.get('resourceName') ?? []]).toEqual(['vm-other-sub']);
    expect(findingsSelects()).toBe(1);
  });

  describe('before the copy into finding_rows has been proven', () => {
    let marker: string;
    beforeAll(async () => { marker = (await getMeta(FINDING_ROWS_COPY_MARKER))!; await deleteMeta(FINDING_ROWS_COPY_MARKER); });
    afterAll(async () => { await setMeta(FINDING_ROWS_COPY_MARKER, marker); });

    it('still selects from the findings table once, and reads the rows from the old columns', async () => {
      statements.length = 0;
      const held = await heldBackValues(oneSubscription, asked);
      expect([...held.get('row.otherSubColumn') ?? []]).toEqual(['x']);
      expect(held.has('row.zone')).toBe(false);
      expect(findingsSelects()).toBe(1);
    });
  });
});

describe('a saved view as the routes return it', () => {
  const oneSubscription = holding([`/subscriptions/${SUB_ONE}`]);
  const view = (query: string) => ({ id: 'view-1', name: 'n', tab: 'results' as const, query });

  it('omits held values from the filters and counts them per place and dimension', async () => {
    const query = `subscription=${SUB_ONE},${SUB_TWO}&f=resourceName%3Dvm-one%7Cvm-other-sub&rf=zone%3Da%7Cc&severity=high`;
    const [result] = await holdBackSavedViews(oneSubscription, [view(query)]);
    const { filters } = viewFromSearchParams(new URLSearchParams(result!.query));
    expect(filterValues(filters, 'subscription')).toEqual([SUB_ONE]);
    expect(filterValues(filters, 'resourceName')).toEqual(['vm-one']);
    expect(filterValues(filters, 'row.zone')).toEqual(['a']);
    expect(filterValues(filters, 'severity')).toEqual(['high']);
    expect(result!.heldBack).toEqual([
      { place: 'savedView', id: 'view-1', dimension: 'subscription', count: 1 },
      { place: 'savedView', id: 'view-1', dimension: 'resourceName', count: 1 },
      { place: 'savedView', id: 'view-1', dimension: 'row.zone', count: 1 },
    ]);
  });

  it('keeps a placeholder no finding carries for a filter whose values are all held back, and says how many', async () => {
    const [result] = await holdBackSavedViews(oneSubscription, [view(`subscription=${SUB_TWO},${SUB_THREE}`)]);
    expect(viewFromSearchParams(new URLSearchParams(result!.query)).filters).toEqual([{ field: 'subscription', values: [OUTSIDE_ACCESS_LABEL] }]);
    expect(result!.query).not.toContain(SUB_TWO);
    expect(result!.query).not.toContain(SUB_THREE);
    expect(result!.heldBack).toEqual([{ place: 'savedView', id: 'view-1', dimension: 'subscription', count: 2 }]);
  });

  it('returns the stored query unchanged, with no held values, when nothing is held back', async () => {
    const query = `subscription=${SUB_ONE}&severity=high`;
    expect(await holdBackSavedViews(oneSubscription, [view(query)])).toEqual([{ ...view(query), heldBack: [] }]);
    expect(await holdBackSavedViews(everythingAccess('admin'), [view(`subscription=${SUB_TWO}`)]))
      .toEqual([{ ...view(`subscription=${SUB_TWO}`), heldBack: [] }]);
  });

  it('never holds back search, rule, category, tag, severity or the date window', async () => {
    const query = 'q=secret&ruleId=r1&category=security&tags=t&severity=high&window=30&location=westeurope';
    const [result] = await holdBackSavedViews(NO_ACCESS, [view(query)]);
    expect(result!.heldBack).toEqual([]);
    expect(result!.query).toBe(query);
  });
});

describe('a dashboard as the routes return it', () => {
  const oneSubscription = holding([`/subscriptions/${SUB_ONE}`]);
  const config = (): DashboardConfig => ({
    autoRefresh: 0,
    filters: { subscriptions: [SUB_ONE, SUB_TWO], resourceGroups: ['rg-one'], severities: ['high'] },
    widgets: [
      { id: 'w1', type: 'stat-card', title: 'One', x: 0, y: 0, w: 4, h: 2, config: { subscriptions: [SUB_TWO], category: 'security' } },
      { id: 'w2', type: 'stat-card', title: 'Two', x: 4, y: 0, w: 4, h: 2, config: { subscriptions: [SUB_ONE] } },
    ],
  }) as DashboardConfig;

  it('omits held values from the filter bar and each widget, with a count for each place', async () => {
    const [result] = await holdBackDashboards(oneSubscription, [{ id: 'd1', config: config() }]);
    expect(result!.config.filters).toEqual({ subscriptions: [SUB_ONE], resourceGroups: ['rg-one'], severities: ['high'] });
    expect(result!.config.widgets[0]!.config).toEqual({ subscriptions: [], category: 'security' });
    expect(result!.config.widgets[1]!.config).toEqual({ subscriptions: [SUB_ONE] });
    expect(result!.heldBack).toEqual([
      { place: 'dashboard', id: 'd1', dimension: 'subscription', count: 1 },
      { place: 'widget', id: 'w1', dimension: 'subscription', count: 1 },
    ]);
  });

  it('holds nothing back for Everything', async () => {
    const [result] = await holdBackDashboards(everythingAccess('admin'), [{ id: 'd1', config: config() }]);
    expect(result!.config).toEqual(config());
    expect(result!.heldBack).toEqual([]);
  });

  it('does not change the stored config it was given', async () => {
    const original = config();
    await holdBackDashboards(NO_ACCESS, [{ id: 'd1', config: original }]);
    expect(original).toEqual(config());
  });
});

describe('what the page says', () => {
  const held: HeldBack[] = [
    { place: 'dashboard', id: 'd1', dimension: 'subscription', count: 2 },
    { place: 'widget', id: 'w1', dimension: 'resourceGroup', count: 1 },
  ];

  it('reads "N outside your access" beside visible values and only the label when every value is held back', () => {
    expect(heldBackNote(2, 1)).toBe('2 outside your access');
    expect(heldBackNote(2, 0)).toBe(OUTSIDE_ACCESS_LABEL);
  });

  it('looks up the count for a place and dimension', () => {
    expect(heldBackCount(held, 'dashboard', 'd1', 'subscription')).toBe(2);
    expect(heldBackCount(held, 'widget', 'd1', 'subscription')).toBe(0);
    expect(heldBackCount(undefined, 'dashboard', 'd1', 'subscription')).toBe(0);
  });

  it('says a dimension matches nothing when it has held values and no visible one', () => {
    expect(onlyHeldBack(held, 'dashboard', 'd1', 'subscription', 0)).toBe(true);
    expect(onlyHeldBack(held, 'dashboard', 'd1', 'subscription', 1)).toBe(false);
    expect(onlyHeldBack(held, 'dashboard', 'd1', 'resourceGroup', 0)).toBe(false);
  });

  describe('a widget with nothing it can show', () => {
    const bar = (subscriptions: string[] = [], resourceGroups: string[] = []) => ({ subscriptions, resourceGroups });
    const widget = (config: Record<string, unknown> = {}) => ({ id: 'w1', config });

    it('names the subscriptions when the filter bar holds only held-back ones', () => {
      const reason = widgetHeldBackReason(held, 'd1', widget(), bar());
      expect(reason?.title).toBe(OUTSIDE_ACCESS_LABEL);
      expect(reason?.detail).toContain('subscriptions');
    });

    it('names the resource groups when the widget\'s own override holds only held-back ones', () => {
      expect(widgetHeldBackReason(held, 'd1', widget(), bar([SUB_ONE]))?.detail).toContain('resource groups');
    });

    it('gives no reason when a visible value is left, whether the widget\'s or the filter bar\'s', () => {
      expect(widgetHeldBackReason(held, 'd1', { id: 'w2', config: {} }, bar([SUB_ONE], ['rg-one']))).toBeNull();
      expect(widgetHeldBackReason(held, 'd1', widget({ subscriptions: [SUB_ONE], resourceGroups: ['rg-one'] }), bar())).toBeNull();
    });

    it('lets a widget\'s own held-back override win over a visible filter bar value', () => {
      expect(widgetHeldBackReason(held, 'd1', widget(), bar([SUB_ONE], ['rg-one']))?.detail).toContain('resource groups');
    });

    it('gives no reason when nothing is held back', () => {
      expect(widgetHeldBackReason([], 'd1', widget(), bar())).toBeNull();
      expect(widgetHeldBackReason(undefined, 'd1', widget(), bar())).toBeNull();
    });
  });

  describe('the placeholder a dimension held back in full is opened with', () => {
    const held: HeldBack[] = [{ place: 'savedView', id: 'v1', dimension: 'subscription', count: 2 }];

    it('is not a value to draw as a chip of its own: the held-back chip stands for it', () => {
      expect(valuesWithoutPlaceholder(held, 'subscription', [OUTSIDE_ACCESS_LABEL])).toEqual([]);
      expect(valuesWithoutPlaceholder(held, 'subscription', [SUB_ONE, OUTSIDE_ACCESS_LABEL])).toEqual([SUB_ONE]);
    });

    it('is an ordinary value in a dimension nothing is held back from', () => {
      expect(valuesWithoutPlaceholder(held, 'resourceName', [OUTSIDE_ACCESS_LABEL])).toEqual([OUTSIDE_ACCESS_LABEL]);
      expect(valuesWithoutPlaceholder([], 'subscription', [OUTSIDE_ACCESS_LABEL])).toEqual([OUTSIDE_ACCESS_LABEL]);
    });
  });
});
