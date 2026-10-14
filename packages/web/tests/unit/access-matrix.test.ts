/**
 * The access matrix (#270). Seven people who hold different Scopes call every route that uses the actor's
 * access through the real `requireRole` (only the session, `@/auth`, is mocked) and the real repositories, and
 * each gets what their Scopes allow, written by hand in `MATRIX`. The routes that read findings share one data
 * set written through the real write paths, with expectations written by hand from the seed in
 * `tests/helpers/access-matrix.ts`: #272 did so for the five `findings/*` routes, #274 for the six widget
 * routes, the two dashboard routes and the two saved view routes, and #276 for the eight Run History and Run now
 * routes. The routes that call Azure (#277's eight that send a query a person wrote, the three pickers of #275,
 * and the five install-administration and schema routes of #284) go through a fake Azure rather than read the
 * seed, so their probes report the status, the body and how many requests the fake was sent, and each runs in
 * its own `describe` over its own database. `suppressions` reads the seed, and the rule list, the Rules tab
 * counts and the write routes are checked by tables of their own below, since a `MATRIX` key is a route file
 * and these are several tables over one.
 *
 * `MATRIX` is checked against the route files on disk, the way `route-guards.test.ts` checks guards: a route
 * that uses the actor's access must have an entry, and an entry must name a route file that exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, getUser } from '@/lib/db/users';
import { loadRules, saveRules } from '@/lib/rules';
import { createCategory, listCategories } from '@/lib/db/categories';
import { createSchedule, listSchedules } from '@/lib/db/schedules';
import { countAuditEntries, listAuditEntries } from '@/lib/db/audit';
import { listFindingSummaries } from '@/lib/db/findings';
import { queryRuleFindingCounts } from '@/lib/db/finding-views';
import { addSuppression, loadSuppressions, removeSuppression, saveSuppressions } from '@/lib/suppressions';
import { everythingAccess } from '@/lib/access-model';
import { resolveAccess } from '@/lib/access';
import type { Action } from '@/lib/rbac';
import { fakeTenantContext, type FakeTenantContext } from '../helpers/fake-azure';
import type { Rule } from '@rulebeat/core';
import { replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { createPersonalRule, replacePersonalRuleResults } from '@/lib/db/personal-rules';
import {
  createPeople, matrixHierarchy, MANAGEMENT_GROUP, MATRIX_NOW, MATRIX_TENANT, PEOPLE, SCOPE_DIRECTORY, SCOPE_MANAGEMENT_GROUP, SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, SCOPED_RULE_ID,
  SCOPED_RULE_KQL, SCOPED_RULE_NAME, SNAPSHOT_DAYS, SUB_ONE, SUB_TWO, seedMatrix, seedScopedRule, type MatrixSeed,
} from '../helpers/access-matrix';
import type { OwnAccess } from '@/lib/access';
import { refreshFrom } from '../helpers/fake-hierarchy';
import { writeResourceTypesCache, writeSchemaCache } from '@/lib/schema-cache';
import { emptyView, viewToSearchParams, type View } from '@/lib/finding-view';
import { VIEW_TABS, type ViewTab } from '@/lib/view-response';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve(fakeCtx) };
});

// The three picker routes call ARM directly rather than through a tenant context, so ARM is faked here: two
// subscriptions under one management group, and a sibling group with nothing under it.
const FAKE_TENANT_NAME = 'Tenant Root Group';
const SIBLING_GROUP = 'mg-other';
const GROUP_TYPE = '/providers/Microsoft.Management/managementGroups';
const fakeSubscription = (id: string, displayName: string) => ({ name: id, type: '/subscriptions', displayName });
vi.mock('@/lib/arm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/arm')>('@/lib/arm');
  return {
    ...actual,
    getArmCredential: () => Promise.resolve({}),
    getArmToken: () => Promise.resolve('token'),
    getArmTenantId: () => Promise.resolve(MATRIX_TENANT),
    armFetch: (url: string) => {
      if (url.includes(`managementGroups/${MATRIX_TENANT}`)) {
        return Promise.resolve({
          name: MATRIX_TENANT,
          properties: {
            displayName: FAKE_TENANT_NAME,
            children: [
              { name: MANAGEMENT_GROUP, type: GROUP_TYPE, displayName: 'Example group', children: [fakeSubscription(SUB_ONE, 'Sub one'), fakeSubscription(SUB_TWO, 'Sub two')] },
              { name: SIBLING_GROUP, type: GROUP_TYPE, displayName: 'Other group', children: [] },
            ],
          },
        });
      }
      return Promise.resolve({
        value: [
          { name: MANAGEMENT_GROUP, properties: { displayName: 'Example group' } },
          { name: SIBLING_GROUP, properties: { displayName: 'Other group' } },
        ],
      });
    },
  };
});
vi.mock('@azure/arm-resources-subscriptions', () => ({
  SubscriptionClient: class {
    subscriptions = {
      list: async function* () {
        yield { subscriptionId: SUB_ONE, displayName: 'Sub one', state: 'Enabled' };
        yield { subscriptionId: SUB_TWO, displayName: 'Sub two', state: 'Enabled' };
      },
    };
  },
}));

// The schema refresh asks ARM for each common resource type's provider. The fake answers for one type and says
// the rest have no properties, so a refresh reaches no Azure and writes one schema.
const SCHEMA_TYPE = 'microsoft.compute/virtualmachines';
vi.mock('@azure/arm-resources', () => ({
  ResourceManagementClient: class {
    providers = {
      get: async (namespace: string) => ({
        resourceTypes: namespace === 'microsoft.compute'
          ? [{ resourceType: 'virtualmachines', aliases: [{ defaultPath: 'properties.hardwareProfile.vmSize' }] }]
          : [],
      }),
    };
  },
}));

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

/** Every suppression a person is shown: the seed holds one, on `vm-two` (subscription one, `rg-two`). */
const suppressionsList: Matrix = {
  probe: async seed => {
    const body = await BODY(await (await import('@/app/api/suppressions/route')).GET()) as { fingerprint: string }[];
    return namesOf(seed, body);
  },
  // vm-two sits in subscription one, so a Viewer on that subscription sees it, and so does a Viewer on the management
  // group over it; a Viewer on only `rg-one` does not.
  expected: byPerson(same(['vm-two']), same(['vm-two']), same(['vm-two']), same([]), same([]), same([])),
};

/**
 * Removing a suppression on `vm-two`: a fresh one is stored for each call and removed again, so the seed's own is
 * never touched. Removal asks `suppressions:write`, which the five Viewers do not hold, so each is refused by the
 * guard. What a scoped Editor gets, by where the finding sits, is in the suppression `describe` further down.
 */
