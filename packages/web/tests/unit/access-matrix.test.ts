/**
 * #270: the access matrix. Seven people who hold different Scopes call every stored-data GET route through
 * the real `requireRole` (only the session, `@/auth`, is mocked) and the real repositories, over one data
 * set written through the real write paths. A route that does not narrow yet is on `NOT_YET_SCOPED`, and
 * every person must get a 200 whose body equals the Admin's from it. A ticket that narrows a route moves it
 * from `NOT_YET_SCOPED` to `MATRIX` and says what each person should now see: #272 did so for the five
 * `findings/*` routes, with expectations written by hand from the seed in `tests/helpers/access-matrix.ts`.
 * #277 did so for the eight routes that send a query a person wrote to Azure, and #274 for the six widget
 * routes, the two dashboard routes and the two saved view routes. #277's routes call a fake Azure
 * rather than read the seed, so their probes report the status, the error and the scope the fake was sent,
 * and run in their own `describe` over their own database.
 *
 * The lists are checked against the route files on disk, the way `route-guards.test.ts` checks guards:
 * a route that uses the actor's access must be in exactly one of the two lists, and an entry must name a
 * route file that exists.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { saveRules } from '@/lib/rules';
import { fakeTenantContext, type FakeTenantContext } from '../helpers/fake-azure';
import type { Rule } from '@rulebeat/core';
import { replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import {
  createPeople, MATRIX_NOW, MATRIX_TENANT, PEOPLE, SCOPE_DIRECTORY, SCOPE_MANAGEMENT_GROUP, SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, SNAPSHOT_DAYS, SUB_ONE, SUB_TWO, seedMatrix, type MatrixSeed,
} from '../helpers/access-matrix';
import type { OwnAccess } from '@/lib/access';
import { emptyView, viewToSearchParams, type View } from '@/lib/finding-view';
import { VIEW_TABS, type ViewTab } from '@/lib/view-response';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve(fakeCtx) };
});

const API_DIR = path.resolve(__dirname, '../../app/api');

function routeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, found);
    else if (entry === 'route.ts') found.push(full);
  }
  return found;
}

/** `scans/[id]/snapshot` for `app/api/scans/[id]/snapshot/route.ts`. */
const routeName = (file: string): string => path.relative(API_DIR, path.dirname(file)).split(path.sep).join('/');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A route reads the person's access when it hands `<something>.access` on to a read. */
export const USES_ACCESS = /\b\w+\.access\b/;

type Probe = (seed: MatrixSeed) => Promise<Response>;

interface NotYetScoped {
  /** The ticket that narrows this route and so moves it to `MATRIX`. */
  ticket: string;
  /** Present for a GET that reads stored data: the matrix calls it for every person. Absent for a route
   *  that calls Azure and for a route listed by hand because it reads no findings-derived data. */
  probe?: Probe;
  /** Why there is no probe. */
  unprobed?: string;
}

/** Calls a route for one tab and reduces the answer to the parts the expectations name. */
type TabProbe = (seed: MatrixSeed, tab: ViewTab) => Promise<unknown>;

interface Matrix {
  probe: TabProbe;
  /** What each person gets on each tab, by person name, written by hand from the seed. */
  expected: Record<string, Record<ViewTab, unknown>>;
}

const get = (url: string, route: { GET(req: Request, ctx?: never): Promise<Response> }) => route.GET(new Request(`http://localhost${url}`));
const getWith = (url: string, route: { GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> }, id: string) =>
  route.GET(new Request(`http://localhost${url}`), { params: Promise.resolve({ id }) });

const view = viewToSearchParams(emptyView(), { tab: 'results' }).toString();
const exportOf = (format: string) => `${view}&format=${format}`;

const stored = (probe: Probe, ticket: string): NotYetScoped => ({ ticket, probe });
const azure = (ticket: string): NotYetScoped => ({ ticket, unprobed: 'calls Azure, which a test never does' });
const byHand = (ticket: string): NotYetScoped => ({ ticket, unprobed: 'listed by hand: it reads no findings-derived data and does not take the actor\'s access yet' });

export const NOT_YET_SCOPED: Record<string, NotYetScoped> = {
  'suppressions': stored(async () => get('/api/suppressions', await import('@/app/api/suppressions/route')), '#275'),
  'azure/subscriptions': byHand('#275'),
  'azure/management-groups': byHand('#275'),
  'azure/scope-tree': byHand('#275'),

  'scans/run': stored(async () => get('/api/scans/run', await import('@/app/api/scans/run/route')), '#276'),
  'scans/[id]/snapshot': stored(async seed => getWith(`/api/scans/${seed.scanIds[1]}/snapshot`, await import('@/app/api/scans/[id]/snapshot/route'), seed.scanIds[1]), '#276'),
  'scans/[id]/snapshot/export': stored(async seed => getWith(`/api/scans/${seed.scanIds[1]}/snapshot/export?format=json`, await import('@/app/api/scans/[id]/snapshot/export/route'), seed.scanIds[1]), '#276'),
  'scans/compare': stored(async seed => get(`/api/scans/compare?compare=${seed.scanIds[0]}..${seed.scanIds[1]}`, await import('@/app/api/scans/compare/route')), '#276'),
  'scans/compare/export': stored(async seed => get(`/api/scans/compare/export?compare=${seed.scanIds[0]}..${seed.scanIds[1]}&format=json`, await import('@/app/api/scans/compare/export/route')), '#276'),
  'schedules': stored(async () => get('/api/schedules', await import('@/app/api/schedules/route')), '#276'),
  'schedules/[id]/run': azure('#276'),
  'schedules/[id]/runs': stored(async seed => getWith(`/api/schedules/${seed.scheduleId}/runs`, await import('@/app/api/schedules/[id]/runs/route'), seed.scheduleId), '#276'),


  // Admin-only, and a list of one subscription's resource groups for the Scope picker: this ticket does not narrow it.
  'azure/subscriptions/[id]/resource-groups': azure('#284'),

  'schemas': azure('#284'),
  'resources/types': azure('#284'),
  'resources/properties': azure('#284'),
  'diagnostics/preflight': azure('#284'),
};

const BODY = async (res: Response): Promise<unknown> => {
  expect(res.status).toBe(200);
  return res.json();
};

const tabParams = (tab: ViewTab, extra: Partial<View> = {}) => viewToSearchParams({ ...emptyView(), ...extra }, { tab }).toString();

/** The seeded finding names a response lists, from the fingerprints it holds, sorted. */
const namesOf = (seed: MatrixSeed, items: { fingerprint: string }[]): string[] => {
  const byFingerprint = new Map(Object.entries(seed.fingerprints).map(([name, fp]) => [fp, name]));
  return items.map(i => byFingerprint.get(i.fingerprint) ?? `unknown ${i.fingerprint}`).sort();
};

