/**
 * #276: Run now covers the overlap of a rule's scope and the runner's access.
 *
 * Driven through `POST /api/scans/run` with the real `requireRole`, the real repositories and the real
 * scan runner, over a fake Azure: only the session (`@/auth`) and `createTenantContext` are mocked, so the
 * requests a person's run sends are the fake's recorded queries. Nothing mocks `runManualTarget`.
 *
 * The tree: `mg-example` holds subscriptions A and B, `mg-other` holds C. The people are Editors, since a
 * Viewer cannot run a scan.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { inTransaction, run as execRun } from '@/lib/db/exec';
import { rules as rulesTable, scans as scansTable, scanFindings } from '@/lib/db/tables';
import { many } from '@/lib/db/exec';
import { createUser } from '@/lib/db/users';
import { replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { listFindings } from '@/lib/db/findings';
import { listAllRuns } from '@/lib/schedule-runs';
import { loadRules } from '@/lib/rules';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { argRow, fakeTenantContext, TEST_SUB_A, TEST_SUB_B, type FakeTenantContext } from '../helpers/fake-azure';
import { fakeHierarchy, group, HIERARCHY_TENANT, refreshFrom, subscription } from '../helpers/fake-hierarchy';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fake: FakeTenantContext;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve(fake) };
});

const SUB_C = '33333333-3333-3333-3333-333333333333';
const MG_EXAMPLE = 'mg-example';
const MG_OTHER = 'mg-other';
const TENANT = HIERARCHY_TENANT;

const path = {
  subA: `/subscriptions/${TEST_SUB_A}`,
  subB: `/subscriptions/${TEST_SUB_B}`,
  rgOneInA: `/subscriptions/${TEST_SUB_A}/resourceGroups/rg-one`,
  rgWorkspaceInA: `/subscriptions/${TEST_SUB_A}/resourceGroups/rg-ws`,
  rgOtherInA: `/subscriptions/${TEST_SUB_A}/resourceGroups/rg-other`,
  mgExample: `/providers/Microsoft.Management/managementGroups/${MG_EXAMPLE}`,
  directory: '@directory',
};

// One rule per way a rule's scope can sit against a runner's access. The marker is the only thing in
// the KQL that differs, so a recorded query names its rule.
const RULES = {
  wide: { id: 'scope-rule-wide', marker: '// wide', scope: { level: 'subscription' } },
  onB: { id: 'scope-rule-on-b', marker: '// on-b', scope: { level: 'subscription', subscriptions: [TEST_SUB_B] } },
  onMg: { id: 'scope-rule-on-mg', marker: '// on-mg', scope: { level: 'managementGroup', managementGroups: [MG_EXAMPLE] } },
  onC: { id: 'scope-rule-on-c', marker: '// on-c', scope: { level: 'subscription', subscriptions: [SUB_C] } },
  bare: { id: 'scope-rule-bare', marker: '// bare', scope: { level: 'subscription' } },
  capped: { id: 'scope-rule-capped', marker: '// capped | take 10', scope: { level: 'subscription' } },
} as const;
type RuleKey = keyof typeof RULES;

const GRAPH_RULE = 'cred:app-secret-expiring';
const LOGS_RULE = 'scope-rule-logs';
const WORKSPACE_CUSTOMER_ID = 'workspace-customer-id';

async function insertRule(key: RuleKey): Promise<void> {
  const rule = RULES[key];
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, rule.id)));
  await execRun(db.insert(rulesTable).values({
    id: rule.id, name: rule.id, description: 'a rule', category: 'security', severity: 'medium', enabled: true,
    scope: JSON.stringify(rule.scope), resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" ${rule.marker}`, type: 'custom',
  }));
}

async function insertLogsRule(): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, LOGS_RULE)));
  await execRun(db.insert(rulesTable).values({
    id: LOGS_RULE, name: LOGS_RULE, description: 'a logs rule', category: 'security', severity: 'medium', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]),
    queryBackend: 'log-analytics', logsQuery: JSON.stringify({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 }), type: 'custom',
  }));
}

const vm = (name: string, sub: string, rg: string) => argRow({ name, subscriptionId: sub, resourceGroup: rg });
const ROWS = [vm('vm-a-one', TEST_SUB_A, 'rg-one'), vm('vm-a-two', TEST_SUB_A, 'rg-two'), vm('vm-b', TEST_SUB_B, 'rg-one'), vm('vm-c', SUB_C, 'rg-one')];

/** What the fake answers: the same rows for every rule, whatever the scope asked for, so a finding outside a
 *  runner's access reaches the runner and has to be dropped by it. */