const suppressionRemoval: Matrix = {
  probe: async seed => {
    const id = globalThis.crypto.randomUUID();
    await addSuppression({ id, fingerprint: seed.fingerprints['vm-two']!, reason: 'removed by the matrix', suppressedAt: DATE });
    const res = await (await import('@/app/api/suppressions/[id]/route')).DELETE(
      new Request(`http://localhost/api/suppressions/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) },
    );
    await removeSuppression(id);
    return res.status;
  },
  expected: byPerson(same(204), same(403), same(403), same(403), same(403), same(403)),
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

/**
 * #276: Run History. The seed's schedule has two runs. The later covered Everything, produced the second scan
 * (all ten findings) and stored 10 findings with 3 new (`vm-one`, `vm-other-sub`, `directory-app`). The earlier
 * covered subscription one only and produced a third scan holding that subscription's five findings. Every number
 * below is counted by hand from the seed, for what each person's access reaches: never the 10 and 3 the run stored.
 *
 * Findings by placement: `vm-one`, `vm-two`, `subscription-level`, `workspace-user` and `advisory-one` are in
 * subscription one; `vm-other-sub` and `advisory-other-sub` in subscription two; `management-group-level` sits at
 * the group; `directory-app` in the Directory; `unplaceable-thing` nowhere.
 */
const OUTSIDE = 'Outside your access';
type RunBody = { totalFindings: number; newFindings: number; countsUnavailable: boolean; coveredScope: { entries: { label: string }[] } };
const runNumbers = (r: RunBody) =>
  ({ total: r.totalFindings, new: r.newFindings, unavailable: r.countsUnavailable, scope: r.coveredScope.entries.map(e => e.label) });
const EVERYTHING_RUN = (total: number, added: number) => ({ total, new: added, unavailable: false, scope: ['Everything'] });
const SUBSCRIPTION_ONE_RUN = (total: number, scope: string) => ({ total, new: 0, unavailable: false, scope: [scope] });

type Who = 'everything' | 'managementGroup' | 'subscription' | 'resourceGroup' | 'directory' | 'nothing';
const WHO: readonly Who[] = ['everything', 'managementGroup', 'subscription', 'resourceGroup', 'directory', 'nothing'];

// What each person gets of the later run (Everything) and the earlier one (subscription one).
const LATER_RUN: Record<Who, unknown> = {
  everything: EVERYTHING_RUN(10, 3), managementGroup: EVERYTHING_RUN(8, 2), subscription: EVERYTHING_RUN(5, 1),
  resourceGroup: EVERYTHING_RUN(3, 1), directory: EVERYTHING_RUN(1, 1), nothing: EVERYTHING_RUN(0, 0),
};
const EARLIER_RUN: Record<Who, unknown> = {
  everything: SUBSCRIPTION_ONE_RUN(5, SCOPE_SUBSCRIPTION), managementGroup: SUBSCRIPTION_ONE_RUN(5, SCOPE_SUBSCRIPTION),
  subscription: SUBSCRIPTION_ONE_RUN(5, SCOPE_SUBSCRIPTION), resourceGroup: SUBSCRIPTION_ONE_RUN(3, OUTSIDE),
  directory: SUBSCRIPTION_ONE_RUN(0, OUTSIDE), nothing: SUBSCRIPTION_ONE_RUN(0, OUTSIDE),
};
const perPerson = (by: Record<Who, unknown>): Matrix['expected'] =>
  byPerson(same(by.everything), same(by.managementGroup), same(by.subscription), same(by.resourceGroup), same(by.directory), same(by.nothing));

const ALL_NAMES = [
  'advisory-one', 'advisory-other-sub', 'directory-app', 'management-group-level', 'subscription-level',
  'unplaceable-thing', 'vm-one', 'vm-other-sub', 'vm-two', 'workspace-user',
];
const SNAPSHOT_NAMES: Record<Who, string[]> = {
  everything: ALL_NAMES,
  managementGroup: ALL_NAMES.filter(n => !['directory-app', 'unplaceable-thing'].includes(n)),
  subscription: ['advisory-one', 'subscription-level', 'vm-one', 'vm-two', 'workspace-user'],
  resourceGroup: ['advisory-one', 'vm-one', 'workspace-user'],
  directory: ['directory-app'],
  nothing: [],
};
// Every seeded finding is High, so the severity facet is one value; the rules are the matrix rule and the advisory one.
const SNAPSHOT_FACETS: Record<Who, { severity: [string, number][]; rule: [string, number][] }> = {
  everything: { severity: [['high', 10]], rule: [['matrix-advisory-rule', 2], ['matrix-rule', 8]] },
  managementGroup: { severity: [['high', 8]], rule: [['matrix-advisory-rule', 2], ['matrix-rule', 6]] },
  subscription: { severity: [['high', 5]], rule: [['matrix-advisory-rule', 1], ['matrix-rule', 4]] },
  resourceGroup: { severity: [['high', 3]], rule: [['matrix-advisory-rule', 1], ['matrix-rule', 2]] },
  directory: { severity: [['high', 1]], rule: [['matrix-rule', 1]] },
  nothing: { severity: [], rule: [] },
};

// The first scan (five findings) against the second (all ten), each as the person sees it.
const COMPARE: Record<Who, { totals: { added: number; fixed: number; persisted: number }; added: string[] }> = {
  everything: { totals: { added: 5, fixed: 0, persisted: 5 }, added: ['advisory-one', 'advisory-other-sub', 'directory-app', 'unplaceable-thing', 'workspace-user'] },
  managementGroup: { totals: { added: 3, fixed: 0, persisted: 5 }, added: ['advisory-one', 'advisory-other-sub', 'workspace-user'] },
  subscription: { totals: { added: 2, fixed: 0, persisted: 3 }, added: ['advisory-one', 'workspace-user'] },
  resourceGroup: { totals: { added: 2, fixed: 0, persisted: 1 }, added: ['advisory-one', 'workspace-user'] },
  directory: { totals: { added: 1, fixed: 0, persisted: 0 }, added: ['directory-app'] },
  nothing: { totals: { added: 0, fixed: 0, persisted: 0 }, added: [] },
};

const byWho = <T,>(make: (who: Who) => T): Record<Who, T> => Object.fromEntries(WHO.map(who => [who, make(who)])) as Record<Who, T>;

function runHistoryMatrix(): Record<string, Matrix> {
  const scansRun: Matrix = {
    probe: async () => runNumbers(((await BODY(await get('/api/scans/run', await import('@/app/api/scans/run/route')))) as { run: RunBody }).run),
    expected: perPerson(LATER_RUN),
  };

  const scheduleRuns: Matrix = {
    probe: async seed => ((await BODY(await getWith('/api/schedules/x/runs', await import('@/app/api/schedules/[id]/runs/route'), seed.scheduleId))) as RunBody[]).map(runNumbers),
    expected: perPerson(byWho(who => [LATER_RUN[who], EARLIER_RUN[who]])),
  };

  const schedules: Matrix = {
    probe: async seed => {
      const list = await BODY(await get('/api/schedules', await import('@/app/api/schedules/route'))) as { id: string; lastRun: RunBody | null }[];
      return runNumbers(list.find(s => s.id === seed.scheduleId)!.lastRun!);
    },
    expected: perPerson(LATER_RUN),
  };

  const snapshot: Matrix = {
    probe: async seed => {
      const body = await BODY(await getWith(`/api/scans/${seed.scanIds[1]}/snapshot`, await import('@/app/api/scans/[id]/snapshot/route'), seed.scanIds[1])) as {
        total: number; items: { fingerprint: string }[]; facets: { severity: { value: string; count: number }[]; rule: { value: string; count: number }[] };
      };
      return {
        names: namesOf(seed, body.items), total: body.total,
        severity: body.facets.severity.map(f => [f.value, f.count]), rule: body.facets.rule.map(f => [f.value, f.count]),
      };
    },
    expected: perPerson(byWho(who => ({ names: SNAPSHOT_NAMES[who], total: SNAPSHOT_NAMES[who].length, ...SNAPSHOT_FACETS[who] }))),
  };

  const snapshotExport: Matrix = {
    probe: async seed => namesOf(seed, await BODY(await getWith(
      `/api/scans/${seed.scanIds[1]}/snapshot/export?format=json`, await import('@/app/api/scans/[id]/snapshot/export/route'), seed.scanIds[1],
    )) as { fingerprint: string }[]),
    expected: perPerson(SNAPSHOT_NAMES),
  };

  const compare: Matrix = {
    probe: async seed => {
      const body = await BODY(await get(`/api/scans/compare?compare=${seed.scanIds[0]}..${seed.scanIds[1]}`, await import('@/app/api/scans/compare/route'))) as {
        totals: unknown; items: { fingerprint: string }[];
      };
      return { totals: body.totals, added: namesOf(seed, body.items) };
    },
    expected: perPerson(COMPARE),
  };

  const compareExport: Matrix = {
    probe: async seed => namesOf(seed, await BODY(await get(
      `/api/scans/compare/export?compare=${seed.scanIds[0]}..${seed.scanIds[1]}&format=json`, await import('@/app/api/scans/compare/export/route'),
    )) as { fingerprint: string }[]),
    expected: perPerson(byWho(who => COMPARE[who].added)),
  };

  // Running a schedule changes the install for everyone, so it needs Everything. The probe names a schedule that
  // does not exist, so a person who is let through gets the handler's 404 and nothing runs against the seed; the
  // others get the guard's 403. Either way nothing reaches Azure.
  const scheduleRun: Matrix = {
    probe: async () => {
      fakeCtx = fakeTenantContext();
      const res = await (await import('@/app/api/schedules/[id]/run/route')).POST(
        new Request('http://localhost/api/schedules/none/run', { method: 'POST' }), { params: Promise.resolve({ id: 'no-such-schedule' }) });
      return { status: res.status, requests: fakeCtx.queries.length + fakeCtx.graphRequests.length + fakeCtx.logsQueries.length };
    },
    expected: perPerson(byWho(who => ({ status: who === 'everything' ? 404 : 403, requests: 0 }))),
  };

  return {
    'scans/run': scansRun, 'schedules/[id]/runs': scheduleRuns, 'schedules': schedules,
    'scans/[id]/snapshot': snapshot, 'scans/[id]/snapshot/export': snapshotExport,
    'scans/compare': compare, 'scans/compare/export': compareExport, 'schedules/[id]/run': scheduleRun,
  };
}

/** Routes that narrow what a person sees, and what each person gets from them. */
const FINDINGS_MATRIX: Record<string, Matrix> = {
  'suppressions': suppressionsList,
  'suppressions/[id]': suppressionRemoval,
  'access': ownAccess,
  'findings/view': viewEntry,
  'findings/group': group,
  'findings/column-values': columnValues,
  'findings/export': exported,
  'findings/rows': rows,
  ...dashboardMatrix(),
  ...runHistoryMatrix(),
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

// #280: the Personal rule routes. The one seeded Personal rule belongs to an author who is none of the
// seven people, so every one of them is a stranger to it: the list is empty, and the id answers 404 for the
// Admin and the Editor on Everything alike. The five Viewers hold no `rules:personal`, so a run is refused
// by the guard before the rule is looked up.
const PERSONAL_SECRET_NAME = 'personal-secret-vm';
const PERSONAL_SECRET_RULE = 'personal secret rule';
const PERSONAL_SECRET_ID = `/subscriptions/${SUB_ONE}/resourceGroups/rg-personal-secret/providers/Microsoft.Compute/virtualMachines/${PERSONAL_SECRET_NAME}`;
let personalRuleId = '';

/** One Personal rule with a stored result, owned by someone outside the seven. */
async function seedPersonalRule(): Promise<void> {
  const author = await createUser({ email: 'personal-author@example.com', role: 'editor' });
  if ('error' in author) throw new Error(author.error);
  const rule = await createPersonalRule(author.user.id, {
    name: PERSONAL_SECRET_RULE, description: '', category: 'security', severity: 'high', queryBackend: 'resource-graph', kind: 'state',
    scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: MATRIX_KQL,
  });
  await replacePersonalRuleResults(rule.id, author.user.id, {
    status: 'success', ranAt: DATE, coveredScope: '[]',
    results: [{ resourceId: PERSONAL_SECRET_ID, resourceName: PERSONAL_SECRET_NAME, severity: 'high', title: PERSONAL_SECRET_RULE, rows: [{ id: PERSONAL_SECRET_ID }] }],
  });
  personalRuleId = rule.id;
}

interface PersonalReply { status: number; body: unknown }

async function personalReply(send: () => Promise<Response>): Promise<PersonalReply> {
  fakeCtx = fakeTenantContext();
  const res = await send();
  return { status: res.status, body: await res.json() };
}

const NOT_FOUND_REPLY: PersonalReply = { status: 404, body: { error: 'Not found' } };
const FORBIDDEN_REPLY: PersonalReply = { status: 403, body: { error: 'Forbidden' } };

const PERSONAL_MATRIX: Record<string, Matrix> = {
  'personal-rules': {
    probe: async () => personalReply(async () => (await import('@/app/api/personal-rules/route')).GET()),
    expected: byPerson(...Array(6).fill(same({ status: 200, body: [] })) as [ByTab, ByTab, ByTab, ByTab, ByTab, ByTab]),
  },
  'personal-rules/[id]': {
    probe: async () => personalReply(async () => (await import('@/app/api/personal-rules/[id]/route')).GET(
      new Request(`http://localhost/api/personal-rules/${personalRuleId}`), { params: Promise.resolve({ id: personalRuleId }) })),
    expected: byPerson(...Array(6).fill(same(NOT_FOUND_REPLY)) as [ByTab, ByTab, ByTab, ByTab, ByTab, ByTab]),
  },
  'personal-rules/[id]/run': {
    probe: async () => personalReply(async () => (await import('@/app/api/personal-rules/[id]/run/route')).POST(
      new Request(`http://localhost/api/personal-rules/${personalRuleId}/run`, { method: 'POST' }), { params: Promise.resolve({ id: personalRuleId }) })),
    expected: {
      'Admin': same(NOT_FOUND_REPLY),
      'Editor on Everything': same(NOT_FOUND_REPLY),
      'Viewer on the management group': same(FORBIDDEN_REPLY),
      'Viewer on one subscription': same(FORBIDDEN_REPLY),
      'Viewer on one resource group': same(FORBIDDEN_REPLY),
      'Directory only': same(FORBIDDEN_REPLY),
      'No Scope': same(FORBIDDEN_REPLY),
    },
  },
};

// #275: the three Azure pickers. The fake ARM lists both seed subscriptions under the seed management group, and a
// sibling group with nothing under it. A person who does not hold Everything is told only what they hold: the
// Viewer on one resource group is told of that group's subscription, and nothing else.
const SUB_ONE_ENTRY = { id: SUB_ONE, name: 'Sub one' };
const SUB_TWO_ENTRY = { id: SUB_TWO, name: 'Sub two' };
const SUB_ONE_NODE = { id: SUB_ONE, name: 'Sub one', type: 'subscription' };
const SUB_TWO_NODE = { id: SUB_TWO, name: 'Sub two', type: 'subscription' };
const GROUP_NODE = { id: MANAGEMENT_GROUP, name: 'Example group', type: 'managementGroup', children: [SUB_ONE_NODE, SUB_TWO_NODE] };
const SIBLING_NODE = { id: SIBLING_GROUP, name: 'Other group', type: 'managementGroup' };
const limitedTree = (children: unknown[]) => ({ tenantId: '', tenantName: '', children });

/** What each person gets when the Admin and the Editor get `everything` and the five Viewers get what they hold. */
const pickerExpectation = (everything: unknown, held: { group: unknown; subscription: unknown; resourceGroup: unknown; directory: unknown; none: unknown }): Matrix['expected'] => ({
  'Admin': same(everything),
  'Editor on Everything': same(everything),
  'Viewer on the management group': same(held.group),
  'Viewer on one subscription': same(held.subscription),
  'Viewer on one resource group': same(held.resourceGroup),
  'Directory only': same(held.directory),
  'No Scope': same(held.none),
});

const PICKER_MATRIX: Record<string, Matrix> = {
  'azure/subscriptions': {
    probe: async () => BODY(await (await import('@/app/api/azure/subscriptions/route')).GET()),
    expected: pickerExpectation([SUB_ONE_ENTRY, SUB_TWO_ENTRY], { group: [SUB_ONE_ENTRY, SUB_TWO_ENTRY], subscription: [SUB_ONE_ENTRY], resourceGroup: [SUB_ONE_ENTRY], directory: [], none: [] }),
  },
  'azure/management-groups': {
    probe: async () => BODY(await (await import('@/app/api/azure/management-groups/route')).GET()),
    expected: pickerExpectation(
      [{ id: MANAGEMENT_GROUP, name: 'Example group' }, { id: SIBLING_GROUP, name: 'Other group' }],
      { group: [{ id: MANAGEMENT_GROUP, name: 'Example group' }], subscription: [], resourceGroup: [], directory: [], none: [] },
    ),
  },
  'azure/scope-tree': {
    probe: async () => BODY(await (await import('@/app/api/azure/scope-tree/route')).GET()),
    expected: pickerExpectation(
      { tenantId: MATRIX_TENANT, tenantName: FAKE_TENANT_NAME, children: [GROUP_NODE, SIBLING_NODE] },
      {
        group: limitedTree([GROUP_NODE]), subscription: limitedTree([SUB_ONE_NODE]), resourceGroup: limitedTree([SUB_ONE_NODE]),
        directory: limitedTree([]), none: limitedTree([]),
      },
    ),
  },
};

const SCOPE_LEVEL = 'subscription';
/**
 * The scoped seed rule's `scope`, as each person is sent it, written by hand from `seedScopedRule`: it names both
 * seed subscriptions and the management group. A hidden entry is counted, never named. A Viewer on one resource
 * group holds that group's subscription for this purpose, and a Viewer on the management group holds the
 * subscriptions under it, so the rule is shown to them whole.
 */
const RULE_SCOPE_EXPECTED = pickerExpectation(
  { level: SCOPE_LEVEL, subscriptions: [SUB_ONE, SUB_TWO], managementGroups: [MANAGEMENT_GROUP] },
  {
    group: { level: SCOPE_LEVEL, subscriptions: [SUB_ONE, SUB_TWO], managementGroups: [MANAGEMENT_GROUP] },
    subscription: { level: SCOPE_LEVEL, subscriptions: [SUB_ONE], outsideAccess: 2 },
    resourceGroup: { level: SCOPE_LEVEL, subscriptions: [SUB_ONE], outsideAccess: 2 },
    directory: { level: SCOPE_LEVEL, outsideAccess: 3 },
    none: { level: SCOPE_LEVEL, outsideAccess: 3 },
  },
);

/**
 * The versions route answers for any rule id, and a custom rule's current definition carries its scope, so it is
 * narrowed the way the rule list is. It reads the scoped seed rule, which the rule list's `describe` below seeds.
 */
const RULE_VERSIONS: Matrix = {
  probe: async () => {
    const route = await import('@/app/api/rules/[id]/versions/route');
    const body = await BODY(await route.GET(new Request('http://localhost'), { params: Promise.resolve({ id: SCOPED_RULE_ID }) })) as {
      currentDefinition: { scope: unknown };
    };
    return body.currentDefinition.scope;
  },
  expected: RULE_SCOPE_EXPECTED,
};

// #284: the install-administration and schema routes. They use the actor's access only to build a tenant context,
// and read no findings. The two that need `users:manage` or `azure:manage` let only the Admin through, and
// `schemas` (POST needs `schemas:refresh`) lets the Editor on Everything in beside the Admin; the guard refuses
// everyone else before anything reaches Azure. The two `resources/*` routes need only `read`, answer from a fresh
// cache, and so give everyone the same body without a request to Azure.
const FORBIDDEN_AZURE: AzureReply = { status: 403, body: { error: 'Forbidden' }, requests: 0 };
const KNOWN_TYPES = [SCHEMA_TYPE, 'microsoft.storage/storageaccounts'];
const KNOWN_FIELDS = ['name', 'properties.hardwareProfile.vmSize'];

interface AzureReply { status: number; body: unknown; requests: number }

/** Calls a route over a fresh fake Azure and reports what came back and how many requests the fake was sent. */
async function azureReply<Body = unknown>(
  send: () => Promise<Response>, reduce: (body: Body) => unknown = body => body, opts: Parameters<typeof fakeTenantContext>[0] = {},
): Promise<AzureReply> {
  fakeCtx = fakeTenantContext(opts);
  const res = await send();
  const body = await res.json() as Body;
  return {
    status: res.status,
    body: res.status === 200 ? reduce(body) : body,
    requests: fakeCtx.queries.length + fakeCtx.graphRequests.length + fakeCtx.logsQueries.length,
  };
}

/** What each person gets when the Admin and the Editor get what is written for them and the five Viewers get the guard's 403. */
const refusedBelow = (admin: AzureReply, editor: AzureReply): Matrix['expected'] => ({
  'Admin': same(admin),
  'Editor on Everything': same(editor),
  'Viewer on the management group': same(FORBIDDEN_AZURE),
  'Viewer on one subscription': same(FORBIDDEN_AZURE),
  'Viewer on one resource group': same(FORBIDDEN_AZURE),
  'Directory only': same(FORBIDDEN_AZURE),
  'No Scope': same(FORBIDDEN_AZURE),
});

/** Everyone, including a person with no Scope, gets `answer`. */
const everyone = (answer: AzureReply): Matrix['expected'] => byPerson(...Array(6).fill(same(answer)) as [ByTab, ByTab, ByTab, ByTab, ByTab, ByTab]);

const SCHEMAS_REFRESHED: AzureReply = { status: 200, body: { ok: [SCHEMA_TYPE], empty: 19, error: 0 }, requests: 0 };

const AZURE_ADMIN_MATRIX: Record<string, Matrix> = {
  'azure/subscriptions/[id]/resource-groups': {
    probe: async () => azureReply(
      async () => (await import('@/app/api/azure/subscriptions/[id]/resource-groups/route')).GET(
        new Request('http://localhost'), { params: Promise.resolve({ id: SUB_ONE }) }),
      undefined,
      { rows: [{ name: 'rg-two' }, { name: 'rg-one' }] },
    ),
    expected: refusedBelow({ status: 200, body: { resourceGroups: ['rg-one', 'rg-two'] }, requests: 1 }, FORBIDDEN_AZURE),
  },
  // The fake credential holds no token, so the credential check fails and the Graph check warns. What matters here
  // is who gets an answer, and that it is built from the fake and nothing else.
  'diagnostics/preflight': {
    probe: async () => {
      // The route logs the credential failure it is about to report, which is the failure this probe expects.
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        return await azureReply(
          async () => (await import('@/app/api/diagnostics/preflight/route')).GET(),
          (body: { overall: string; checks: { id: string; status: string }[]; subscriptions: unknown[] }) => ({
            overall: body.overall, checks: Object.fromEntries(body.checks.map(c => [c.id, c.status])), subscriptions: body.subscriptions,
          }),
          { rows: [{ subscriptionId: SUB_ONE, name: 'Sub one' }], subscriptionIds: [SUB_ONE] },
        );
      } finally {
        logged.mockRestore();
      }
    },
    expected: refusedBelow({
      status: 200,
      body: {
        overall: 'fail',
        checks: { credential: 'fail', subscriptions: 'ok', 'resource-graph': 'ok', 'graph-applications': 'warn' },
        subscriptions: [{ id: SUB_ONE, name: 'Sub one' }],
      },
      requests: 1,
    }, FORBIDDEN_AZURE),
  },
  'schemas': {
    probe: async () => azureReply(
      async () => (await import('@/app/api/schemas/route')).POST(),
      (body: { results: { type: string; status: string }[] }) => ({
        ok: body.results.filter(r => r.status === 'ok').map(r => r.type),
        empty: body.results.filter(r => r.status === 'empty').length,
        error: body.results.filter(r => r.status === 'error').length,
      }),
    ),
    expected: refusedBelow(SCHEMAS_REFRESHED, SCHEMAS_REFRESHED),
  },
  'resources/types': {
    probe: async () => {
      await writeResourceTypesCache(KNOWN_TYPES);
      return azureReply(async () => (await import('@/app/api/resources/types/route')).GET());
    },
    expected: everyone({ status: 200, body: { types: KNOWN_TYPES, source: 'cache' }, requests: 0 }),
  },
  'resources/properties': {
    probe: async () => {
      await writeSchemaCache(SCHEMA_TYPE, KNOWN_FIELDS);
      return azureReply(
        async () => (await import('@/app/api/resources/properties/route')).GET(new Request(`http://localhost/api/resources/properties?type=${SCHEMA_TYPE}`)),
        (body: { fields: string[]; source: string }) => ({ fields: body.fields, source: body.source }),
      );
    },
    expected: everyone({ status: 200, body: { fields: KNOWN_FIELDS, source: 'cache' }, requests: 0 }),
  },
};

/** Every route that narrows what a person sees or sends. */
export const MATRIX: Record<string, Matrix> = {
  ...FINDINGS_MATRIX, ...WRITTEN_QUERY_MATRIX, ...PICKER_MATRIX, ...PERSONAL_MATRIX, ...AZURE_ADMIN_MATRIX, 'rules/[id]/versions': RULE_VERSIONS,
};

export interface ListProblems {
  unlisted: string[];
  missingFile: string[];
}

/** Compares `MATRIX` with the route files found on disk. */
export function checkLists(routes: Map<string, boolean>, matrix: Record<string, unknown>): ListProblems {
  const unlisted = [...routes].filter(([name, usesAccess]) => usesAccess && !(name in matrix)).map(([name]) => name);
  const missingFile = Object.keys(matrix).filter(name => !routes.has(name));
  return { unlisted, missingFile };
}

const diskRoutes = new Map<string, boolean>();
for (const file of routeFiles(API_DIR)) diskRoutes.set(routeName(file), USES_ACCESS.test(stripComments(readFileSync(file, 'utf8'))));

describe('MATRIX is checked against the route files on disk', () => {
  it('finds the routes, and the ones that use the access of the person asking', () => {
    expect(diskRoutes.size).toBeGreaterThan(20);
    for (const name of ['findings/view', 'widgets/summary', 'scans/run', 'schedules/[id]/runs', 'suppressions']) {
      expect(diskRoutes.get(name), name).toBe(true);
    }
    expect([...diskRoutes.values()].filter(Boolean).length).toBeGreaterThan(20);
  });

  it('reads the access off a route source and ignores a comment', () => {
    expect(USES_ACCESS.test(stripComments('await queryView(view, q, actor.access);'))).toBe(true);
    expect(USES_ACCESS.test(stripComments('// uses actor.access later\nawait list();'))).toBe(false);
    expect(USES_ACCESS.test(stripComments('/* actor.access */ await list();'))).toBe(false);
  });

  it('has an entry for every route that uses the access of the person asking, naming only routes that exist', () => {
    expect(checkLists(diskRoutes, MATRIX)).toEqual({ unlisted: [], missingFile: [] });
  });

  describe('checkLists on fixtures', () => {
    const routes = new Map([['findings/view', true], ['findings/new', true], ['widgets/rules', false], ['views', false]]);

    it('flags a route that uses access and has no entry', () => {
      expect(checkLists(routes, { 'findings/view': {} }).unlisted).toEqual(['findings/new']);
    });

    it('does not flag a route that does not use access', () => {
      expect(checkLists(routes, { 'findings/view': {}, 'findings/new': {} }).unlisted).toEqual([]);
    });

    it('flags an entry naming a route file that no longer exists', () => {
      expect(checkLists(routes, { 'findings/view': {}, 'findings/new': {}, 'findings/gone': {} }).missingFile).toEqual(['findings/gone']);
    });
  });
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

  it('refuses a compare of two scans that covered different Scopes for every person, from both routes', async () => {
    const compare = await import('@/app/api/scans/compare/route');
    const exportRoute = await import('@/app/api/scans/compare/export/route');
    const ids = `compare=${seed.scanIds[1]}..${seed.scopedScanId}`;
    for (const person of PEOPLE.map(p => p.name)) {
      mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
      for (const res of [
        await compare.GET(new Request(`http://localhost/api/scans/compare?${ids}`)),
        await exportRoute.GET(new Request(`http://localhost/api/scans/compare/export?${ids}&format=json`)),
      ]) {
        expect([person, res.status, await res.json()]).toEqual([person, 400, {
          code: 'different-scopes',
          error: 'These two runs covered different scopes. Compare two runs that covered the same scope.',
        }]);
      }
    }
  });

  it('lists each scan in the picker with the Scope it covered, and gives two scans of one Scope one key', async () => {
    const history = await import('@/lib/scan-history');
    const { listScanMetas } = history;
    const { buildAccess, parseScope } = await import('@/lib/access-model');
    const viewer = buildAccess([{ tenantId: MATRIX_TENANT, scope: parseScope(SCOPE_RESOURCE_GROUP)!, role: 'viewer' }], 'manual');
    const metas = await listScanMetas('security', viewer, 10);
    const label = (id: string) => metas.find(m => m.id === id)!.coveredScope.entries.map(e => e.label);
    expect(label(seed.scanIds[0])).toEqual(['Everything']);
    expect(label(seed.scanIds[1])).toEqual(['Everything']);
    // Subscription one is wider than this person's resource group, so it reads as outside their access.
    expect(label(seed.scopedScanId)).toEqual(['Outside your access']);
    const keys = new Map(metas.map(m => [m.id, m.coveredScope.key]));
    expect(keys.get(seed.scanIds[0])).toBe(keys.get(seed.scanIds[1]));
    expect(keys.get(seed.scopedScanId)).not.toBe(keys.get(seed.scanIds[1]));
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

describe('the Personal rule routes answer every stranger the same', () => {
  const userIds: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    await seedPersonalRule();
  });

  it('holds an expectation for each of the three routes', () => {
    expect(Object.keys(PERSONAL_MATRIX).sort()).toEqual(['personal-rules', 'personal-rules/[id]', 'personal-rules/[id]/run']);
  });

  for (const [route, entry] of Object.entries(PERSONAL_MATRIX)) {
    for (const person of PEOPLE.map(p => p.name)) {
      it(`${route}: ${person}`, async () => {
        mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
        expect(await entry.probe({} as MatrixSeed, 'results')).toEqual(entry.expected[person]!.results);
      });
    }
  }
});

describe('the install-administration and schema routes answer each person by their Role', () => {
  const userIds: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
  });

  it('holds an expectation for each of the five routes', () => {
    expect(Object.keys(AZURE_ADMIN_MATRIX).sort()).toEqual([
      'azure/subscriptions/[id]/resource-groups', 'diagnostics/preflight', 'resources/properties', 'resources/types', 'schemas',
    ]);
  });

  for (const [route, entry] of Object.entries(AZURE_ADMIN_MATRIX)) {
    for (const person of PEOPLE.map(p => p.name)) {
      it(`${route}: ${person}`, async () => {
        mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
        expect(await entry.probe({} as MatrixSeed, 'results')).toEqual(entry.expected[person]!.results);
      });
    }
  }
});

describe('a Personal rule and its results appear in no shared response', () => {
  const userIds: Record<string, string> = {};
  const seen: string[] = [];

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    const seed = await seedMatrix();
    await saveRules([{ ...ruleBody('matrix written rule saved'), id: MATRIX_RULE_ID } as unknown as Rule]);
    await refreshFrom(matrixHierarchy());
    await seedScopedRule();
    await seedPersonalRule();

    // Every body a probe reads goes through Response.json() or text(), so recording those sees them all, on top of what each probe reports.
    const readJson = Response.prototype.json;
    const readText = Response.prototype.text;
    Response.prototype.json = async function (this: Response) { const value = await readJson.call(this); seen.push(JSON.stringify(value)); return value; };
    Response.prototype.text = async function (this: Response) { const value = await readText.call(this); seen.push(value); return value; };
    try {
      for (const person of PEOPLE.map(p => p.name)) {
        mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
        for (const [name, entry] of Object.entries(MATRIX)) {
          if (name.startsWith('personal-rules')) continue;
          for (const tab of VIEW_TABS) seen.push(`${person} ${name} ${tab} ${JSON.stringify(await entry.probe(seed, tab))}`);
        }
      }
    } finally {
      Response.prototype.json = readJson;
      Response.prototype.text = readText;
    }
  });

  it('read every probe for every person', () => {
    expect(seen.length).toBeGreaterThan(PEOPLE.length * Object.keys(MATRIX).length);
  });

  it('never carry the rule, its resource id or its name', () => {
    for (const text of seen) {
      expect(text).not.toContain(PERSONAL_SECRET_NAME);
      expect(text).not.toContain(PERSONAL_SECRET_RULE);
      expect(text).not.toContain('rg-personal-secret');
      expect(text).not.toContain(personalRuleId);
    }
  });
});