type ByTab = Record<ViewTab, unknown>;

/**
 * What each person gets, by what they hold: Everything (the Admin and the Editor), the management group
 * (both subscriptions under it, and what sits at the group), one subscription, one resource group, the
 * Directory, and nothing (the person with no Scope).
 */
const byPerson = (
  everything: ByTab, managementGroup: ByTab, subscription: ByTab, resourceGroup: ByTab, directory: ByTab, nothing: ByTab,
): Record<string, ByTab> => ({
  'Admin': everything,
  'Editor on Everything': everything,
  'Viewer on the management group': managementGroup,
  'Viewer on one subscription': subscription,
  'Viewer on one resource group': resourceGroup,
  'Directory only': directory,
  'No Scope': nothing,
});

const same = (value: unknown): ByTab => ({ results: value, advisories: value, activity: value });

// The seed, by tab. Results: vm-one (subscription one, rg-one), vm-two (subscription one, rg-two, suppressed),
// vm-other-sub (subscription two, rg-one), subscription-level (subscription one), management-group-level,
// directory-app and unplaceable-thing. Advisories: advisory-one (subscription one, rg-one) and
// advisory-other-sub (subscription two, rg-one). Activity: workspace-user (subscription one, rg-one).

const DATE = '2026-06-02T00:00:00.000Z';
const NOTHING_VIEW = { names: [], total: 0, tilesTotal: 0, subscriptions: [], ruleRows: [], columns: [], suppressedCount: 0, lastScanAt: undefined, policyOptions: [] };

const viewEntry: Matrix = {
  probe: async (seed, tab) => {
    const body = await BODY(await (await import('@/app/api/findings/view/route')).GET(new Request(`http://localhost/api/findings/view?${tabParams(tab)}`))) as {
      items: { finding: { fingerprint: string } }[]; total: number; tiles: { total: number };
      facets: { subscription: { value: string; count: number }[] }; ruleRows: { ruleId: string; open: number }[];
      columns: string[]; suppressedCount: number; lastScanAt?: string; policyOptions: { id: string }[];
    };
    return {
      names: namesOf(seed, body.items.map(i => i.finding)),
      total: body.total,
      tilesTotal: body.tiles.total,
      subscriptions: body.facets.subscription.map(f => [f.value, f.count]),
      ruleRows: body.ruleRows.map(r => [r.ruleId, r.open]),
      columns: body.columns,
      suppressedCount: body.suppressedCount,
      lastScanAt: body.lastScanAt,
      policyOptions: body.policyOptions.map(p => p.id),
    };
  },
  expected: byPerson(
    {
      results: {
        names: ['directory-app', 'management-group-level', 'subscription-level', 'unplaceable-thing', 'vm-one', 'vm-other-sub'],
        total: 6, tilesTotal: 6, subscriptions: [[SUB_ONE, 2], [SUB_TWO, 1], ['directory', 1]], ruleRows: [['matrix-rule', 6]],
        columns: ['otherSubColumn', 'zone'], suppressedCount: 1, lastScanAt: DATE, policyOptions: ['matrix-rule'],
      },
      advisories: {
        names: ['advisory-one', 'advisory-other-sub'], total: 2, tilesTotal: 2, subscriptions: [[SUB_ONE, 1], [SUB_TWO, 1]],
        ruleRows: [['matrix-advisory-rule', 2]], columns: ['zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-advisory-rule'],
      },
      // Under Everything the column list is the rule's catalogue, unchanged by scoping, and the workspace
      // finding shares its rule with vm-other-sub, whose extra column the catalogue holds.
      activity: {
        names: ['workspace-user'], total: 1, tilesTotal: 1, subscriptions: [[SUB_ONE, 1]], ruleRows: [['matrix-rule', 1]],
        columns: ['otherSubColumn', 'zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-rule'],
      },
    },
    // Both subscriptions under the group, and the finding placed at the group itself. vm-two is suppressed, so it
    // counts toward suppressedCount and is not listed. The subscription facet has no entry for the group-level
    // finding, which sits in no subscription.
    {
      results: {
        names: ['management-group-level', 'subscription-level', 'vm-one', 'vm-other-sub'], total: 4, tilesTotal: 4,
        subscriptions: [[SUB_ONE, 2], [SUB_TWO, 1]], ruleRows: [['matrix-rule', 4]],
        columns: ['otherSubColumn', 'zone'], suppressedCount: 1, lastScanAt: DATE, policyOptions: ['matrix-rule'],
      },
      advisories: {
        names: ['advisory-one', 'advisory-other-sub'], total: 2, tilesTotal: 2, subscriptions: [[SUB_ONE, 1], [SUB_TWO, 1]],
        ruleRows: [['matrix-advisory-rule', 2]], columns: ['zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-advisory-rule'],
      },
      activity: {
        names: ['workspace-user'], total: 1, tilesTotal: 1, subscriptions: [[SUB_ONE, 1]], ruleRows: [['matrix-rule', 1]],
        columns: ['zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-rule'],
      },
    },
    {
      results: {
        names: ['subscription-level', 'vm-one'], total: 2, tilesTotal: 2, subscriptions: [[SUB_ONE, 2]], ruleRows: [['matrix-rule', 2]],
        columns: ['zone'], suppressedCount: 1, lastScanAt: DATE, policyOptions: ['matrix-rule'],
      },
      advisories: {
        names: ['advisory-one'], total: 1, tilesTotal: 1, subscriptions: [[SUB_ONE, 1]], ruleRows: [['matrix-advisory-rule', 1]],
        columns: ['zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-advisory-rule'],
      },
      activity: {
        names: ['workspace-user'], total: 1, tilesTotal: 1, subscriptions: [[SUB_ONE, 1]], ruleRows: [['matrix-rule', 1]],
        columns: ['zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-rule'],
      },
    },
    {
      results: {
        names: ['vm-one'], total: 1, tilesTotal: 1, subscriptions: [[SUB_ONE, 1]], ruleRows: [['matrix-rule', 1]],
        columns: ['zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-rule'],
      },
      advisories: {
        names: ['advisory-one'], total: 1, tilesTotal: 1, subscriptions: [[SUB_ONE, 1]], ruleRows: [['matrix-advisory-rule', 1]],
        columns: ['zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-advisory-rule'],
      },
      activity: {
        names: ['workspace-user'], total: 1, tilesTotal: 1, subscriptions: [[SUB_ONE, 1]], ruleRows: [['matrix-rule', 1]],
        columns: ['zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-rule'],
      },
    },
    {
      results: {
        names: ['directory-app'], total: 1, tilesTotal: 1, subscriptions: [['directory', 1]], ruleRows: [['matrix-rule', 1]],
        columns: ['zone'], suppressedCount: 0, lastScanAt: DATE, policyOptions: ['matrix-rule'],
      },
      advisories: NOTHING_VIEW,
      activity: NOTHING_VIEW,
    },
    same(NOTHING_VIEW),
  ),
};