function fakeAzure(rows: Record<string, unknown>[] = ROWS, extra: Parameters<typeof fakeTenantContext>[0] = {}): FakeTenantContext {
  return fakeTenantContext({
    tenantId: TENANT,
    subscriptionIds: [TEST_SUB_A, TEST_SUB_B, SUB_C],
    logAnalyticsWorkspaceId: WORKSPACE_CUSTOMER_ID,
    logsRows: [{ UserId: 'u1' }],
    graphRows: [{
      id: 'app-1', displayName: 'App', appId: 'appid-1',
      passwordCredentials: [{ displayName: 's', endDateTime: new Date(Date.now() + 5 * 86_400_000).toISOString(), keyId: 'k1' }],
      keyCredentials: [],
    }],
    rows: kql => {
      if (kql.includes('microsoft.operationalinsights/workspaces')) {
        return [{ id: 'ws', subscriptionId: TEST_SUB_A, resourceGroup: 'rg-ws', customerId: WORKSPACE_CUSTOMER_ID }];
      }
      // The enrichment follow-up asks for the ids it was handed, and gets full rows back.
      if (kql.includes('where id in~')) return ROWS;
      // A rule whose own query projects no identity columns, so its rows need the follow-up.
      if (kql.includes(RULES.bare.marker)) return rows.map(r => ({ id: r['id'], name: r['name'] }));
      return rows;
    },
    ...extra,
  });
}

const ids: Record<string, string> = {};

async function person(name: string, role: 'admin' | 'editor', ...scopes: string[]): Promise<void> {
  const created = await createUser({ email: `${name.replace(/\W+/g, '-')}@example.com`, role });
  if ('error' in created) throw new Error(created.error);
  if (role !== 'admin') {
    await inTransaction(tx => replaceAssignmentsOn(tx, created.user.id, scopes.map(scope => ({ tenantId: TENANT, scope, role: 'editor' as const }))));
  }
  ids[name] = created.user.id;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** POSTs a run of these rules as `who` and waits for it to finish. */
async function runAs(who: string, ruleIds: string[], ctx: FakeTenantContext = fakeAzure()) {
  fake = ctx;
  const before = (await listAllRuns(EVERYTHING_ACCESS, 1))[0]?.id;
  mockAuth.mockResolvedValue({ user: { uid: ids[who] } });
  const route = await import('@/app/api/scans/run/route');
  const res = await route.POST(new Request('http://localhost/api/scans/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetType: 'rules', targetValues: ruleIds }),
  }));
  expect(res.status).toBe(202);
  for (let i = 0; i < 500; i++) {
    const latest = (await listAllRuns(EVERYTHING_ACCESS, 1))[0];
    if (latest && latest.id !== before && latest.finishedAt) return latest;
    await sleep(20);
  }
  throw new Error('the run did not finish');
}

const queriesOf = (ctx: FakeTenantContext, key: RuleKey) => ctx.queries.filter(q => q.kql.includes(RULES[key].marker));
const names = async () => (await listFindings(EVERYTHING_ACCESS)).filter(f => f.status === 'active').map(f => f.resourceName).sort();
const statusOf = async (name: string) => (await listFindings(EVERYTHING_ACCESS)).find(f => f.resourceName === name)?.status;