describe('the Azure pickers tell each person only what they hold', () => {
  const userIds: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    // The management group Viewer holds what sits under the group, which is read from RuleBeat's copy of the tree.
    await refreshFrom(matrixHierarchy());
  });

  it('holds an expectation for each of the three pickers', () => {
    expect(Object.keys(PICKER_MATRIX).sort()).toEqual(['azure/management-groups', 'azure/scope-tree', 'azure/subscriptions']);
  });

  for (const [route, entry] of Object.entries(PICKER_MATRIX)) {
    for (const person of PEOPLE.map(p => p.name)) {
      it(`${route}: ${person}`, async () => {
        mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
        expect(await entry.probe({} as MatrixSeed, 'results')).toEqual(entry.expected[person]!.results);
      });
    }
  }

  it('names nothing outside what the Viewer on one subscription holds, in any of the three', async () => {
    mockAuth.mockResolvedValue({ user: { uid: userIds['Viewer on one subscription'] } });
    for (const entry of Object.values(PICKER_MATRIX)) {
      const text = JSON.stringify(await entry.probe({} as MatrixSeed, 'results'));
      for (const hidden of [SUB_TWO, 'Sub two', MANAGEMENT_GROUP, 'Example group', SIBLING_GROUP, 'Other group', FAKE_TENANT_NAME, MATRIX_TENANT]) {
        expect(text).not.toContain(hidden);
      }
    }
  });

  it('compares ids without regard to case', async () => {
    const holding = async (email: string, scope: string): Promise<void> => {
      const created = await createUser({ email, role: 'viewer' });
      if ('error' in created) throw new Error(created.error);
      await inTransaction(tx => replaceAssignmentsOn(tx, created.user.id, [{ tenantId: MATRIX_TENANT, scope, role: 'viewer' as const }]));
      mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
    };
    await holding('shouting-subscription@example.com', `/subscriptions/${SUB_TWO.toUpperCase()}`);
    expect(await PICKER_MATRIX['azure/subscriptions']!.probe({} as MatrixSeed, 'results')).toEqual([SUB_TWO_ENTRY]);
    expect(await PICKER_MATRIX['azure/management-groups']!.probe({} as MatrixSeed, 'results')).toEqual([]);
    await holding('shouting-group@example.com', SCOPE_MANAGEMENT_GROUP.toUpperCase());
    expect(await PICKER_MATRIX['azure/management-groups']!.probe({} as MatrixSeed, 'results')).toEqual([{ id: MANAGEMENT_GROUP, name: 'Example group' }]);
    expect(await PICKER_MATRIX['azure/subscriptions']!.probe({} as MatrixSeed, 'results')).toEqual([SUB_ONE_ENTRY, SUB_TWO_ENTRY]);
  });
});