const NOTHING_GROUP = { headers: [], names: [], total: 0, groupCount: null };

const group: Matrix = {
  probe: async (seed, tab) => {
    const grouped = tabParams(tab, { groupBy: ['category'] });
    const headers = await BODY(await (await import('@/app/api/findings/view/route')).GET(new Request(`http://localhost/api/findings/view?${grouped}`))) as {
      grouped: { groups: { value: string; findingCount: number }[] };
    };
    const inside = await BODY(await (await import('@/app/api/findings/group/route')).GET(
      new Request(`http://localhost/api/findings/group?${grouped}&groupPath=%5B%22security%22%5D`),
    )) as { items: { finding: { fingerprint: string } }[]; total: number; group?: { findingCount: number } | null };
    return {
      headers: headers.grouped.groups.map(g => [g.value, g.findingCount]),
      names: namesOf(seed, inside.items.map(i => i.finding)),
      total: inside.total,
      groupCount: inside.group?.findingCount ?? null,
    };
  },
  expected: byPerson(
    {
      results: { headers: [['security', 6]], names: ['directory-app', 'management-group-level', 'subscription-level', 'unplaceable-thing', 'vm-one', 'vm-other-sub'], total: 6, groupCount: 6 },
      advisories: { headers: [['security', 2]], names: ['advisory-one', 'advisory-other-sub'], total: 2, groupCount: 2 },
      activity: { headers: [['security', 1]], names: ['workspace-user'], total: 1, groupCount: 1 },
    },
    {
      results: { headers: [['security', 4]], names: ['management-group-level', 'subscription-level', 'vm-one', 'vm-other-sub'], total: 4, groupCount: 4 },
      advisories: { headers: [['security', 2]], names: ['advisory-one', 'advisory-other-sub'], total: 2, groupCount: 2 },
      activity: { headers: [['security', 1]], names: ['workspace-user'], total: 1, groupCount: 1 },
    },
    {
      results: { headers: [['security', 2]], names: ['subscription-level', 'vm-one'], total: 2, groupCount: 2 },
      advisories: { headers: [['security', 1]], names: ['advisory-one'], total: 1, groupCount: 1 },
      activity: { headers: [['security', 1]], names: ['workspace-user'], total: 1, groupCount: 1 },
    },
    {
      results: { headers: [['security', 1]], names: ['vm-one'], total: 1, groupCount: 1 },
      advisories: { headers: [['security', 1]], names: ['advisory-one'], total: 1, groupCount: 1 },
      activity: { headers: [['security', 1]], names: ['workspace-user'], total: 1, groupCount: 1 },
    },
    {
      results: { headers: [['security', 1]], names: ['directory-app'], total: 1, groupCount: 1 },
      advisories: NOTHING_GROUP,
      activity: NOTHING_GROUP,
    },
    same(NOTHING_GROUP),
  ),
};

const NOTHING_COLUMN = { zone: [], otherSubColumn: [] };

const columnValues: Matrix = {
  probe: async (_seed, tab) => {
    const route = await import('@/app/api/findings/column-values/route');
    const read = async (column: string) => {
      const body = await BODY(await route.GET(new Request(`http://localhost/api/findings/column-values?${tabParams(tab)}&column=row.${column}`))) as {
        values: { value: string; count: number }[];
      };
      return body.values.map(v => [v.value, v.count]);
    };
    return { zone: await read('zone'), otherSubColumn: await read('otherSubColumn') };
  },
  expected: byPerson(
    {
      results: { zone: [['a', 6]], otherSubColumn: [['x', 1]] },
      advisories: { zone: [['a', 2]], otherSubColumn: [] },
      activity: { zone: [['a', 1]], otherSubColumn: [] },
    },
    {
      results: { zone: [['a', 4]], otherSubColumn: [['x', 1]] },
      advisories: { zone: [['a', 2]], otherSubColumn: [] },
      activity: { zone: [['a', 1]], otherSubColumn: [] },
    },
    {
      results: { zone: [['a', 2]], otherSubColumn: [] },
      advisories: { zone: [['a', 1]], otherSubColumn: [] },
      activity: { zone: [['a', 1]], otherSubColumn: [] },
    },
    {
      results: { zone: [['a', 1]], otherSubColumn: [] },
      advisories: { zone: [['a', 1]], otherSubColumn: [] },
      activity: { zone: [['a', 1]], otherSubColumn: [] },
    },
    {
      results: { zone: [['a', 1]], otherSubColumn: [] },
      advisories: NOTHING_COLUMN,
      activity: NOTHING_COLUMN,
    },
    same(NOTHING_COLUMN),
  ),
};

const NOTHING_EXPORT = { names: [], rowKeys: [] };

const exported: Matrix = {
  probe: async (seed, tab) => {
    const res = await (await import('@/app/api/findings/export/route')).GET(
      new Request(`http://localhost/api/findings/export?${tabParams(tab)}&format=json`),
    );
    const list = await BODY(res) as { fingerprint: string; rows: Record<string, unknown>[] }[];
    return {
      names: namesOf(seed, list),
      rowKeys: [...new Set(list.flatMap(f => f.rows.flatMap(r => Object.keys(r))))].sort(),
    };
  },
  expected: byPerson(
    {
      results: { names: ['directory-app', 'management-group-level', 'subscription-level', 'unplaceable-thing', 'vm-one', 'vm-other-sub'], rowKeys: ['otherSubColumn', 'zone'] },
      advisories: { names: ['advisory-one', 'advisory-other-sub'], rowKeys: ['zone'] },
      activity: { names: ['workspace-user'], rowKeys: ['zone'] },
    },
    {
      results: { names: ['management-group-level', 'subscription-level', 'vm-one', 'vm-other-sub'], rowKeys: ['otherSubColumn', 'zone'] },
      advisories: { names: ['advisory-one', 'advisory-other-sub'], rowKeys: ['zone'] },
      activity: { names: ['workspace-user'], rowKeys: ['zone'] },
    },
    {
      results: { names: ['subscription-level', 'vm-one'], rowKeys: ['zone'] },
      advisories: { names: ['advisory-one'], rowKeys: ['zone'] },
      activity: { names: ['workspace-user'], rowKeys: ['zone'] },
    },
    {
      results: { names: ['vm-one'], rowKeys: ['zone'] },
      advisories: { names: ['advisory-one'], rowKeys: ['zone'] },
      activity: { names: ['workspace-user'], rowKeys: ['zone'] },
    },
    {
      results: { names: ['directory-app'], rowKeys: ['zone'] },
      advisories: NOTHING_EXPORT,
      activity: NOTHING_EXPORT,
    },
    same(NOTHING_EXPORT),
  ),
};

