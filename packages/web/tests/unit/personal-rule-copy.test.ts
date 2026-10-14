/**
 * #281: copying a shared rule to Personal. The real `requireRole` and a real temp database; only the session
 * (`@/auth`) and `createTenantContext` are mocked. The copy keeps the source's definition, starts with no
 * results, holds a scope cut down to what the author holds, and remembers where it came from until that
 * source is deleted.
 *
 * Every id is fake: zero GUIDs and example.com.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@rulebeat/core';
import { countRows, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { listAllAuditEntries } from '@/lib/db/audit';
import { getPersonalRule, listPersonalRuleResults, listPersonalRules, type PersonalRule } from '@/lib/db/personal-rules';
import { createRule, deleteRule, loadRule } from '@/lib/rules';
import { resolveAccess } from '@/lib/access';
import { heldQueryScopes } from '@/lib/written-query';
import { fakeTenantContext, TEST_SUB_A, TEST_TENANT_ID, type FakeTenantContext } from '../helpers/fake-azure';
import { LOGS_PAUSED_MESSAGE } from '@/lib/personal-rule-run';
import { NEEDS_DIRECTORY_MESSAGE, NEEDS_SUBSCRIPTION_MESSAGE } from '@/lib/written-query';
import type { Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return { ...actual, createTenantContext: () => Promise.resolve(fakeCtx) };
});

const copyRoute = await import('@/app/api/rules/[id]/personal-copy/route');
const personalItem = await import('@/app/api/personal-rules/[id]/route');

const SUB_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const SUBSCRIPTION_A = `/subscriptions/${TEST_SUB_A}`;
const GROUP_A = `/subscriptions/${TEST_SUB_A}/resourceGroups/rg-one`;
const MG = '/providers/Microsoft.Management/managementGroups/';
const DIRECTORY = '@directory';
const EVERYTHING = '/';
const KQL = 'resources | where type =~ "microsoft.compute/virtualmachines" | project id, name, type, location, resourceGroup, subscriptionId';

async function signInWith(held: { scope: string; role: Role }[], role: Role = 'editor'): Promise<string> {
  const created = await createUser({
    email: `person-${Math.random().toString(36).slice(2)}@example.com`,
    role,
    access: held.map(h => ({ tenantId: h.scope === EVERYTHING ? '' : TEST_TENANT_ID, scope: h.scope, role: h.role })),
  });
  if ('error' in created) throw new Error(created.error);
  mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
  return created.user.id;
}
const editorOn = (...scopes: string[]) => signInWith(scopes.map(scope => ({ scope, role: 'editor' as const })));

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const copy = (id: string) => copyRoute.POST(
  new Request(`http://localhost/api/rules/${id}/personal-copy`, { method: 'POST' }), idParams(id));
const putPersonal = (id: string, body: unknown) => personalItem.PUT(
  new Request(`http://localhost/api/personal-rules/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), idParams(id));

let seeded = 0;
async function sharedRule(overrides: Partial<Rule> = {}): Promise<Rule> {
  seeded += 1;
  const rule = {
    id: `00000000-0000-0000-0000-${String(seeded).padStart(12, '0')}`,
    name: `Shared rule ${seeded}`,
    description: 'Flags virtual machines',
    category: 'security',
    severity: 'high',
    enabled: true,
    type: 'custom',
    queryBackend: 'resource-graph',
    kind: 'state',
    tags: ['vm', 'baseline'],
    scope: { level: 'subscription' },
    resourceTypes: ['microsoft.compute/virtualmachines'],
    conditions: [{ field: 'location', operator: 'equals', value: 'westeurope' }],
    rawKql: KQL,
    ...overrides,
  } as Rule;
  const created = await createRule(rule);
  if (!created.ok) throw new Error(created.reason);
  return rule;
}

const copyOf = async (id: string): Promise<PersonalRule> => (await copy(id).then(r => r.json())) as PersonalRule;

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  fakeCtx = fakeTenantContext();
});

describe('copying a shared rule', () => {
  it('lets an Editor on Everything copy it, keeping the whole definition and the scope as it was', async () => {
    const ownerId = await editorOn(EVERYTHING);
    const source = await sharedRule({ scope: { level: 'subscription', subscriptions: [TEST_SUB_A, SUB_B], managementGroups: ['mg-example'] } });

    const res = await copy(source.id);
    expect(res.status).toBe(201);
    const made = await res.json() as PersonalRule;

    expect(made.ownerId).toBe(ownerId);
    expect(made.id).not.toBe(source.id);
    expect(made).toMatchObject({
      name: source.name, description: source.description, category: 'security', severity: 'high',
      queryBackend: 'resource-graph', kind: 'state', tags: ['vm', 'baseline'],
      resourceTypes: ['microsoft.compute/virtualmachines'], conditions: source.conditions, rawKql: KQL,
      scope: { level: 'subscription', subscriptions: [TEST_SUB_A, SUB_B], managementGroups: ['mg-example'] },
    });
    expect(await listPersonalRules(ownerId)).toHaveLength(1);
  });

  it('copies a built-in rule as well, leaving the source as it was', async () => {
    await editorOn(EVERYTHING);
    const source = await sharedRule({ type: 'builtin', pack: 'rulebeat-core' } as Partial<Rule>);

    const res = await copy(source.id);
    expect(res.status).toBe(201);
    expect((await res.json() as PersonalRule).name).toBe(source.name);
    expect(await loadRule(source.id)).toMatchObject({ type: 'builtin', pack: 'rulebeat-core' });
  });

  it('copies a Microsoft Graph rule for someone holding the Directory, graph query included', async () => {
    await editorOn(SUBSCRIPTION_A, DIRECTORY);
    const source = await sharedRule({
      queryBackend: 'microsoft-graph', kind: 'state', rawKql: undefined,
      graphQuery: { path: 'users', filter: 'accountEnabled eq false' },
    } as Partial<Rule>);

    const res = await copy(source.id);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ queryBackend: 'microsoft-graph', graphQuery: { path: 'users', filter: 'accountEnabled eq false' } });
  });

  it('copies a visual query as it is', async () => {
    await editorOn(EVERYTHING);
    const visualQuery = { resourceTypes: ['microsoft.compute/virtualmachines'], conditions: [], conditionGroups: [] };
    const source = await sharedRule({ rawKql: undefined, visualQuery } as unknown as Partial<Rule>);

    expect(await copy(source.id).then(r => r.json())).toMatchObject({ visualQuery });
  });
});

describe('the scope of the copy', () => {
  it('keeps only the subscription the Editor holds, of two the source names', async () => {
    await editorOn(SUBSCRIPTION_A);
    const source = await sharedRule({ scope: { level: 'subscription', subscriptions: [TEST_SUB_A, SUB_B] } });

    const made = await copyOf(source.id);
    expect(made.scope).toEqual({ level: 'subscription', subscriptions: [TEST_SUB_A], managementGroups: [] });
  });

  it('keeps only the management group the Editor holds', async () => {
    await editorOn(`${MG}mg-held`);
    const source = await sharedRule({ scope: { level: 'managementGroup', managementGroups: ['mg-held', 'mg-other'] } });

    const made = await copyOf(source.id);
    expect(made.scope).toEqual({ level: 'managementGroup', subscriptions: [], managementGroups: ['mg-held'] });
  });

  it('gives empty lists when the source names only a subscription the Editor does not hold', async () => {
    await editorOn(SUBSCRIPTION_A);
    const source = await sharedRule({ scope: { level: 'subscription', subscriptions: [SUB_B] } });

    const made = await copyOf(source.id);
    expect(made.scope).toEqual({ level: 'subscription', subscriptions: [], managementGroups: [] });
  });

  it('gives empty lists for a source with an empty scope', async () => {
    await editorOn(SUBSCRIPTION_A);
    const source = await sharedRule({ scope: { level: 'subscription' } });

    const made = await copyOf(source.id);
    expect(made.scope).toEqual({ level: 'subscription', subscriptions: [], managementGroups: [] });
  });

  it('never stores outsideAccess', async () => {
    await editorOn(SUBSCRIPTION_A);
    const source = await sharedRule({ scope: { level: 'subscription', subscriptions: [TEST_SUB_A], outsideAccess: 3 } as Rule['scope'] });

    expect(await copyOf(source.id)).not.toHaveProperty('scope.outsideAccess');
  });

  it('stores nothing outside what each allowed person holds, whatever the source names', async () => {
    const source = await sharedRule({
      scope: { level: 'subscription', subscriptions: [TEST_SUB_A, SUB_B], managementGroups: ['mg-held', 'mg-other'] },
    });
    const people: string[][] = [[SUBSCRIPTION_A], [`${MG}mg-held`], [SUBSCRIPTION_A, `${MG}mg-held`, DIRECTORY], [`/subscriptions/${SUB_B}`]];

    for (const held of people) {
      const userId = await editorOn(...held);
      const access = (await resolveAccess({ id: userId } as never)) as Parameters<typeof heldQueryScopes>[0];
      const limit = heldQueryScopes(access);

      const made = await copyOf(source.id);
      for (const entry of made.scope.subscriptions ?? []) expect(limit.subscriptions.map(s => s.toLowerCase())).toContain(entry.toLowerCase());
      for (const entry of made.scope.managementGroups ?? []) expect(limit.managementGroups.map(s => s.toLowerCase())).toContain(entry.toLowerCase());
    }
  });
});

describe('who may copy', () => {
  it('refuses a Viewer with 403 and writes nothing', async () => {
    const ownerId = await signInWith([{ scope: SUBSCRIPTION_A, role: 'viewer' }], 'viewer');
    const source = await sharedRule();

    expect((await copy(source.id)).status).toBe(403);
    expect(await listPersonalRules(ownerId)).toEqual([]);
    expect(await countRows('personal_rules')).toBe(0);
  });

  it('refuses an Editor whose access is only resource groups, with the subscription message', async () => {
    await editorOn(GROUP_A);
    const source = await sharedRule();

    const res = await copy(source.id);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe(NEEDS_SUBSCRIPTION_MESSAGE);
    expect(await countRows('personal_rules')).toBe(0);
  });

  it('refuses a Microsoft Graph source for someone without the Directory', async () => {
    await editorOn(SUBSCRIPTION_A);
    const source = await sharedRule({ queryBackend: 'microsoft-graph', rawKql: undefined, graphQuery: { path: 'users' } } as Partial<Rule>);

    const res = await copy(source.id);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe(NEEDS_DIRECTORY_MESSAGE);
    expect(await countRows('personal_rules')).toBe(0);
  });

  it('refuses a Log Analytics source with 400', async () => {
    await editorOn(EVERYTHING);
    const source = await sharedRule({
      queryBackend: 'log-analytics', kind: 'activity', rawKql: undefined, logsQuery: { kql: 'SigninLogs', timeWindowDays: 7 },
    } as Partial<Rule>);

    const res = await copy(source.id);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe(LOGS_PAUSED_MESSAGE);
    expect(await countRows('personal_rules')).toBe(0);
  });

  it('answers 404 for an unknown source', async () => {
    await editorOn(EVERYTHING);
    expect((await copy('00000000-0000-0000-0000-0000000000ff')).status).toBe(404);
    expect(await countRows('personal_rules')).toBe(0);
  });
});

describe('what the copy starts with', () => {
  it('has no results and no last run, and writes no finding, event, scan or suppression', async () => {
    const ownerId = await editorOn(EVERYTHING);
    const source = await sharedRule();
    const before = {
      findings: await countRows('findings'), events: await countRows('finding_events'),
      scans: await countRows('scans'), suppressions: await countRows('suppressions'),
    };

    const made = await copyOf(source.id);

    expect(made.lastRunAt).toBeUndefined();
    expect(await countRows('personal_rule_results')).toBe(0);
    expect(await listPersonalRuleResults(made.id, ownerId)).toEqual([]);
    expect((await getPersonalRule(made.id, ownerId))!.lastRunStatus).toBeUndefined();
    expect({
      findings: await countRows('findings'), events: await countRows('finding_events'),
      scans: await countRows('scans'), suppressions: await countRows('suppressions'),
    }).toEqual(before);
    expect(fakeCtx.queries).toEqual([]);
  });
});

describe('the link to the source', () => {
  it('records the source id', async () => {
    const ownerId = await editorOn(EVERYTHING);
    const source = await sharedRule();

    const made = await copyOf(source.id);
    expect(made.sourceRuleId).toBe(source.id);
    expect((await getPersonalRule(made.id, ownerId))!.sourceRuleId).toBe(source.id);
  });

  it('cannot be set or changed through PUT /api/personal-rules/[id]', async () => {
    const ownerId = await editorOn(EVERYTHING);
    const source = await sharedRule();
    const made = await copyOf(source.id);

    const res = await putPersonal(made.id, { ...made, name: 'Renamed copy', sourceRuleId: 'someone-elses-rule' });
    expect(res.status).toBe(200);

    const stored = (await getPersonalRule(made.id, ownerId))!;
    expect(stored.name).toBe('Renamed copy');
    expect(stored.sourceRuleId).toBe(source.id);
  });

  it('goes when the source is deleted, and the copy and its definition stay', async () => {
    const ownerId = await editorOn(EVERYTHING);
    const source = await sharedRule();
    const made = await copyOf(source.id);

    expect(await deleteRule(source.id)).toBe(true);

    const stored = (await getPersonalRule(made.id, ownerId))!;
    expect(stored.sourceRuleId).toBeUndefined();
    expect(stored).toMatchObject({ name: source.name, rawKql: KQL, tags: ['vm', 'baseline'] });
  });

  it('is kept on a copy of another source when one source is deleted', async () => {
    const ownerId = await editorOn(EVERYTHING);
    const gone = await sharedRule();
    const kept = await sharedRule();
    const goneCopy = await copyOf(gone.id);
    const keptCopy = await copyOf(kept.id);

    await deleteRule(gone.id);

    expect((await getPersonalRule(goneCopy.id, ownerId))!.sourceRuleId).toBeUndefined();
    expect((await getPersonalRule(keptCopy.id, ownerId))!.sourceRuleId).toBe(kept.id);
  });
});

describe('the audit entry', () => {
  it('is one personal_rule.copy entry naming the source and the copy, with no query', async () => {
    await editorOn(EVERYTHING);
    const source = await sharedRule();

    const made = await copyOf(source.id);
    const entries = (await listAllAuditEntries()).filter(e => e.action === 'personal_rule.copy');

    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toContain(source.name);
    expect(entries[0]!.entityId).toBe(made.id);
    expect(JSON.stringify(entries[0])).not.toContain('microsoft.compute');
  });
});