// ---- The rule list: a rule's scope names only what the person holds ----

describe('GET /api/rules gives each person a rule scope that names only what they hold', () => {
  const userIds: Record<string, string> = {};
  type ListedRule = { id: string; scope: unknown } & Record<string, unknown>;
  const list = async (person: string): Promise<ListedRule[]> => {
    mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
    return BODY(await (await import('@/app/api/rules/route')).GET()) as Promise<ListedRule[]>;
  };
  const withoutScope = (rules: ListedRule[]) => rules.map(({ scope: _scope, ...rest }) => rest);

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    await refreshFrom(matrixHierarchy());
    await seedScopedRule();
  });

  for (const person of PEOPLE.map(p => p.name)) {
    it(`${person}: the rule's scope`, async () => {
      const rule = (await list(person)).find(r => r.id === SCOPED_RULE_ID);
      expect(rule?.scope).toEqual(RULE_SCOPE_EXPECTED[person]!.results);
    });

    it(`${person}: every other part of every rule is what the Admin gets`, async () => {
      expect(withoutScope(await list(person))).toEqual(withoutScope(await list('Admin')));
    });

    it(`${person}: rules/[id]/versions narrows the current definition's scope the same way`, async () => {
      mockAuth.mockResolvedValue({ user: { uid: userIds[person] } });
      expect(await RULE_VERSIONS.probe({} as MatrixSeed, 'results')).toEqual(RULE_VERSIONS.expected[person]!.results);
    });
  }

  it('sends a person on Everything the rules as they are stored', async () => {
    const stored = JSON.parse(JSON.stringify(await loadRules())) as unknown;
    expect(await list('Admin')).toEqual(stored);
    expect(await list('Editor on Everything')).toEqual(stored);
  });

  it('names no subscription or management group the Viewer on one subscription does not hold, anywhere in the body', async () => {
    mockAuth.mockResolvedValue({ user: { uid: userIds['Viewer on one subscription'] } });
    const text = await (await (await import('@/app/api/rules/route')).GET()).text();
    expect(text).not.toContain(SUB_TWO);
    expect(text).not.toContain(MANAGEMENT_GROUP);
    expect(text).toContain(SUB_ONE);
  });

  it('keeps the name, description, KQL and conditions of the scoped rule the same for the person with no Scope', async () => {
    const rule = (await list('No Scope')).find(r => r.id === SCOPED_RULE_ID)!;
    expect(rule).toMatchObject({ name: SCOPED_RULE_NAME, rawKql: SCOPED_RULE_KQL, conditions: [] });
  });

  it('narrows the shipped definitions the versions route sends for a custom rule too', async () => {
    mockAuth.mockResolvedValue({ user: { uid: userIds['Viewer on one subscription'] } });
    const route = await import('@/app/api/rules/[id]/versions/route');
    const res = await route.GET(new Request('http://localhost'), { params: Promise.resolve({ id: SCOPED_RULE_ID }) });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(SUB_TWO);
    expect(text).not.toContain(MANAGEMENT_GROUP);
  });
});