/** Every finding stored on a tab, suppressed ones included: what the rows route is asked for. */
const STORED_BY_TAB: Record<ViewTab, string[]> = {
  results: ['directory-app', 'management-group-level', 'subscription-level', 'unplaceable-thing', 'vm-one', 'vm-other-sub', 'vm-two'],
  advisories: ['advisory-one', 'advisory-other-sub'],
  activity: ['workspace-user'],
};
/** 200 for the names a person may open and 404 for every other finding stored on the tab. */
const opens = (tab: ViewTab, names: string[]): Record<string, number> =>
  Object.fromEntries(STORED_BY_TAB[tab].map(name => [name, names.includes(name) ? 200 : 404]));

const rows: Matrix = {
  probe: async (seed, tab) => {
    const route = await import('@/app/api/findings/rows/route');
    const out: Record<string, number> = {};
    for (const name of STORED_BY_TAB[tab]) {
      const res = await route.GET(new Request(`http://localhost/api/findings/rows?${tabParams(tab)}&fingerprint=${seed.fingerprints[name]}`));
      out[name] = res.status;
    }
    return out;
  },
  expected: byPerson(
    { results: opens('results', STORED_BY_TAB.results), advisories: opens('advisories', STORED_BY_TAB.advisories), activity: opens('activity', STORED_BY_TAB.activity) },
    {
      results: opens('results', ['management-group-level', 'subscription-level', 'vm-one', 'vm-other-sub', 'vm-two']),
      advisories: opens('advisories', ['advisory-one', 'advisory-other-sub']),
      activity: opens('activity', ['workspace-user']),
    },
    { results: opens('results', ['subscription-level', 'vm-one', 'vm-two']), advisories: opens('advisories', ['advisory-one']), activity: opens('activity', ['workspace-user']) },
    { results: opens('results', ['vm-one']), advisories: opens('advisories', ['advisory-one']), activity: opens('activity', ['workspace-user']) },
    { results: opens('results', ['directory-app']), advisories: opens('advisories', []), activity: opens('activity', []) },
    { results: opens('results', []), advisories: opens('advisories', []), activity: opens('activity', []) },
  ),
};

/** The one route that answers a person with their own access: each person gets their own rows and nobody else's. */
const ownAccess: Matrix = {
  probe: async () => {
    const body = await BODY(await (await import('@/app/api/access/route')).GET()) as OwnAccess;
    return { role: body.role, source: body.source, scopes: body.scopes.map(scope => [scope.path, scope.role]) };
  },
  expected: {
    'Admin': same({ role: 'admin', source: null, scopes: [['/', 'admin']] }),
    'Editor on Everything': same({ role: 'editor', source: 'manual', scopes: [['/', 'editor']] }),
    'Viewer on the management group': same({ role: 'viewer', source: 'manual', scopes: [[SCOPE_MANAGEMENT_GROUP, 'viewer']] }),
    'Viewer on one subscription': same({ role: 'viewer', source: 'manual', scopes: [[SCOPE_SUBSCRIPTION, 'viewer']] }),
    'Viewer on one resource group': same({ role: 'viewer', source: 'manual', scopes: [[SCOPE_RESOURCE_GROUP, 'viewer']] }),
    'Directory only': same({ role: 'viewer', source: 'manual', scopes: [[SCOPE_DIRECTORY, 'viewer']] }),
    'No Scope': same({ role: 'viewer', source: 'manual', scopes: [] }),
  },
};

const NOTHING_MARKED = { subscriptions: [], resourceGroups: [] };
const SUB_TWO_MARKED = { subscriptions: [SUB_TWO], resourceGroups: [] };
const BOTH_MARKED = { subscriptions: [SUB_TWO], resourceGroups: ['rg-two'] };

/**
 * #274: the six widget routes, the two saved view routes and the two dashboard routes. A widget route
 * is not per tab, so each expectation is `same(...)` across the three. The summary probe runs under a
 * fixed clock because `trendDays` and the delta window are rolling: the seed's days are in June 2026.
 */
