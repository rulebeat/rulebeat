/**
 * #280: running a Personal rule. Each test goes in at the run route with the real `requireRole`, so only
 * the session (`@/auth`) and `createTenantContext` are mocked, and asserts on what the fake Azure
 * recorded: the scope Resource Graph was sent and the KQL as stored. A run is limited by its request,
 * never by filtering rows or rewriting KQL, and it writes nothing shared.
 *
 * Every id is fake: zero GUIDs and example.com.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { countRows, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { listAllAuditEntries } from '@/lib/db/audit';
import {
  createPersonalRule, getPersonalRule, listPersonalRuleResults, type PersonalRuleDefinition,
} from '@/lib/db/personal-rules';
import { parseCoveredScope } from '@/lib/covered-scope-view';
import { limitedContext, planPersonalRun } from '@/lib/personal-rule-run';
import { buildAccess, type ScopeGrant, parseScope } from '@/lib/access-model';
import { argRow, fakeTenantContext, TEST_SUB_A, TEST_SUB_B, TEST_TENANT_ID, type FakeTenantContext } from '../helpers/fake-azure';
import type { Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve(fakeCtx) };
});

const runRoute = await import('@/app/api/personal-rules/[id]/run/route');

const SUBSCRIPTION_A = `/subscriptions/${TEST_SUB_A}`;
const SUBSCRIPTION_B = `/subscriptions/${TEST_SUB_B}`;
const MG = '/providers/Microsoft.Management/managementGroups/mg-example';
const DIRECTORY = '@directory';
const KQL = 'resources\n| where type =~ "microsoft.compute/virtualmachines"\n| project id, name, type, location, resourceGroup, subscriptionId';

function definition(overrides: Partial<PersonalRuleDefinition> = {}): PersonalRuleDefinition {
  return {
    name: 'Open ports on VMs',
    description: '',
    category: 'security',
    severity: 'high',
    queryBackend: 'resource-graph',
    kind: 'state',
    scope: { level: 'subscription' },
    resourceTypes: [],
    conditions: [],
    rawKql: KQL,
    ...overrides,
  };
}

async function signInWith(held: { scope: string; role: Role }[], role: Role = 'editor'): Promise<string> {
  const created = await createUser({
    email: `person-${Math.random().toString(36).slice(2)}@example.com`,
    role,
    access: held.map(h => ({ tenantId: TEST_TENANT_ID, scope: h.scope, role: h.role })),
  });
  if ('error' in created) throw new Error(created.error);
  mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
  return created.user.id;
}

const editorOn = (...scopes: string[]) => signInWith(scopes.map(scope => ({ scope, role: 'editor' as const })));

function run(id: string): Promise<Response> {
  return runRoute.POST(new Request(`http://localhost/api/personal-rules/${id}/run`, { method: 'POST' }), { params: Promise.resolve({ id }) });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  fakeCtx = fakeTenantContext({ rows: [argRow({ name: 'vm-one' }), argRow({ name: 'vm-two' })] });
});

describe('what a run sends Resource Graph', () => {
  it('sends the rule scope overlapped with what the owner holds, and the KQL as stored', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A, SUBSCRIPTION_B);
    const rule = await createPersonalRule(ownerId, definition({ scope: { level: 'subscription', subscriptions: [TEST_SUB_A, '33333333-3333-3333-3333-333333333333'] } }));

    const res = await run(rule.id);

    expect(res.status).toBe(200);
    expect(fakeCtx.queries.every(q => q.scope?.subscriptions?.join() === TEST_SUB_A)).toBe(true);
    expect(fakeCtx.queries[0]!.kql).toBe(KQL);
  });

  it('sends everything the owner holds when the rule names no scope', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A, MG);
    const rule = await createPersonalRule(ownerId, definition());

    await run(rule.id);

    expect(fakeCtx.queries[0]!.scope).toEqual({ subscriptions: [TEST_SUB_A], managementGroups: ['mg-example'] });
  });

  it('drops an entry the owner no longer holds', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, definition({ scope: { level: 'subscription', subscriptions: [TEST_SUB_A, TEST_SUB_B] } }));

    await run(rule.id);

    expect(fakeCtx.queries[0]!.scope).toEqual({ subscriptions: [TEST_SUB_A] });
    const stored = await getPersonalRule(rule.id, ownerId);
    expect(parseCoveredScope(stored!.lastRunCoveredScope)).toEqual([{ tenantId: TEST_TENANT_ID, path: SUBSCRIPTION_A }]);
  });

  it('refuses the run when nothing the rule names is still held, and sends nothing', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, definition({ scope: { level: 'subscription', subscriptions: [TEST_SUB_B] } }));

    const res = await run(rule.id);

    expect(res.status).toBe(403);
    expect(fakeCtx.queries).toEqual([]);
    expect(await listAllAuditEntries()).toEqual([]);
    expect((await getPersonalRule(rule.id, ownerId))!.lastRunAt).toBeUndefined();
  });

  it('does not filter rows: every row the query returned is stored', async () => {
    fakeCtx = fakeTenantContext({ rows: [argRow({ name: 'vm-one' }), argRow({ name: 'vm-elsewhere', subscriptionId: TEST_SUB_B })] });
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, definition());

    await run(rule.id);

    const names = (await listPersonalRuleResults(rule.id, ownerId)).map(r => r.resourceName).sort();
    expect(names).toEqual(['vm-elsewhere', 'vm-one']);
  });
});

describe('a Microsoft Graph rule', () => {
  const graphRule = () => definition({
    queryBackend: 'microsoft-graph',
    rawKql: undefined,
    graphQuery: { path: 'users', filter: 'accountEnabled eq false' },
  });

  it('runs when the owner holds the Directory', async () => {
    fakeCtx = fakeTenantContext({ graphRows: [{ id: 'user-1', displayName: 'Person One' }] });
    const ownerId = await editorOn(SUBSCRIPTION_A, DIRECTORY);
    const rule = await createPersonalRule(ownerId, graphRule());

    expect((await run(rule.id)).status).toBe(200);
    expect(fakeCtx.graphRequests).toHaveLength(1);
    const stored = await getPersonalRule(rule.id, ownerId);
    expect(parseCoveredScope(stored!.lastRunCoveredScope)).toEqual([{ tenantId: TEST_TENANT_ID, path: DIRECTORY }]);
  });

  it('is refused without the Directory, before any Graph request', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, graphRule());

    const res = await run(rule.id);

    expect(res.status).toBe(403);
    expect(fakeCtx.graphRequests).toEqual([]);
  });
});

describe('what a run stores', () => {
  it('replaces the first run\'s results entirely and updates the run fields', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, definition());

    await run(rule.id);
    const first = await getPersonalRule(rule.id, ownerId);
    expect((await listPersonalRuleResults(rule.id, ownerId)).map(r => r.resourceName).sort()).toEqual(['vm-one', 'vm-two']);

    fakeCtx = fakeTenantContext({ rows: [argRow({ name: 'vm-three' })] });
    await new Promise(resolve => setTimeout(resolve, 5));
    await run(rule.id);

    expect((await listPersonalRuleResults(rule.id, ownerId)).map(r => r.resourceName)).toEqual(['vm-three']);
    const second = await getPersonalRule(rule.id, ownerId);
    expect(second!.lastRunAt! > first!.lastRunAt!).toBe(true);
    expect(second!.lastRunStatus).toBe('success');
  });

  it('writes one audit entry that names the rule and the covered Scope and holds no KQL or result value', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, definition());

    await run(rule.id);

    const entries = await listAllAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('personal_rule.run');
    expect(entries[0]!.summary).toContain('Open ports on VMs');
    expect(entries[0]!.summary).toContain(SUBSCRIPTION_A);
    const everything = JSON.stringify(entries[0]);
    expect(everything).not.toContain('microsoft.compute');
    expect(everything).not.toContain('vm-one');
    expect(everything).not.toContain('project id');
  });

  it('writes nothing to findings, scans, schedule runs or snapshots', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, definition());

    await run(rule.id);

    for (const table of ['findings', 'finding_events', 'scans', 'schedule_runs', 'suppressions', 'posture_snapshots']) {
      expect(await countRows(table), table).toBe(0);
    }
  });
});

describe('planPersonalRun', () => {
  const grant = (path: string, role: Role = 'editor'): ScopeGrant => ({ tenantId: TEST_TENANT_ID, scope: parseScope(path)!, role });
  const access = (...grants: ScopeGrant[]) => buildAccess(grants, 'manual', []);

  it('refuses an owner who holds only resource groups', () => {
    const plan = planPersonalRun({ queryBackend: 'resource-graph', scope: { level: 'subscription' } }, access(grant(`${SUBSCRIPTION_A}/resourceGroups/rg-one`)));
    expect(plan.ok).toBe(false);
  });

  it('refuses an owner whose only subscription is held as a Viewer', () => {
    const plan = planPersonalRun({ queryBackend: 'resource-graph', scope: { level: 'subscription' } }, access(grant(SUBSCRIPTION_A, 'viewer')));
    expect(plan.ok).toBe(false);
  });

  it('refuses Log Analytics', () => {
    const plan = planPersonalRun({ queryBackend: 'log-analytics', scope: { level: 'subscription' } }, access(grant(SUBSCRIPTION_A)));
    expect(plan).toEqual({ ok: false, error: expect.stringContaining('Logs') });
  });

  it('keeps held casing and covers one entry per held Scope the rule reaches', () => {
    const plan = planPersonalRun(
      { queryBackend: 'resource-graph', scope: { level: 'subscription', subscriptions: [TEST_SUB_A.toUpperCase()] } },
      access(grant(SUBSCRIPTION_A), grant(SUBSCRIPTION_B)),
    );
    expect(plan).toEqual({
      ok: true,
      scope: { subscriptions: [TEST_SUB_A] },
      covered: [{ tenantId: TEST_TENANT_ID, path: SUBSCRIPTION_A }],
    });
  });
});

describe('limitedContext', () => {
  const grant = (path: string, role: Role = 'editor'): ScopeGrant => ({ tenantId: TEST_TENANT_ID, scope: parseScope(path)!, role });
  const access = (...grants: ScopeGrant[]) => buildAccess(grants, 'manual', []);

  it('refuses a Microsoft Graph request from someone who does not hold the Directory, and sends none', async () => {
    const ctx = fakeTenantContext();
    const limited = limitedContext(ctx, access(grant(SUBSCRIPTION_A)));
    await expect(limited.graphGet('users')).rejects.toThrow();
    expect(ctx.graphRequests).toEqual([]);
  });

  it('lets the holder of the Directory through', async () => {
    const ctx = fakeTenantContext();
    await limitedContext(ctx, access(grant(DIRECTORY))).graphGet('users');
    expect(ctx.graphRequests).toHaveLength(1);
  });

  it('never reaches Log Analytics', async () => {
    const ctx = fakeTenantContext();
    await expect(limitedContext(ctx, access(grant(SUBSCRIPTION_A))).queryLogs('SigninLogs')).rejects.toThrow();
    expect(ctx.logsQueries).toEqual([]);
  });

  it('refuses a Resource Graph request that shares nothing with what is held, rather than sending it empty', async () => {
    const ctx = fakeTenantContext();
    await expect(limitedContext(ctx, access(grant(SUBSCRIPTION_A))).queryARG('resources', { subscriptions: [TEST_SUB_B] })).rejects.toThrow();
    expect(ctx.queries).toEqual([]);
  });
});