// ---- The Rules tab's counts: only the findings inside the person's Scopes ----

describe('the Rules tab counts cover only the findings inside each person\'s Scopes', () => {
  const userIds: Record<string, string> = {};

  /** The rule ids of the seed with the count each person's access gives them, from the read the page calls. */
  const countsFor = async (person: string) => {
    const user = await getUser(userIds[person]!);
    return queryRuleFindingCounts(await resolveAccess(user!));
  };

  const EVERYTHING_COUNTS = { 'matrix-rule': 6, 'matrix-advisory-rule': 2 };
  const COUNTS: Record<string, Record<string, number>> = {
    'Admin': EVERYTHING_COUNTS,
    'Editor on Everything': EVERYTHING_COUNTS,
    'Viewer on the management group': { 'matrix-rule': 4, 'matrix-advisory-rule': 2 },
    'Viewer on one subscription': { 'matrix-rule': 2, 'matrix-advisory-rule': 1 },
    'Viewer on one resource group': { 'matrix-rule': 1, 'matrix-advisory-rule': 1 },
    'Directory only': { 'matrix-rule': 1 },
    'No Scope': {},
  };

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    await seedMatrix();
  });

  it('holds an expectation for every person', () => {
    expect(Object.keys(COUNTS).sort()).toEqual(PEOPLE.map(p => p.name).sort());
  });

  for (const person of PEOPLE.map(p => p.name)) {
    it(`${person}`, async () => {
      expect(await countsFor(person)).toEqual(COUNTS[person]);
    });
  }

  it('counts a finding again once the suppression that covered it has expired', async () => {
    // vm-two (subscription one) is suppressed in the seed, so the Viewer on subscription one counts 2 of the 3 there.
    expect((await countsFor('Viewer on one subscription'))['matrix-rule']).toBe(2);
    await saveSuppressions([{
      id: '00000000-0000-0000-0000-0000000000b2', fingerprint: (await queryFingerprint('vm-two')), reason: 'expired', suppressedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    }]);
    expect((await countsFor('Viewer on one subscription'))['matrix-rule']).toBe(3);
  });
});