function dashboardMatrix(): Record<string, Matrix> {
  const loaders: Record<string, () => Promise<{ GET(req: Request): Promise<Response> }>> = {
    'summary': () => import('@/app/api/widgets/summary/route'),
    'findings': () => import('@/app/api/widgets/findings/route'),
    'top-rules': () => import('@/app/api/widgets/top-rules/route'),
    'top-resources': () => import('@/app/api/widgets/top-resources/route'),
    'advisories': () => import('@/app/api/widgets/advisories/route'),
    'filter-options': () => import('@/app/api/widgets/filter-options/route'),
  };
  const widget = async (route: string, query = '') =>
    BODY(await (await loaders[route]!()).GET(new Request(`http://localhost/api/widgets/${route}${query}`)));
  const nameOf = (items: { fingerprint: string }[], seed: MatrixSeed) => namesOf(seed, items);

  const summary: Matrix = {
    probe: async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(MATRIX_NOW));
      try {
        const body = await widget('summary', '?trendDays=30') as {
          current: { activeFindings: number; severityCounts: { high: number } };
          perSubscription: { subscriptionId: string; activeFindings: number }[];
          trend: { date: string; findings: number }[];
          baseline: { date: string } | null; deltaPct: number | null;
          trendUnavailable: string | null; trendIsCategoryScopedOnly: boolean; lastScanAt: string | null;
          perCategory: { category: string; lastScanAt: string | null }[];
        };
        return {
          activeFindings: body.current.activeFindings,
          high: body.current.severityCounts.high,
          perSubscription: body.perSubscription.map(s => [s.subscriptionId, s.activeFindings]),
          trend: body.trend.map(p => [p.date, p.findings]),
          baselineDate: body.baseline?.date ?? null,
          deltaPct: body.deltaPct === null ? null : 'a number',
          trendUnavailable: body.trendUnavailable,
          lastScanAt: body.lastScanAt,
          securityLastScanAt: body.perCategory.find(c => c.category === 'security')?.lastScanAt,
        };
      } finally {
        vi.useRealTimers();
      }
    },
    expected: byPerson(
      same({
        activeFindings: 6, high: 6, perSubscription: [[SUB_ONE, 2], [SUB_TWO, 1]], trend: [[SNAPSHOT_DAYS[0], 5], [SNAPSHOT_DAYS[1], 6]],
        baselineDate: SNAPSHOT_DAYS[1], deltaPct: 'a number', trendUnavailable: null, lastScanAt: DATE, securityLastScanAt: DATE,
      }),
      // Both subscriptions and no filter: two subscriptions' rows are never added into one trend.
      same({
        activeFindings: 4, high: 4, perSubscription: [[SUB_ONE, 2], [SUB_TWO, 1]], trend: [], baselineDate: null, deltaPct: null,
        trendUnavailable: 'choose-subscription', lastScanAt: DATE, securityLastScanAt: DATE,
      }),
      // Everything the person holds lies in subscription one, so its rows serve the trend: its count, not the install's.
      same({
        activeFindings: 2, high: 2, perSubscription: [[SUB_ONE, 2]], trend: [[SNAPSHOT_DAYS[0], 3], [SNAPSHOT_DAYS[1], 2]],
        baselineDate: SNAPSHOT_DAYS[1], deltaPct: 'a number', trendUnavailable: null, lastScanAt: DATE, securityLastScanAt: DATE,
      }),
      same({
        activeFindings: 1, high: 1, perSubscription: [[SUB_ONE, 1]], trend: [], baselineDate: null, deltaPct: null,
        trendUnavailable: 'no-whole-subscription', lastScanAt: DATE, securityLastScanAt: DATE,
      }),
      same({
        activeFindings: 1, high: 1, perSubscription: [], trend: [], baselineDate: null, deltaPct: null,
        trendUnavailable: 'no-whole-subscription', lastScanAt: DATE, securityLastScanAt: DATE,
      }),
      same({
        activeFindings: 0, high: 0, perSubscription: [], trend: [], baselineDate: null, deltaPct: null,
        trendUnavailable: 'no-whole-subscription', lastScanAt: DATE, securityLastScanAt: DATE,
      }),
    ),
  };

  const SEEN = {
    everything: ['directory-app', 'management-group-level', 'subscription-level', 'unplaceable-thing', 'vm-one', 'vm-other-sub'],
    managementGroup: ['management-group-level', 'subscription-level', 'vm-one', 'vm-other-sub'],
    subscription: ['subscription-level', 'vm-one'],
    resourceGroup: ['vm-one'],
    directory: ['directory-app'],
  };

  const findings: Matrix = {
    probe: async seed => nameOf(await widget('findings') as { fingerprint: string }[], seed),
    expected: byPerson(same(SEEN.everything), same(SEEN.managementGroup), same(SEEN.subscription), same(SEEN.resourceGroup), same(SEEN.directory), same([])),
  };

  const topRules: Matrix = {
    probe: async () => (await widget('top-rules') as { ruleId: string; count: number }[]).map(r => [r.ruleId, r.count]),
    expected: byPerson(
      same([['matrix-rule', 6]]), same([['matrix-rule', 4]]), same([['matrix-rule', 2]]), same([['matrix-rule', 1]]), same([['matrix-rule', 1]]), same([]),
    ),
  };

  // A Directory finding is listed by its name and needs the Directory Scope.
  const topResources: Matrix = {
    probe: async () => (await widget('top-resources') as { resourceName: string }[]).map(r => r.resourceName).sort(),
    expected: byPerson(
      same(SEEN.everything), same(SEEN.managementGroup), same(SEEN.subscription), same(SEEN.resourceGroup), same(['directory-app']), same([]),
    ),
  };

  const advisories: Matrix = {
    probe: async seed => {
      const body = await widget('advisories') as { items: { fingerprint: string }[]; total: number };
      return { names: nameOf(body.items, seed), total: body.total };
    },
    expected: byPerson(
      same({ names: ['advisory-one', 'advisory-other-sub'], total: 2 }), same({ names: ['advisory-one', 'advisory-other-sub'], total: 2 }),
      same({ names: ['advisory-one'], total: 1 }), same({ names: ['advisory-one'], total: 1 }), same({ names: [], total: 0 }), same({ names: [], total: 0 }),
    ),
  };

  const ALL_RULES = ['matrix-advisory-rule', 'matrix-rule'];
  const options = (subscriptions: string[], resourceGroups: string[], rules: string[]) => same({
    categories: ['compliance', 'cost', 'security', 'identity', 'reliability'], hasTags: false, subscriptions, resourceGroups, rules,
  });
  const filterOptions: Matrix = {
    probe: async () => {
      const body = await widget('filter-options') as {
        categories: { id: string }[]; tags: string[]; subscriptions: string[]; resourceGroups: string[]; rules: { id: string }[];
      };
      return {
        categories: body.categories.map(c => c.id), hasTags: body.tags.length > 0, subscriptions: body.subscriptions,
        resourceGroups: body.resourceGroups, rules: body.rules.map(r => r.id).sort(),
      };
    },
    expected: byPerson(
      options([SUB_ONE, SUB_TWO, 'directory'], ['rg-one', 'rg-two'], ALL_RULES),
      options([SUB_ONE, SUB_TWO], ['rg-one', 'rg-two'], ALL_RULES),
      options([SUB_ONE], ['rg-one', 'rg-two'], ALL_RULES),
      options([SUB_ONE], ['rg-one'], ALL_RULES),
      options(['directory'], [], ['matrix-rule']),
      options([], [], []),
    ),
  };

  // A stored filter reads back exactly as stored, with the marks beside it. The marks are what differs.
  const marked = (marks: { subscriptions: string[]; resourceGroups: string[] }) => ({ marks });
  const marksByPerson = (everything: object, managementGroup: object, subscription: object, resourceGroup: object, directory: object, nothing: object) =>
    byPerson(same(everything), same(managementGroup), same(subscription), same(resourceGroup), same(directory), same(nothing));

  const dashboardOf = (body: { config: { filters?: unknown; widgets: { config: unknown }[] }; outsideAccess: unknown }) =>
    ({ filters: body.config.filters, widgetOverride: body.config.widgets[0]!.config, marks: body.outsideAccess });
  const STORED_DASHBOARD = { filters: { subscriptions: [SUB_TWO] }, widgetOverride: { resourceGroups: ['rg-two'] } };
  const dashboardExpected = marksByPerson(
    { ...STORED_DASHBOARD, ...marked(NOTHING_MARKED) },
    { ...STORED_DASHBOARD, ...marked(NOTHING_MARKED) },
    { ...STORED_DASHBOARD, ...marked(SUB_TWO_MARKED) },
    { ...STORED_DASHBOARD, ...marked(BOTH_MARKED) },
    { ...STORED_DASHBOARD, ...marked(BOTH_MARKED) },
    { ...STORED_DASHBOARD, ...marked(BOTH_MARKED) },
  );
  const dashboards: Matrix = {
    probe: async seed => {
      const list = await BODY(await (await import('@/app/api/dashboards/route')).GET()) as { id: string; config: never; outsideAccess: unknown }[];
      return dashboardOf(list.find(d => d.id === seed.dashboardId)!);
    },
    expected: dashboardExpected,
  };
  const dashboardById: Matrix = {
    probe: async seed => dashboardOf(await BODY(await getWith('/api/dashboards/x', await import('@/app/api/dashboards/[id]/route'), seed.dashboardId)) as never),
    expected: dashboardExpected,
  };

  const VIEW_QUERY = `subscription=${SUB_TWO}`;
  const viewOf = (body: { query: string; tab: string; outsideAccess: unknown }) => ({ tab: body.tab, query: body.query, marks: body.outsideAccess });
  const viewExpected = marksByPerson(
    { tab: 'results', query: VIEW_QUERY, ...marked(NOTHING_MARKED) },
    { tab: 'results', query: VIEW_QUERY, ...marked(NOTHING_MARKED) },
    { tab: 'results', query: VIEW_QUERY, ...marked(SUB_TWO_MARKED) },
    { tab: 'results', query: VIEW_QUERY, ...marked(SUB_TWO_MARKED) },
    { tab: 'results', query: VIEW_QUERY, ...marked(SUB_TWO_MARKED) },
    { tab: 'results', query: VIEW_QUERY, ...marked(SUB_TWO_MARKED) },
  );
  const views: Matrix = {
    probe: async seed => {
      const list = await BODY(await (await import('@/app/api/views/route')).GET()) as { id: string; query: string; tab: string; outsideAccess: unknown }[];
      return viewOf(list.find(v => v.id === seed.savedViewId)!);
    },
    expected: viewExpected,
  };
  const viewById: Matrix = {
    probe: async seed => viewOf(await BODY(await getWith('/api/views/x', await import('@/app/api/views/[id]/route'), seed.savedViewId)) as never),
    expected: viewExpected,
  };

  // Only an Editor or an Admin may duplicate, and they hold Everything here, so the copy's marks are empty.
  const FORBIDDEN = { status: 403, filters: undefined, marks: undefined };
  const duplicate: Matrix = {
    probe: async seed => {
      const route = await import('@/app/api/dashboards/[id]/duplicate/route');
      const res = await route.POST(new Request('http://localhost/api/dashboards/x/duplicate', { method: 'POST' }), { params: Promise.resolve({ id: seed.dashboardId }) });
      const body = await res.json() as { outsideAccess?: unknown; config?: { filters?: unknown } };
      return { status: res.status, filters: body.config?.filters, marks: body.outsideAccess };
    },
    expected: byPerson(
      same({ status: 201, filters: { subscriptions: [SUB_TWO] }, marks: NOTHING_MARKED }),
      same(FORBIDDEN), same(FORBIDDEN), same(FORBIDDEN), same(FORBIDDEN), same(FORBIDDEN),
    ),
  };

  return {
    'widgets/summary': summary, 'widgets/findings': findings, 'widgets/top-rules': topRules, 'widgets/top-resources': topResources,
    'widgets/advisories': advisories, 'widgets/filter-options': filterOptions,
    'dashboards': dashboards, 'dashboards/[id]': dashboardById, 'dashboards/[id]/duplicate': duplicate, 'views': views, 'views/[id]': viewById,
  };
}

