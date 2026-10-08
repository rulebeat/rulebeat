/**
 * Issue #178: the Group column is a stored, install-owned setting of a rule, like the Deadline
 * column. These tests go through the rule routes: it is saved when the query projects it, refused
 * with a message when it does not, kept across a kind switch and an edit that omits it, clearable,
 * independent of the Deadline column, and audited by field name only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, saveRules } from '@/lib/rules';
import { listAuditEntries } from '@/lib/db/audit';
import type { Rule } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const probe = vi.fn<(kql: string) => Promise<Record<string, unknown>[]>>();
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.resolve({ queryARG: (kql: string) => probe(kql) }),
}));

const { POST } = await import('@/app/api/rules/route');
const { PUT } = await import('@/app/api/rules/[id]/route');

const KQL = 'resources | where type == "microsoft.compute/virtualmachines" | project id, name, type, location, resourceGroup, subscriptionId, owner = tostring(tags.owner), retiresOn = tostring(properties.retireDate)';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'group test rule ' + Math.random().toString(36).slice(2),
    description: 'a test rule', category: 'security', severity: 'medium', enabled: true, type: 'custom',
    scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: KQL, kind: 'advisory',
    ...overrides,
  };
}

const post = (b: unknown) => POST(new Request('http://localhost/api/rules', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}));
const put = (id: string, b: unknown) => PUT(new Request('http://localhost/api/rules/x', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}), { params: Promise.resolve({ id }) });

async function signInAsEditor(): Promise<void> {
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

const stored = async (id: string) => (await loadRules()).find(r => r.id === id)!;

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  probe.mockReset();
  probe.mockResolvedValue([]);
  await signInAsEditor();
});

describe('POST /api/rules, Group column', () => {
  it('stores a Group column the query projects', async () => {
    const res = await post(body({ groupField: 'owner' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.groupField).toBe('owner');
    expect((await stored(json.id)).groupField).toBe('owner');
  });

  it('stores the Group and Deadline columns independently', async () => {
    const json = await (await post(body({ groupField: 'owner', deadlineField: 'retiresOn' }))).json();
    const rule = await stored(json.id);
    expect(rule.groupField).toBe('owner');
    expect(rule.deadlineField).toBe('retiresOn');
  });

  it('refuses a column the query does not project, names it as a Group column, and stores nothing', async () => {
    const before = (await loadRules()).length;
    const res = await post(body({ groupField: 'team' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('"team"');
    expect(json.error).toContain('Group');
    expect(json.error).not.toContain('\u2014');
    expect((await loadRules()).length).toBe(before);
  });

  it('refuses a column the builder does not project by default, and accepts a default one', async () => {
    const builder = { rawKql: undefined, visualQuery: undefined };
    expect((await post(body({ ...builder, groupField: 'team' }))).status).toBe(400);
    expect((await post(body({ ...builder, groupField: 'resourceGroup' }))).status).toBe(201);
  });

  it('samples a query it cannot read, refusing when the rows lack the column', async () => {
    const unreadable = { rawKql: 'resources | where type == "microsoft.compute/virtualmachines"' };
    probe.mockResolvedValue([{ id: 'a', name: 'b' }]);
    expect((await post(body({ ...unreadable, groupField: 'team' }))).status).toBe(400);
    expect(probe).toHaveBeenCalled();
    probe.mockResolvedValue([{ id: 'a', team: 'platform' }]);
    expect((await post(body({ ...unreadable, groupField: 'team' }))).status).toBe(201);
  });

  it('refuses a Group column on a Directory rule', async () => {
    const res = await post(body({
      queryBackend: 'microsoft-graph', rawKql: undefined, groupField: 'x',
      graphQuery: { path: 'users', filter: 'accountEnabled eq false' },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Resource Graph/);
  });

  it('refuses a Group column on a Logs rule', async () => {
    const res = await post(body({
      queryBackend: 'log-analytics', rawKql: undefined, kind: undefined, groupField: 'x',
      logsQuery: { kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 },
    }));
    expect(res.status).toBe(400);
  });

  it('refuses a column that is not a string', async () => {
    expect((await post(body({ groupField: 5 }))).status).toBe(400);
  });

  it('stores a rule with no Group column as none', async () => {
    const json = await (await post(body())).json();
    expect((await stored(json.id)).groupField).toBeUndefined();
  });
});

describe('PUT /api/rules/[id], Group column', () => {
  let id: string;
  let name: string;

  beforeEach(async () => {
    name = 'editable rule ' + Math.random().toString(36).slice(2);
    id = (await (await post(body({ name, groupField: 'owner' }))).json()).id;
  });

  const edit = (overrides: Record<string, unknown>) => put(id, body({ name, id, ...overrides }));

  it('keeps the column across a switch to Problem and back', async () => {
    expect((await edit({ kind: 'state' })).status).toBe(200);
    expect((await stored(id)).kind).toBe('state');
    expect((await stored(id)).groupField).toBe('owner');
    expect((await edit({ kind: 'advisory' })).status).toBe(200);
    expect((await stored(id)).groupField).toBe('owner');
  });

  it('keeps the column when the edit omits it', async () => {
    expect((await edit({ description: 'edited' })).status).toBe(200);
    expect((await stored(id)).groupField).toBe('owner');
  });

  it('leaves the Group column alone when only the Deadline column is edited', async () => {
    expect((await edit({ deadlineField: 'retiresOn' })).status).toBe(200);
    const rule = await stored(id);
    expect(rule.groupField).toBe('owner');
    expect(rule.deadlineField).toBe('retiresOn');
  });

  it.each([null, '', '  '])('clears the column when asked with %j', async cleared => {
    expect((await edit({ groupField: cleared })).status).toBe(200);
    expect((await stored(id)).groupField).toBeUndefined();
  });

  it('changes the column to another projected one, and refuses an unprojected one', async () => {
    expect((await edit({ groupField: 'retiresOn' })).status).toBe(200);
    expect((await stored(id)).groupField).toBe('retiresOn');
    const res = await edit({ groupField: 'team' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('"team"');
    expect((await stored(id)).groupField).toBe('retiresOn');
  });

  it('refuses an edit that drops the column from the query while the rule is an Advisory', async () => {
    const res = await edit({ rawKql: 'resources | project id, name' });
    expect(res.status).toBe(400);
    expect((await stored(id)).rawKql).toBe(KQL);
  });

  it('lets the query be edited once the rule is a Problem and the stale column is unchanged', async () => {
    await edit({ kind: 'state' });
    const res = await edit({ kind: 'state', rawKql: 'resources | project id, name', groupField: 'owner' });
    expect(res.status).toBe(200);
    expect((await stored(id)).groupField).toBe('owner');
  });

  it('audits the change by field name, never by value', async () => {
    await edit({ groupField: 'retiresOn' });
    const entry = (await listAuditEntries()).find(e => e.entityId === id && e.action === 'rule.update');
    const details = JSON.stringify(entry?.details);
    expect(details).toContain('"groupField"');
    expect(details).not.toContain('owner');
    expect(details).not.toContain('retiresOn');
  });

  it('does not list the column as changed when it did not change', async () => {
    await edit({ groupField: 'owner', description: 'only the description' });
    const entry = (await listAuditEntries()).find(e => e.entityId === id && e.action === 'rule.update');
    expect(JSON.stringify(entry?.details)).not.toContain('"groupField"');
  });

  it('refuses a Group column on a Directory rule', async () => {
    const graphId = globalThis.crypto.randomUUID();
    const graph: Rule = {
      id: graphId, name: 'directory rule ' + graphId, description: 'd', category: 'identity', severity: 'medium',
      enabled: true, type: 'custom', queryBackend: 'microsoft-graph', scope: { level: 'resource' },
      resourceTypes: [], conditions: [], graphQuery: { path: 'users' },
    };
    await saveRules([...await loadRules(), graph]);
    expect((await put(graphId, { ...graph, kind: 'advisory', groupField: 'x' })).status).toBe(400);
  });

  it('lets a built-in rule have a Group column set, keeping its locked query', async () => {
    const builtin = (await loadRules()).find(r => r.type === 'builtin' && (r.queryBackend ?? 'resource-graph') === 'resource-graph' && r.rawKql && /\|\s*project\s/i.test(r.rawKql));
    if (!builtin) throw new Error('no built-in rule with a trailing project to test against');
    const column = (await import('@rulebeat/core/kql')).projectedColumnNames(builtin.rawKql!)![0];
    const res = await put(builtin.id, { ...builtin, kind: 'advisory', groupField: column });
    expect(res.status).toBe(200);
    const after = await stored(builtin.id);
    expect(after.groupField).toBe(column);
    expect(after.rawKql).toBe(builtin.rawKql);
    expect((await put(builtin.id, { ...builtin, kind: 'advisory', groupField: 'noSuchColumn' })).status).toBe(400);
  });
});