/** The fingerprint the seed gave a finding, found by the name it was seeded with. */
async function queryFingerprint(name: string): Promise<string> {
  const rows = await listFindingSummaries(everythingAccess('admin'), {});
  const found = rows.find(r => (r.resourceName ?? r.dimensionKey) === name);
  if (!found) throw new Error(`no seeded finding named ${name}`);
  return found.fingerprint;
}

// ---- Writes: a scoped Editor is refused where an Editor on Everything is not ----

const WRITE_ACTIONS: readonly Action[] = ['rules:write', 'rules:delete', 'schedules:write', 'categories:write', 'suppressions:write'];

/** A write route a person who does not hold Everything is refused, or that names where it acts. */
interface WriteCase {
  /** What the route sends, over targets made fresh for this call. */
  prepare: () => Promise<() => Promise<Response>>;
  action: Action;
  /** What an Admin gets. */
  admin: number;
  /** What an Editor on Everything gets. */
  everything: number;
}

let writeCounter = 0;
const nextName = (what: string) => `write ${what} ${++writeCounter}`;
const ctxFor = (params: { id: string }) => ({ params: Promise.resolve(params) });

async function freshRule(): Promise<string> {
  const id = `write-rule-${++writeCounter}`;
  await saveRules([{ ...ruleBody(nextName('rule')), id } as unknown as Rule]);
  return id;
}

async function freshSchedule(): Promise<string> {
  const created = await createSchedule({
    name: nextName('schedule'), targetType: 'all', targetValues: [], recurrenceType: 'daily', interval: 1,
    daysOfWeek: null, dayOfMonth: null, startAt: '2026-06-01T00:00:00.000Z', endType: 'never', endDate: null,
  });
  if ('error' in created) throw new Error(created.error);
  return created.schedule.id;
}

async function freshCategory(): Promise<string> {
  const created = await createCategory({ label: nextName('category') });
  if ('error' in created) throw new Error(created.error);
  return created.category.id;
}

const scheduleBody = (name: string) => ({
  name, targetType: 'all', targetValues: [], recurrenceType: 'daily', interval: 1, startAt: '2026-06-01T00:00:00.000Z', endType: 'never',
});