/** Routes that narrow what a person sees, and what each person gets from them. */
const FINDINGS_MATRIX: Record<string, Matrix> = {
  'access': ownAccess,
  'findings/view': viewEntry,
  'findings/group': group,
  'findings/column-values': columnValues,
  'findings/export': exported,
  'findings/rows': rows,
  ...dashboardMatrix(),
};

// #277: the routes that send a query a person wrote to Azure. Every one asks `rules:validate` or
// `rules:write`, which the five Viewers do not hold, so each is refused by the guard, before anything
// reaches Azure. The Admin and the Editor on Everything send an unlimited request: no scope at all.
const MATRIX_RULE_ID = 'matrix-written-rule';
const MATRIX_KQL = 'resources | project id';

interface WrittenReply { status: number; error: string | undefined; scope: unknown; requests: number }

/** Calls a route over a fresh fake Azure and reports what came back and what the fake was asked. */
async function writtenReply(send: () => Promise<Response>): Promise<WrittenReply> {
  fakeCtx = fakeTenantContext({ logsRows: [{ user: 'a@example.com' }] });
  const res = await send();
  const body = await res.json() as { error?: string };
  return {
    status: res.status,
    error: body.error,
    scope: fakeCtx.queries[0]?.scope,
    requests: fakeCtx.queries.length + fakeCtx.graphRequests.length + fakeCtx.logsQueries.length,
  };
}