beforeEach(async () => {
  await resetDb();
  await person('Admin', 'admin');
  await person('Editor on subscription A', 'editor', path.subA);
  await person('Editor on resource group', 'editor', path.rgOneInA);
  await person('Editor on subscription B', 'editor', path.subB);
  await person('Editor on the management group', 'editor', path.mgExample);
  await person('Editor on the Directory', 'editor', path.directory);
  await person('Editor on the workspace group', 'editor', path.rgWorkspaceInA);
  await person('Editor on another group', 'editor', path.rgOtherInA);
  await refreshFrom(fakeHierarchy([
    group(TENANT, 'Tenant Root Group', null),
    group(MG_EXAMPLE, 'Example group', TENANT),
    group(MG_OTHER, 'Other group', TENANT),
    subscription(TEST_SUB_A, 'Subscription A', MG_EXAMPLE),
    subscription(TEST_SUB_B, 'Subscription B', MG_EXAMPLE),
    subscription(SUB_C, 'Subscription C', MG_OTHER),
  ]));
  for (const key of Object.keys(RULES) as RuleKey[]) await insertRule(key);
  await insertLogsRule();
});

describe('what a scoped Editor sends Azure', () => {
  const REQUEST_RULES: RuleKey[] = ['wide', 'onB', 'onMg', 'onC', 'bare'];

  it('sends each rule only the overlap of its scope and the Editor\'s subscription, with the KQL an Admin sends', async () => {
    const admin = fakeAzure();
    await runAs('Admin', REQUEST_RULES.map(k => RULES[k].id), admin);
    const scoped = fakeAzure();
    await runAs('Editor on subscription A', REQUEST_RULES.map(k => RULES[k].id), scoped);

    // A tenant-wide rule, and a rule on the management group above the Editor's subscription.
    expect(queriesOf(scoped, 'wide').map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
    expect(queriesOf(scoped, 'onMg').map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
    expect(queriesOf(scoped, 'bare').map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
    // The enrichment follow-up of a rule whose rows lack their identity columns goes out with the same scope.
    const enrichment = (ctx: FakeTenantContext) => ctx.queries.filter(q => q.kql.includes('where id in~'));
    expect(enrichment(scoped).map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
    expect(enrichment(admin)).toHaveLength(1);
    // A rule on a subscription the Editor does not hold, and one on another group's subscription: not asked at all.
    expect(queriesOf(scoped, 'onB')).toEqual([]);
    expect(queriesOf(scoped, 'onC')).toEqual([]);

    // An Admin's run sends what it always did: the rule's own scope, untouched.
    expect(queriesOf(admin, 'wide').map(q => q.scope)).toEqual([{ subscriptions: undefined, managementGroups: undefined }]);
    expect(queriesOf(admin, 'onB').map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_B], managementGroups: undefined }]);

    // Byte for byte the KQL of the Admin's run, rule by rule.
    for (const key of ['wide', 'onMg', 'bare'] as RuleKey[]) {
      expect(queriesOf(scoped, key).map(q => q.kql), key).toEqual(queriesOf(admin, key).map(q => q.kql));
    }
    expect(enrichment(scoped).map(q => q.kql)).toEqual(enrichment(admin).map(q => q.kql));
  });

  it('does not run a rule that shares nothing with the Editor: no outcome, no count, no partial run, status kept', async () => {
    await runAs('Admin', REQUEST_RULES.map(k => RULES[k].id));
    const before = (await loadRules()).find(r => r.id === RULES.onB.id)!;

    const run = await runAs('Editor on subscription A', REQUEST_RULES.map(k => RULES[k].id));

    const [scan] = await many(db.select().from(scansTable).where(eq(scansTable.runId, run.id)));
    expect(scan!.totalRules).toBe(3);
    expect(JSON.parse(scan!.incompleteRules)).toEqual([]);
    expect(run.status).toBe('success');
    const after = (await loadRules()).find(r => r.id === RULES.onB.id)!;
    expect([after.lastRunStatus, after.lastRunAt]).toEqual([before.lastRunStatus, before.lastRunAt]);
  });

  it('sends a rule on a management group above a held group, and one beneath it, the right entries', async () => {
    const group = fakeAzure();
    await runAs('Editor on the management group', REQUEST_RULES.map(k => RULES[k].id), group);
    // Holds mg-example: a tenant-wide rule gets the group itself, and a rule on a subscription beneath it keeps its own.
    expect(queriesOf(group, 'wide').map(q => q.scope)).toEqual([{ managementGroups: [MG_EXAMPLE] }]);
    expect(queriesOf(group, 'onMg').map(q => q.scope)).toEqual([{ managementGroups: [MG_EXAMPLE] }]);
    expect(queriesOf(group, 'onB').map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_B] }]);
    expect(queriesOf(group, 'onC')).toEqual([]);
  });

  it('never sends an empty scope: nothing is asked for a runner whose Scopes the rule does not reach', async () => {
    const ctx = fakeAzure();
    await runAs('Editor on subscription B', [RULES.onC.id], ctx);
    expect(ctx.queries).toEqual([]);
  });

  it('records the Scope the run covered, and an Admin\'s run records Everything', async () => {
    const adminRun = await runAs('Admin', [RULES.wide.id]);
    const scopedRun = await runAs('Editor on subscription A', [RULES.wide.id]);
    expect(adminRun.coveredScope.entries.map(e => e.label)).toEqual(['Everything']);
    expect(scopedRun.coveredScope.entries.map(e => e.label)).toEqual([path.subA]);
    expect(scopedRun.coveredScope.key).not.toBe(adminRun.coveredScope.key);

    const stored = await many(db.select({ runId: scansTable.runId, coveredScope: scansTable.coveredScope }).from(scansTable));
    expect(new Map(stored.map(s => [s.runId, JSON.parse(s.coveredScope!)]))).toEqual(new Map([
      [adminRun.id, [{ tenantId: '', path: '/' }]],
      [scopedRun.id, [{ tenantId: TENANT, path: path.subA }]],
    ]));
  });

  it('lists in subscriptionsScanned only what the run asked for', async () => {
    await runAs('Editor on subscription A', [RULES.wide.id]);
    const [scan] = await many(db.select().from(scansTable));
    expect(JSON.parse(scan!.subscriptionsScanned)).toEqual([TEST_SUB_A]);
  });
});