const WRITE_CASES: Record<string, WriteCase> = {
  'rules POST': {
    action: 'rules:write', admin: 201, everything: 201,
    prepare: async () => () => import('@/app/api/rules/route').then(r => r.POST(sendJson('/api/rules', 'POST', ruleBody(nextName('rule'))))),
  },
  'rules/[id] PUT': {
    action: 'rules:write', admin: 200, everything: 200,
    prepare: async () => {
      const id = await freshRule();
      return () => import('@/app/api/rules/[id]/route').then(r => r.PUT(sendJson(`/api/rules/${id}`, 'PUT', ruleBody(nextName('renamed rule'))), ctxFor({ id })));
    },
  },
  'rules/[id] DELETE': {
    action: 'rules:delete', admin: 200, everything: 200,
    prepare: async () => {
      const id = await freshRule();
      return () => import('@/app/api/rules/[id]/route').then(r => r.DELETE(new Request(`http://localhost/api/rules/${id}`, { method: 'DELETE' }), ctxFor({ id })));
    },
  },
  'rules/bulk PATCH': {
    action: 'rules:write', admin: 200, everything: 200,
    prepare: async () => {
      const id = await freshRule();
      return () => import('@/app/api/rules/bulk/route').then(r => r.PATCH(sendJson('/api/rules/bulk', 'PATCH', { disable: [id] })));
    },
  },
  'rules/[id]/duplicate POST': {
    action: 'rules:write', admin: 201, everything: 201,
    prepare: async () => {
      const id = await freshRule();
      return () => import('@/app/api/rules/[id]/duplicate/route').then(r => r.POST(new Request(`http://localhost/api/rules/${id}/duplicate`, { method: 'POST' }), ctxFor({ id })));
    },
  },
  'rules/[id]/findings DELETE': {
    action: 'rules:delete', admin: 200, everything: 200,
    prepare: async () => {
      // The rule the seed's findings belong to, saved once and then cleared by whoever is allowed to.
      await saveRules([{ ...ruleBody('matrix rule with findings'), id: 'matrix-rule' } as unknown as Rule]);
      return () => import('@/app/api/rules/[id]/findings/route').then(r => r.DELETE(new Request('http://localhost/api/rules/matrix-rule/findings', { method: 'DELETE' }), ctxFor({ id: 'matrix-rule' })));
    },
  },
  'schedules POST': {
    action: 'schedules:write', admin: 201, everything: 201,
    prepare: async () => () => import('@/app/api/schedules/route').then(r => r.POST(sendJson('/api/schedules', 'POST', scheduleBody(nextName('schedule'))))),
  },
  'schedules/[id] PUT': {
    action: 'schedules:write', admin: 200, everything: 200,
    prepare: async () => {
      const id = await freshSchedule();
      return () => import('@/app/api/schedules/[id]/route').then(r => r.PUT(sendJson(`/api/schedules/${id}`, 'PUT', scheduleBody(nextName('renamed schedule'))), ctxFor({ id })));
    },
  },
  'schedules/[id] DELETE': {
    action: 'schedules:write', admin: 200, everything: 200,
    prepare: async () => {
      const id = await freshSchedule();
      return () => import('@/app/api/schedules/[id]/route').then(r => r.DELETE(new Request(`http://localhost/api/schedules/${id}`, { method: 'DELETE' }), ctxFor({ id })));
    },
  },
  // Categories are install-wide (ADR 0011): an Admin or an Editor on Everything, and no Editor held at a narrower Scope.
  'categories POST': {
    action: 'categories:write', admin: 201, everything: 201,
    prepare: async () => () => import('@/app/api/categories/route').then(r => r.POST(sendJson('/api/categories', 'POST', { label: nextName('category') }))),
  },
  'categories/[id] PUT': {
    action: 'categories:write', admin: 200, everything: 200,
    prepare: async () => {
      const id = await freshCategory();
      return () => import('@/app/api/categories/[id]/route').then(r => r.PUT(sendJson(`/api/categories/${id}`, 'PUT', { label: nextName('renamed category') }), ctxFor({ id })));
    },
  },
  'categories/[id] DELETE': {
    action: 'categories:write', admin: 200, everything: 200,
    prepare: async () => {
      const id = await freshCategory();
      return () => import('@/app/api/categories/[id]/route').then(r => r.DELETE(new Request(`http://localhost/api/categories/${id}`, { method: 'DELETE' }), ctxFor({ id })));
    },
  },
};

/** The routes that write and are checked by their own `describe`, because what they ask is where a finding sits. */
const PLACED_WRITES = ['suppressions POST', 'suppressions/[id] DELETE'];

/** The one handler that names a write action and is not in the table, with the ticket that covers it. */
const WRITE_SWEEP_EXCEPTIONS: Record<string, string> = { 'schedules/[id]/run POST': '#276' };

const WRITE_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** `rules/[id] PUT` for each handler in a route's source that asks for one of `actions`. */
export function writeHandlersIn(route: string, source: string, actions: readonly string[]): string[] {
  const code = stripComments(source);
  const starts = WRITE_VERBS.flatMap(verb => {
    const at = code.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`));
    return at < 0 ? [] : [{ verb, at }];
  }).sort((a, b) => a.at - b.at);
  return starts.flatMap(({ verb, at }, i) => {
    const body = code.slice(at, starts[i + 1]?.at ?? code.length);
    const asked = [...body.matchAll(/requireRole\(\s*'([^']+)'/g)].map(m => m[1]!);
    return asked.some(a => actions.includes(a)) ? [`${route} ${verb}`] : [];
  });
}

describe('every handler that writes is in the write table', () => {
  const sourceOf = (file: string) => readFileSync(file, 'utf8');
  const named = routeFiles(API_DIR).flatMap(file => writeHandlersIn(routeName(file), sourceOf(file), WRITE_ACTIONS));

  it('finds the handlers that ask for a write action', () => {
    expect(named.length).toBeGreaterThan(10);
    expect(named).toContain('rules/[id] PUT');
    expect(named).toContain('suppressions POST');
  });

  it('has each of them in the table, in the placed writes, or in the listed exception', () => {
    const covered = new Set([...Object.keys(WRITE_CASES), ...PLACED_WRITES, ...Object.keys(WRITE_SWEEP_EXCEPTIONS)]);
    expect(named.filter(handler => !covered.has(handler))).toEqual([]);
  });

  it('lists nothing in the table that is not a handler on disk', () => {
    expect(Object.keys(WRITE_CASES).concat(PLACED_WRITES).filter(handler => !named.includes(handler))).toEqual([]);
  });

  it('names the ticket for the one exception, and no other', () => {
    expect(WRITE_SWEEP_EXCEPTIONS).toEqual({ 'schedules/[id]/run POST': '#276' });
  });

  it('says what a handler missing from the table looks like', () => {
    const source = `export async function POST() { await requireRole('schedules:write'); }\nexport async function GET() { await requireRole('read'); }`;
    expect(writeHandlersIn('widgets/new', source, WRITE_ACTIONS)).toEqual(['widgets/new POST']);
    expect(writeHandlersIn('widgets/new', `// await requireRole('rules:write')\nexport async function GET() { await requireRole('read'); }`, WRITE_ACTIONS)).toEqual([]);
  });
});