const sendJson = (url: string, method: string, body: unknown): Request =>
  new Request(`http://localhost${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const FORBIDDEN: WrittenReply = { status: 403, error: 'Forbidden', scope: undefined, requests: 0 };

/** The Admin and the Editor on Everything get `answered`; the five Viewers get the guard's 403. */
const writtenExpectation = (status: number, requests: number): Matrix['expected'] => {
  const unlimited = same({ status, error: undefined, scope: undefined, requests });
  const refused = same(FORBIDDEN);
  return {
    'Admin': unlimited,
    'Editor on Everything': unlimited,
    'Viewer on the management group': refused,
    'Viewer on one subscription': refused,
    'Viewer on one resource group': refused,
    'Directory only': refused,
    'No Scope': refused,
  };
};

let createdRules = 0;
const ruleBody = (name: string) => ({
  name, description: 'a rule', category: 'security', severity: 'medium', enabled: true, type: 'custom',
  scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: MATRIX_KQL,
});

const WRITTEN_QUERY_MATRIX: Record<string, Matrix> = {
  'query/run-resource-graph': {
    probe: async () => writtenReply(async () => (await import('@/app/api/query/run-resource-graph/route')).POST(
      sendJson('/api/query/run-resource-graph', 'POST', { kql: MATRIX_KQL }))),
    expected: writtenExpectation(200, 1),
  },
  'query/run-microsoft-graph': {
    probe: async () => writtenReply(async () => (await import('@/app/api/query/run-microsoft-graph/route')).POST(
      sendJson('/api/query/run-microsoft-graph', 'POST', { graphQuery: { path: 'users' } }))),
    expected: writtenExpectation(200, 1),
  },
  'query/run-log-analytics': {
    probe: async () => writtenReply(async () => (await import('@/app/api/query/run-log-analytics/route')).POST(
      sendJson('/api/query/run-log-analytics', 'POST', { logsQuery: { kql: 'SigninLogs' } }))),
    expected: writtenExpectation(200, 1),
  },
  'rules/validate-kql': {
    probe: async () => writtenReply(async () => (await import('@/app/api/rules/validate-kql/route')).POST(
      sendJson('/api/rules/validate-kql', 'POST', { kql: MATRIX_KQL }))),
    expected: writtenExpectation(200, 1),
  },
  'rules/validate-graph': {
    probe: async () => writtenReply(async () => (await import('@/app/api/rules/validate-graph/route')).POST(
      sendJson('/api/rules/validate-graph', 'POST', { graphQuery: { path: 'users' } }))),
    expected: writtenExpectation(200, 1),
  },
  'rules/validate-logs': {
    probe: async () => writtenReply(async () => (await import('@/app/api/rules/validate-logs/route')).POST(
      sendJson('/api/rules/validate-logs', 'POST', { logsQuery: { kql: 'SigninLogs', timeWindowDays: 30 } }))),
    expected: writtenExpectation(200, 1),
  },
  // Saving needs `rules:write`, which only Everything holds, so the save-time probe is unchanged.
  'rules': {
    probe: async () => writtenReply(async () => (await import('@/app/api/rules/route')).POST(
      sendJson('/api/rules', 'POST', ruleBody(`matrix written rule ${++createdRules}`)))),
    expected: writtenExpectation(201, 1),
  },
  'rules/[id]': {
    probe: async () => writtenReply(async () => (await import('@/app/api/rules/[id]/route')).PUT(
      sendJson(`/api/rules/${MATRIX_RULE_ID}`, 'PUT', ruleBody('matrix written rule saved')),
      { params: Promise.resolve({ id: MATRIX_RULE_ID }) })),
    expected: writtenExpectation(200, 1),
  },
};

/** Every route that narrows what a person sees or sends. */
export const MATRIX: Record<string, Matrix> = { ...FINDINGS_MATRIX, ...WRITTEN_QUERY_MATRIX };

export interface ListProblems {
  unlisted: string[];
  inBoth: string[];
  missingFile: string[];
}

/** Compares the two lists with the route files found on disk. */
export function checkLists(
  routes: Map<string, boolean>, matrix: Record<string, unknown>, notYetScoped: Record<string, unknown>,
): ListProblems {
  const unlisted = [...routes].filter(([name, usesAccess]) => usesAccess && !(name in matrix) && !(name in notYetScoped)).map(([name]) => name);
  const inBoth = Object.keys(matrix).filter(name => name in notYetScoped);
  const missingFile = [...Object.keys(matrix), ...Object.keys(notYetScoped)].filter(name => !routes.has(name));
  return { unlisted, inBoth, missingFile };
}

const diskRoutes = new Map<string, boolean>();
for (const file of routeFiles(API_DIR)) diskRoutes.set(routeName(file), USES_ACCESS.test(stripComments(readFileSync(file, 'utf8'))));

describe('the lists are checked against the route files on disk', () => {
  it('finds the routes, and the ones that use the actor\'s access', () => {
    expect(diskRoutes.size).toBeGreaterThan(20);
    for (const name of ['findings/view', 'widgets/summary', 'scans/run', 'schedules/[id]/runs', 'suppressions']) {
      expect(diskRoutes.get(name), name).toBe(true);
    }
    expect([...diskRoutes.values()].filter(Boolean).length).toBeGreaterThan(20);
  });

  it('reads the actor\'s access off a route\'s source and ignores a comment', () => {
    expect(USES_ACCESS.test(stripComments('await queryView(view, q, actor.access);'))).toBe(true);
    expect(USES_ACCESS.test(stripComments('// uses actor.access later\nawait list();'))).toBe(false);
    expect(USES_ACCESS.test(stripComments('/* actor.access */ await list();'))).toBe(false);
  });

  it('has every route that uses the actor\'s access in exactly one list, naming only routes that exist', () => {
    expect(checkLists(diskRoutes, MATRIX, NOT_YET_SCOPED)).toEqual({ unlisted: [], inBoth: [], missingFile: [] });
  });

  it('names the ticket that removes each route from NOT_YET_SCOPED', () => {
    for (const [name, entry] of Object.entries(NOT_YET_SCOPED)) {
      expect(entry.ticket, name).toMatch(/^#\d+$/);
      expect(Boolean(entry.probe) !== Boolean(entry.unprobed), `${name} has a probe or a reason it has none`).toBe(true);
    }
  });

  it('only lists a route file that is there', () => {
    for (const name of Object.keys(NOT_YET_SCOPED)) {
      expect(existsSync(path.join(API_DIR, name, 'route.ts')), name).toBe(true);
    }
  });

  describe('checkLists on fixtures', () => {
    const routes = new Map([['findings/view', true], ['findings/new', true], ['widgets/rules', false], ['views', false]]);

    it('flags a route that uses access and is in neither list', () => {
      expect(checkLists(routes, {}, { 'findings/view': {} }).unlisted).toEqual(['findings/new']);
    });

    it('does not flag a route that does not use access', () => {
      expect(checkLists(routes, {}, { 'findings/view': {}, 'findings/new': {} }).unlisted).toEqual([]);
    });

    it('flags a route in both lists', () => {
      expect(checkLists(routes, { 'findings/view': {} }, { 'findings/view': {}, 'findings/new': {} }).inBoth).toEqual(['findings/view']);
    });

    it('flags an entry naming a route file that no longer exists', () => {
      expect(checkLists(routes, {}, { 'findings/view': {}, 'findings/new': {}, 'findings/gone': {} }).missingFile).toEqual(['findings/gone']);
    });
  });
});

describe('every person reads what the Admin reads', () => {
  const userIds: Record<string, string> = {};
  let seed: MatrixSeed;
  let adminBodies: Record<string, string>;

  const probed = Object.entries(NOT_YET_SCOPED).filter(([, entry]) => entry.probe);

  async function call(person: string, probe: Probe): Promise<{ status: number; body: string }> {
    mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
    const res = await probe(seed);
    return { status: res.status, body: await res.text() };
  }

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    seed = await seedMatrix();
    adminBodies = {};
    for (const [name, entry] of probed) adminBodies[name] = (await call('Admin', entry.probe!)).body;
  });

  it('seeds seven people', () => {
    expect(PEOPLE.map(p => p.name)).toEqual([
      'Admin', 'Editor on Everything', 'Viewer on the management group', 'Viewer on one subscription',
      'Viewer on one resource group', 'Directory only', 'No Scope',
    ]);
    expect(Object.keys(userIds)).toHaveLength(7);
  });

  it('runs every stored-data GET, and finds the seeded data in the Admin\'s answers', () => {
    expect(probed.length).toBeGreaterThanOrEqual(8);
    expect(adminBodies['suppressions']).toContain(seed.suppressedFingerprint);
    expect(adminBodies['schedules/[id]/runs']).toContain(seed.runId);
    expect(adminBodies['scans/[id]/snapshot']).toContain('vm-other-sub');
    expect(adminBodies['scans/compare']).toContain('directory-app');
  });

  for (const person of PEOPLE.map(p => p.name).filter(n => n !== 'Admin')) {
    it(`${person} gets a 200 whose body equals the Admin's from every route`, async () => {
      for (const [name, entry] of probed) {
        const answer = await call(person, entry.probe!);
        expect(answer.status, `${person} ${name}`).toBe(200);
        expect(answer.body, `${person} ${name}`).toBe(adminBodies[name]);
      }
    });
  }
});

