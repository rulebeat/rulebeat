/**
 * #280: the Personal rule routes. The real `requireRole` and a real temp database; only the session
 * (`@/auth`) and `createTenantContext` are mocked. A Personal rule is read, edited, deleted and run by
 * its author alone: any other person, an Admin or an Editor on Everything included, is told "not found".
 *
 * Every id is fake: zero GUIDs and example.com.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, updateUserRole } from '@/lib/db/users';
import { listAllAuditEntries } from '@/lib/db/audit';
import { createPersonalRule, listPersonalRules, type PersonalRuleDefinition } from '@/lib/db/personal-rules';
import { loadRules } from '@/lib/rules';
import { fakeTenantContext, TEST_SUB_A, TEST_TENANT_ID, type FakeTenantContext } from '../helpers/fake-azure';
import { NEEDS_DIRECTORY_MESSAGE, NEEDS_SUBSCRIPTION_MESSAGE } from '@/lib/written-query';
import type { Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve(fakeCtx) };
});

const collection = await import('@/app/api/personal-rules/route');
const item = await import('@/app/api/personal-rules/[id]/route');
const runRoute = await import('@/app/api/personal-rules/[id]/run/route');

const SUBSCRIPTION_A = `/subscriptions/${TEST_SUB_A}`;
const GROUP_A = `/subscriptions/${TEST_SUB_A}/resourceGroups/rg-one`;
const DIRECTORY = '@directory';
const KQL = 'resources | where type =~ "microsoft.compute/virtualmachines" | project id, name, type, location, resourceGroup, subscriptionId';

const RG_BODY = {
  name: 'VMs I care about',
  description: 'mine',
  category: 'security',
  severity: 'high',
  scope: { level: 'subscription' },
  resourceTypes: [],
  conditions: [],
  rawKql: KQL,
};
const GRAPH_BODY = {
  name: 'Disabled users',
  description: '',
  category: 'identity',
  severity: 'medium',
  queryBackend: 'microsoft-graph',
  scope: { level: 'subscription' },
  resourceTypes: [],
  conditions: [],
  graphQuery: { path: 'users', filter: 'accountEnabled eq false' },
};

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

async function signInAsAdmin(): Promise<string> {
  const created = await createUser({ email: `admin-${Math.random().toString(36).slice(2)}@example.com`, role: 'admin' });
  if ('error' in created) throw new Error(created.error);
  mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
  return created.user.id;
}

const json = (method: string, body?: unknown) => new Request('http://localhost/api/personal-rules', {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

const post = (body: unknown) => collection.POST(json('POST', body));
const get = (id: string) => item.GET(json('GET'), idParams(id));
const put = (id: string, body: unknown) => item.PUT(json('PUT', body), idParams(id));
const del = (id: string) => item.DELETE(json('DELETE'), idParams(id));
const run = (id: string) => runRoute.POST(json('POST'), idParams(id));

function definition(name: string): PersonalRuleDefinition {
  return {
    name, description: '', category: 'security', severity: 'high', queryBackend: 'resource-graph', kind: 'state',
    scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: KQL,
  };
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  fakeCtx = fakeTenantContext();
});

describe('creating, editing and deleting', () => {
  it('lets an Editor on a subscription create, edit and delete a Resource Graph rule', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);

    const created = await post(RG_BODY);
    expect(created.status).toBe(201);
    const rule = await created.json() as { id: string; ownerId: string; queryBackend: string };
    expect(rule.ownerId).toBe(ownerId);
    expect(rule.queryBackend).toBe('resource-graph');

    const edited = await put(rule.id, { ...RG_BODY, name: 'Renamed' });
    expect(edited.status).toBe(200);
    expect((await edited.json() as { name: string }).name).toBe('Renamed');

    expect((await del(rule.id)).status).toBe(200);
    expect(await listPersonalRules(ownerId)).toEqual([]);
  });

  it('lets an Editor with the Directory create a Microsoft Graph rule', async () => {
    await editorOn(SUBSCRIPTION_A, DIRECTORY);
    const res = await post(GRAPH_BODY);
    expect(res.status).toBe(201);
    expect((await res.json() as { queryBackend: string }).queryBackend).toBe('microsoft-graph');
  });

  it('refuses a Microsoft Graph rule without the Directory, naming the Directory', async () => {
    await editorOn(SUBSCRIPTION_A);
    const res = await post(GRAPH_BODY);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe(NEEDS_DIRECTORY_MESSAGE);
  });

  it('refuses a Log Analytics rule with 400', async () => {
    await editorOn(SUBSCRIPTION_A);
    const res = await post({ ...RG_BODY, queryBackend: 'log-analytics', rawKql: undefined, logsQuery: { kql: 'SigninLogs', timeWindowDays: 7 } });
    expect(res.status).toBe(400);
  });

  it('refuses an Editor whose access is only resource groups, with the subscription message', async () => {
    const ownerId = await editorOn(GROUP_A);
    const res = await post(RG_BODY);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe(NEEDS_SUBSCRIPTION_MESSAGE);
    expect(await listPersonalRules(ownerId)).toEqual([]);
  });

  it('refuses a person who holds no Scope', async () => {
    await signInWith([]);
    expect((await post(RG_BODY)).status).toBe(403);
  });

  it('refuses a Viewer', async () => {
    await signInWith([{ scope: SUBSCRIPTION_A, role: 'viewer' }], 'viewer');
    expect((await post(RG_BODY)).status).toBe(403);
  });

  it('refuses a rule with no name with 400', async () => {
    await editorOn(SUBSCRIPTION_A);
    expect((await post({ ...RG_BODY, name: '  ' })).status).toBe(400);
  });

  it('ignores a type, pack, version or last run the client sends', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const res = await post({ ...RG_BODY, type: 'builtin', pack: 'aprl-v2', version: '9', lastRunAt: '2020-01-01T00:00:00.000Z', lastRunStatus: 'success' });
    expect(res.status).toBe(201);
    const [stored] = await listPersonalRules(ownerId);
    expect(stored!.type).toBe('custom');
    expect(stored!.lastRunAt).toBeUndefined();
  });

  it('never creates a shared rule', async () => {
    await editorOn(SUBSCRIPTION_A);
    const before = (await loadRules()).length;
    await post(RG_BODY);
    expect((await loadRules()).length).toBe(before);
  });

  it('probes Azure only through the owner\'s own subscriptions', async () => {
    await editorOn(SUBSCRIPTION_A);
    await post(RG_BODY);
    expect(fakeCtx.queries.length).toBeGreaterThan(0);
    for (const q of fakeCtx.queries) expect(q.scope).toEqual({ subscriptions: [TEST_SUB_A] });
  });

  it('writes an audit entry that names the rule and no query', async () => {
    await editorOn(SUBSCRIPTION_A);
    await post(RG_BODY);
    const [entry] = await listAllAuditEntries();
    expect(entry!.action).toBe('personal_rule.create');
    expect(entry!.summary).toContain('VMs I care about');
    expect(JSON.stringify(entry)).not.toContain('microsoft.compute');
  });
});

describe('only the author sees a Personal rule', () => {
  it('lists the caller\'s own rules and nobody else\'s', async () => {
    const mine = await editorOn(SUBSCRIPTION_A);
    const theirs = (await createUser({ email: 'someone-else@example.com', role: 'editor' }) as { user: { id: string } }).user.id;
    await createPersonalRule(mine, definition('Mine'));
    await createPersonalRule(theirs, definition('Theirs'));

    const res = await collection.GET();
    const names = (await res.json() as { name: string }[]).map(r => r.name);
    expect(names).toEqual(['Mine']);
  });

  it('answers 404 to every other person on GET, PUT, DELETE and run, an Admin and an Editor on Everything included', async () => {
    const authorId = (await createUser({ email: 'author@example.com', role: 'editor', access: [{ tenantId: TEST_TENANT_ID, scope: SUBSCRIPTION_A, role: 'editor' }] }) as { user: { id: string } }).user.id;
    const rule = await createPersonalRule(authorId, definition('Private'));

    const viewers: Array<() => Promise<string>> = [
      () => signInAsAdmin(),
      async () => {
        const created = await createUser({ email: 'everything-editor@example.com', role: 'editor', access: [{ tenantId: '', scope: '/', role: 'editor' }] });
        if ('error' in created) throw new Error(created.error);
        mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
        return created.user.id;
      },
      () => editorOn(SUBSCRIPTION_A),
    ];
    for (const becomes of viewers) {
      await becomes();
      expect((await get(rule.id)).status).toBe(404);
      expect((await put(rule.id, RG_BODY)).status).toBe(404);
      expect((await del(rule.id)).status).toBe(404);
      expect((await run(rule.id)).status).toBe(404);
    }
    expect(await listPersonalRules(authorId)).toHaveLength(1);
    expect(fakeCtx.queries).toEqual([]);
  });

  it('answers 404 for an id that does not exist, the same as for someone else\'s', async () => {
    await editorOn(SUBSCRIPTION_A);
    const res = await get('00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('gives the author their rule with its results', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, definition('Mine'));
    const res = await get(rule.id);
    expect(res.status).toBe(200);
    const body = await res.json() as { rule: { id: string }; results: unknown[] };
    expect(body.rule.id).toBe(rule.id);
    expect(body.results).toEqual([]);
  });
});

describe('a demoted author', () => {
  it('still reads their rule but cannot edit, delete or run it', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, definition('Kept'));
    expect((await updateUserRole(ownerId, 'viewer'))).toMatchObject({ user: { role: 'viewer' } });

    expect((await get(rule.id)).status).toBe(200);
    expect((await collection.GET().then(r => r.json()) as unknown[])).toHaveLength(1);
    expect((await put(rule.id, RG_BODY)).status).toBe(403);
    expect((await del(rule.id)).status).toBe(403);
    expect((await run(rule.id)).status).toBe(403);
    expect(await listPersonalRules(ownerId)).toHaveLength(1);
    expect(fakeCtx.queries).toEqual([]);
  });
});

describe('an author who lost every Scope', () => {
  it('still reads their rule, and a run is refused', async () => {
    const ownerId = await editorOn(SUBSCRIPTION_A);
    const rule = await createPersonalRule(ownerId, definition('Kept'));
    const { setManualAccess } = await import('@/lib/db/users');
    await setManualAccess(ownerId, [{ tenantId: TEST_TENANT_ID, scope: GROUP_A, role: 'editor' }]);

    expect((await get(rule.id)).status).toBe(200);
    const res = await run(rule.id);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe(NEEDS_SUBSCRIPTION_MESSAGE);
    expect(fakeCtx.queries).toEqual([]);
  });
});