describe('a scoped Editor is refused every library and schedule write, and an Editor on Everything is not', () => {
  const userIds: Record<string, string> = {};
  let scopedEditor: string;

  /** What every write route changes, in one value, so a refusal can be shown to have changed nothing. */
  const stored = async () => ({
    rules: JSON.parse(JSON.stringify(await loadRules())) as unknown,
    schedules: await listSchedules(),
    categories: await listCategories(),
    findings: await queryRuleFindingCounts(everythingAccess('admin')),
    audit: await countAuditEntries(),
  });

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    await seedMatrix();
    const created = await createUser({ email: 'scoped-editor@example.com', role: 'editor' });
    if ('error' in created) throw new Error(created.error);
    scopedEditor = created.user.id;
    await inTransaction(tx => replaceAssignmentsOn(tx, scopedEditor, [{ tenantId: MATRIX_TENANT, scope: SCOPE_SUBSCRIPTION, role: 'editor' }]));
  });

  beforeEach(() => { fakeCtx = fakeTenantContext({}); });

  it('has a case for every route in the brief', () => {
    expect(Object.keys(WRITE_CASES).sort()).toEqual([
      'categories POST', 'categories/[id] DELETE', 'categories/[id] PUT', 'rules POST', 'rules/[id] DELETE', 'rules/[id] PUT',
      'rules/[id]/duplicate POST', 'rules/[id]/findings DELETE', 'rules/bulk PATCH', 'schedules POST', 'schedules/[id] DELETE', 'schedules/[id] PUT',
    ]);
  });

  it('starts with findings for the rule the clear-findings case targets', async () => {
    expect((await stored()).findings['matrix-rule']).toBe(6);
  });

  for (const [name, c] of Object.entries(WRITE_CASES)) {
    it(`${name}: the Editor on one subscription gets 403 and nothing is stored`, async () => {
      const send = await c.prepare();
      mockAuth.mockResolvedValue({ user: { uid: scopedEditor } });
      const before = await stored();
      const res = await send();
      expect(res.status).toBe(403);
      expect(await stored()).toEqual(before);
    });

    it(`${name}: the Editor on Everything gets ${c.everything}`, async () => {
      const send = await c.prepare();
      mockAuth.mockResolvedValue({ user: { uid: userIds['Editor on Everything'] } });
      expect((await send()).status).toBe(c.everything);
    });

    it(`${name}: the Admin gets ${c.admin}`, async () => {
      const send = await c.prepare();
      mockAuth.mockResolvedValue({ user: { uid: userIds['Admin'] } });
      expect((await send()).status).toBe(c.admin);
    });
  }

  it('refuses the Editor on one subscription in the same way as a Viewer, with the same body', async () => {
    const send = await WRITE_CASES['rules POST']!.prepare();
    mockAuth.mockResolvedValue({ user: { uid: scopedEditor } });
    const editor = await send();
    mockAuth.mockResolvedValue({ user: { uid: userIds['Viewer on one subscription'] } });
    const viewer = await send();
    expect(editor.status).toBe(403);
    expect(await editor.json()).toEqual(await viewer.json());
  });
});

// ---- Suppressing: where the finding sits decides ----

describe('suppressing needs a Role that allows it at a Scope containing the finding', () => {
  const userIds: Record<string, string> = {};
  let seed: MatrixSeed;
  let scopedEditor: string;
  let mixed: string;

  const post = async (person: string, fingerprint: string): Promise<Response> => {
    mockAuth.mockResolvedValue({ user: { uid: person } });
    return (await import('@/app/api/suppressions/route')).POST(sendJson('/api/suppressions', 'POST', { fingerprint, reason: 'accepted for the test' }));
  };
  const remove = async (person: string, id: string): Promise<Response> => {
    mockAuth.mockResolvedValue({ user: { uid: person } });
    return (await import('@/app/api/suppressions/[id]/route')).DELETE(new Request(`http://localhost/api/suppressions/${id}`, { method: 'DELETE' }), ctxFor({ id }));
  };
  const stored = async () => (await loadSuppressions(everythingAccess('admin'))).map(s => s.fingerprint).sort();

  async function newPerson(email: string, grants: { scope: string; role: 'viewer' | 'editor' }[]): Promise<string> {
    const created = await createUser({ email, role: 'editor' });
    if ('error' in created) throw new Error(created.error);
    await inTransaction(tx => replaceAssignmentsOn(tx, created.user.id, grants.map(g => ({ tenantId: MATRIX_TENANT, ...g }))));
    return created.user.id;
  }

  beforeAll(async () => {
    await resetDb();
    Object.assign(userIds, await createPeople());
    seed = await seedMatrix();
    scopedEditor = await newPerson('suppress-editor@example.com', [{ scope: SCOPE_SUBSCRIPTION, role: 'editor' }]);
    // Editor on resource group `rg-one` of subscription one, Viewer on subscription two.
    mixed = await newPerson('suppress-mixed@example.com', [
      { scope: SCOPE_RESOURCE_GROUP, role: 'editor' }, { scope: `/subscriptions/${SUB_TWO}`, role: 'viewer' },
    ]);
  });

  it('lets an Editor on one subscription suppress a finding inside it, stores it and audits it', async () => {
    const res = await post(scopedEditor, seed.fingerprints['vm-one']!);
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; fingerprint: string };
    expect(await stored()).toContain(seed.fingerprints['vm-one']);
    const audit = (await listAuditEntries({ limit: 20 })).find(e => e.action === 'suppression.create' && e.entityId === body.id);
    expect(audit?.actorId).toBe(scopedEditor);
  });

  it('answers a finding outside it with the body of a fingerprint that does not exist, and stores nothing', async () => {
    const before = await stored();
    const outside = await post(scopedEditor, seed.fingerprints['vm-other-sub']!);
    const unknown = await post(scopedEditor, '0000000000000000');
    expect(outside.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await outside.text()).toBe(await unknown.text());
    expect(await stored()).toEqual(before);
  });

  it('refuses a person who is an Editor on one Scope and a Viewer on another on a finding in the Viewer Scope', async () => {
    const before = await stored();
    const inViewerScope = await post(mixed, seed.fingerprints['vm-other-sub']!);
    expect(inViewerScope.status).toBe(404);
    expect(await stored()).toEqual(before);
  });

  it('lets that person suppress a finding in the Scope where they are an Editor', async () => {
    expect((await post(mixed, seed.fingerprints['advisory-one']!)).status).toBe(201);
  });

  it('refuses them a finding a Viewer Scope contains and an Editor Scope does not, even when the Viewer Scope is the wider one', async () => {
    const wide = await newPerson('suppress-wide-viewer@example.com', [
      { scope: SCOPE_SUBSCRIPTION, role: 'viewer' }, { scope: SCOPE_RESOURCE_GROUP, role: 'editor' },
    ]);
    // subscription-level sits in subscription one but in no resource group.
    expect((await post(wide, seed.fingerprints['subscription-level']!)).status).toBe(404);
    expect((await post(wide, seed.fingerprints['vm-one']!)).status).toBe(201);
  });

  it('lets an Editor on the management group suppress a finding under it, and refuses one outside it', async () => {
    const groupEditor = await newPerson('suppress-group-editor@example.com', [{ scope: SCOPE_MANAGEMENT_GROUP, role: 'editor' }]);
    expect((await post(groupEditor, seed.fingerprints['vm-other-sub']!)).status).toBe(201);
    expect((await post(groupEditor, seed.fingerprints['management-group-level']!)).status).toBe(201);
    expect((await post(groupEditor, seed.fingerprints['directory-app']!)).status).toBe(404);
  });

  it('refuses a Viewer, as before, at the guard', async () => {
    expect((await post(userIds['Viewer on one subscription']!, seed.fingerprints['vm-one']!)).status).toBe(403);
  });

  it('is unchanged for the Admin and the Editor on Everything: any fingerprint is accepted', async () => {
    expect((await post(userIds['Admin']!, seed.fingerprints['vm-other-sub']!)).status).toBe(201);
    expect((await post(userIds['Editor on Everything']!, '0000000000000001')).status).toBe(201);
  });

  describe('removing one', () => {
    const suppressionOn = async (name: string): Promise<string> => {
      const res = await post(userIds['Admin']!, seed.fingerprints[name]!);
      return ((await res.json()) as { id: string }).id;
    };

    it('removes a suppression on a finding inside an Editor Scope', async () => {
      const id = await suppressionOn('directory-app');
      const inside = await newPerson('suppress-directory-editor@example.com', [{ scope: SCOPE_DIRECTORY, role: 'editor' }]);
      expect((await remove(inside, id)).status).toBe(204);
      expect((await loadSuppressions(everythingAccess('admin'))).some(s => s.id === id)).toBe(false);
    });

    it('answers a suppression outside it with the body of an id that does not exist, and removes nothing', async () => {
      const id = await suppressionOn('management-group-level');
      const before = await stored();
      const outside = await remove(scopedEditor, id);
      const unknown = await remove(scopedEditor, '00000000-0000-0000-0000-00000000dead');
      expect(outside.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await outside.text()).toBe(await unknown.text());
      expect(await stored()).toEqual(before);
    });

    it('refuses the person who is a Viewer where the finding sits', async () => {
      const id = await suppressionOn('vm-other-sub');
      expect((await remove(mixed, id)).status).toBe(404);
      expect((await loadSuppressions(everythingAccess('admin'))).some(s => s.id === id)).toBe(true);
    });

    it('is unchanged for the Admin and the Editor on Everything', async () => {
      const first = await suppressionOn('unplaceable-thing');
      expect((await remove(userIds['Admin']!, first)).status).toBe(204);
      const second = await suppressionOn('unplaceable-thing');
      expect((await remove(userIds['Editor on Everything']!, second)).status).toBe(204);
    });
  });
});