describe('the findings routes show each person only what their Scopes cover', () => {
  const userIds: Record<string, string> = {};
  let seed: MatrixSeed;

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    seed = await seedMatrix();
  });

  it('holds an expectation for every person, route and tab', () => {
    for (const entry of Object.values(MATRIX)) {
      expect(Object.keys(entry.expected).sort()).toEqual(PEOPLE.map(p => p.name).sort());
      for (const byTab of Object.values(entry.expected)) expect(Object.keys(byTab).sort()).toEqual([...VIEW_TABS].sort());
    }
  });

  for (const [route, entry] of Object.entries(FINDINGS_MATRIX)) {
    for (const person of PEOPLE.map(p => p.name)) {
      for (const tab of VIEW_TABS) {
        it(`${route}: ${person}, ${tab} tab`, async () => {
          mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
          expect(await entry.probe(seed, tab)).toEqual(entry.expected[person]![tab]);
        });
      }
    }
  }

  /** A new Viewer holding exactly these Scopes, signed in, and what the Results and Advisories tabs list for them. */
  async function listedFor(...scopes: string[]): Promise<{ results: string[]; advisories: string[] }> {
    const created = await createUser({ email: `extra${scopes.length}-${Math.random().toString(36).slice(2)}@example.com`, role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await inTransaction(tx => replaceAssignmentsOn(tx, created.user.id, scopes.map(scope => ({ tenantId: MATRIX_TENANT, scope, role: 'viewer' as const }))));
    mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
    const read = async (tab: ViewTab) => ((await viewEntry.probe(seed, tab)) as { names: string[] }).names;
    return { results: await read('results'), advisories: await read('advisories') };
  }

  it('compares subscription ids and resource group names without regard to case', async () => {
    expect(await listedFor(SCOPE_SUBSCRIPTION.toUpperCase())).toEqual({ results: ['subscription-level', 'vm-one'], advisories: ['advisory-one'] });
    const shouted = `/SUBSCRIPTIONS/${SUB_ONE.toUpperCase()}/RESOURCEGROUPS/RG-ONE`;
    expect(await listedFor(shouted)).toEqual({ results: ['vm-one'], advisories: ['advisory-one'] });
  });

  it('adds overlapping Scopes up: a subscription and a resource group in another subscription see the union', async () => {
    const otherGroup = `/subscriptions/${SUB_TWO}/resourceGroups/rg-one`;
    expect(await listedFor(SCOPE_SUBSCRIPTION, otherGroup)).toEqual({
      results: ['subscription-level', 'vm-one', 'vm-other-sub'], advisories: ['advisory-one', 'advisory-other-sub'],
    });
    expect(await listedFor(SCOPE_RESOURCE_GROUP, SCOPE_DIRECTORY)).toEqual({ results: ['directory-app', 'vm-one'], advisories: ['advisory-one'] });
    expect(await listedFor(SCOPE_SUBSCRIPTION, SCOPE_RESOURCE_GROUP)).toEqual({ results: ['subscription-level', 'vm-one'], advisories: ['advisory-one'] });
  });

  it('shows a person with a resource group in one subscription nothing from a same-named group in another', async () => {
    expect(await listedFor(`/subscriptions/${SUB_TWO}/resourceGroups/rg-two`)).toEqual({ results: [], advisories: [] });
  });

  it('shows nothing, never everything, to a person who holds no usable Scope', async () => {
    expect(await listedFor()).toEqual({ results: [], advisories: [] });
  });

  it('answers a request filtered to a subscription outside the person\'s access with a 200 and an empty result', async () => {
    const ask = async (route: string, query: string) => {
      const handler = await import(`@/app/api/${route}/route`) as { GET(req: Request): Promise<Response> };
      const res = await handler.GET(new Request(`http://localhost/api/${route}?${query}`));
      expect(res.status, route).toBe(200);
      return res.json() as Promise<Record<string, unknown>>;
    };
    for (const person of ['Viewer on one subscription', 'Viewer on one resource group']) {
      mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
      const outside = `subscriptions=${SUB_TWO}`;
      const summary = await ask('widgets/summary', outside) as { current: { activeFindings: number }; perSubscription: unknown[] };
      expect(summary.current.activeFindings, person).toBe(0);
      expect(summary.perSubscription, person).toEqual([]);
      expect(await ask('widgets/findings', outside), person).toEqual([]);
      expect(await ask('widgets/top-rules', outside), person).toEqual([]);
      expect(await ask('widgets/top-resources', outside), person).toEqual([]);
      expect((await ask('widgets/advisories', outside) as { total: number }).total, person).toBe(0);
      await ask('widgets/filter-options', outside);
      const view = await ask('findings/view', `subscription=${SUB_TWO}`) as { total: number; items: unknown[] };
      expect(view.total, person).toBe(0);
      expect(view.items, person).toEqual([]);
    }
  });

  it('answers a finding outside the Scopes with the body of one that does not exist', async () => {
    const route = await import('@/app/api/findings/rows/route');
    mockAuth.mockResolvedValue({ user: { uid: userIds['Viewer on one resource group'] } });
    const ask = (fingerprint: string) => route.GET(new Request(`http://localhost/api/findings/rows?${tabParams('results')}&fingerprint=${fingerprint}`));
    const outside = await ask(seed.fingerprints['vm-other-sub']!);
    const unknown = await ask('0000000000000000');
    expect(outside.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await outside.text()).toBe(await unknown.text());
  });
});

describe('the routes that send a written query give each person what their Scopes allow', () => {
  const userIds: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    await saveRules([{ ...ruleBody('matrix written rule saved'), id: MATRIX_RULE_ID } as unknown as Rule]);
  });

  it('holds an expectation for each of the eight routes', () => {
    expect(Object.keys(WRITTEN_QUERY_MATRIX).sort()).toEqual([
      'query/run-log-analytics', 'query/run-microsoft-graph', 'query/run-resource-graph', 'rules', 'rules/[id]',
      'rules/validate-graph', 'rules/validate-kql', 'rules/validate-logs',
    ]);
  });

  for (const [route, entry] of Object.entries(WRITTEN_QUERY_MATRIX)) {
    for (const person of PEOPLE.map(p => p.name)) {
      for (const tab of VIEW_TABS) {
        it(`${route}: ${person}, ${tab} tab`, async () => {
          mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
          expect(await entry.probe({} as MatrixSeed, tab)).toEqual(entry.expected[person]![tab]);
        });
      }
    }
  }
});