describe('what a scoped run stores', () => {
  it('stores, counts and syncs only the findings inside the Editor\'s subscription', async () => {
    const run = await runAs('Editor on subscription A', [RULES.wide.id]);

    expect(await names()).toEqual(['vm-a-one', 'vm-a-two']);
    expect(run.totalFindings).toBe(2);
    const records = await many(db.select({ resourceName: scanFindings.resourceName }).from(scanFindings));
    expect(records.map(r => r.resourceName).sort()).toEqual(['vm-a-one', 'vm-a-two']);
  });

  it('lets an Editor whose access is one resource group run: the request goes to its subscription and only its resource group is kept', async () => {
    const ctx = fakeAzure();
    const run = await runAs('Editor on resource group', [RULES.wide.id, RULES.onMg.id], ctx);

    expect(queriesOf(ctx, 'wide').map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
    expect(queriesOf(ctx, 'onMg').map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
    // vm-a-one is the only finding inside the resource group, once for each of the two rules.
    expect(await names()).toEqual(['vm-a-one', 'vm-a-one']);
    expect(run.totalFindings).toBe(2);
    const records = await many(db.select({ resourceName: scanFindings.resourceName }).from(scanFindings));
    expect(records.map(r => r.resourceName)).toEqual(['vm-a-one', 'vm-a-one']);
  });
});

describe('the Directory and the workspace gate their rules', () => {
  it('runs a Microsoft Graph rule only for a Scope that includes the Directory', async () => {
    const without = fakeAzure();
    await runAs('Editor on subscription A', [GRAPH_RULE], without);
    expect(without.graphRequests).toEqual([]);

    const withDirectory = fakeAzure();
    await runAs('Editor on the Directory', [GRAPH_RULE], withDirectory);
    expect(withDirectory.graphRequests).toHaveLength(1);
    expect((await listFindings(EVERYTHING_ACCESS)).filter(f => f.ruleId === GRAPH_RULE)).not.toHaveLength(0);

    const admin = fakeAzure();
    await runAs('Admin', [GRAPH_RULE], admin);
    expect(admin.graphRequests).toHaveLength(1);
  });

  it('runs a Logs rule only when the Scope covers the workspace\'s resource group', async () => {
    const holdsSubscription = fakeAzure();
    await runAs('Editor on subscription A', [LOGS_RULE], holdsSubscription);
    expect(holdsSubscription.logsQueries).toHaveLength(1);

    const holdsGroup = fakeAzure();
    await runAs('Editor on the workspace group', [LOGS_RULE], holdsGroup);
    expect(holdsGroup.logsQueries).toHaveLength(1);

    for (const other of ['Editor on another group', 'Editor on subscription B', 'Editor on the Directory']) {
      const ctx = fakeAzure();
      await runAs(other, [LOGS_RULE], ctx);
      expect(ctx.logsQueries, other).toEqual([]);
    }
  });
});

describe('a scoped run resolves findings only inside what it covered', () => {
  it('leaves the other subscription\'s findings active, and a later Admin run resolves them', async () => {
    await runAs('Admin', [RULES.wide.id]);
    expect(await names()).toEqual(['vm-a-one', 'vm-a-two', 'vm-b', 'vm-c']);

    // Nothing is returned any more. The Editor on subscription A fixed both of theirs.
    await runAs('Editor on subscription A', [RULES.wide.id], fakeAzure([]));
    expect(await statusOf('vm-a-one')).toBe('fixed');
    expect(await statusOf('vm-a-two')).toBe('fixed');
    expect(await statusOf('vm-b')).toBe('active');
    expect(await statusOf('vm-c')).toBe('active');

    await runAs('Admin', [RULES.wide.id], fakeAzure([]));
    expect(await statusOf('vm-b')).toBe('fixed');
    expect(await statusOf('vm-c')).toBe('fixed');
  });

  it('resolves inside an Editor\'s resource group only, not the rest of its subscription', async () => {
    await runAs('Admin', [RULES.wide.id]);
    await runAs('Editor on resource group', [RULES.wide.id], fakeAzure([]));
    expect(await statusOf('vm-a-one')).toBe('fixed');
    expect(await statusOf('vm-a-two')).toBe('active');
  });

  it('resolves nothing for a rule that was capped or failed in a scoped run, inside the Scope or outside it', async () => {
    const activeOf = async (ruleId: string) => (await listFindings(EVERYTHING_ACCESS))
      .filter(f => f.ruleId === ruleId && f.status === 'active').map(f => f.resourceName).sort();
    const ALL = ['vm-a-one', 'vm-a-two', 'vm-b', 'vm-c'];

    await runAs('Admin', [RULES.capped.id, RULES.wide.id]);
    expect(await activeOf(RULES.capped.id)).toEqual(ALL);

    // The capped rule's query ends in a take, so what it returned is not everything there was.
    const capped = await runAs('Editor on subscription A', [RULES.capped.id], fakeAzure([]));
    expect(capped.status).toBe('partial');
    expect(await activeOf(RULES.capped.id)).toEqual(ALL);

    const failed = await runAs('Editor on subscription A', [RULES.wide.id], fakeAzure([], { failWith: new Error('429') }));
    expect(failed.status).toBe('partial');
    expect(await activeOf(RULES.wide.id)).toEqual(ALL);
  });
});

describe('a schedule run now covers Everything', () => {
  it('refuses a person below Everything, and sends nothing to Azure', async () => {
    const schedules = await import('@/app/api/schedules/route');
    const runRoute = await import('@/app/api/schedules/[id]/run/route');
    mockAuth.mockResolvedValue({ user: { uid: ids['Admin'] } });
    const created = await schedules.POST(new Request('http://localhost/api/schedules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nightly', targetType: 'all', targetValues: [], recurrenceType: 'daily', startAt: '2026-06-01T00:00:00.000Z' }),
    }));
    const { id } = await created.json() as { id: string };

    fake = fakeAzure();
    mockAuth.mockResolvedValue({ user: { uid: ids['Editor on subscription A'] } });
    const res = await runRoute.POST(new Request('http://localhost/x', { method: 'POST' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(403);
    expect(fake.queries).toEqual([]);
  });
});
