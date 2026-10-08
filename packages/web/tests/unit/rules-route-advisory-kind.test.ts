/**
 * Issue #176 — an editor can mark a rule Advisory when creating or editing it. The kind is
 * resolved on the server (`resolveKind()` in lib/rules.ts) from the backend plus the kind asked
 * for, so a forged or impossible value never reaches the `rules.kind` column: a Logs rule is always
 * 'activity', anything else is 'state' unless it asked for 'advisory'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, saveRules, resolveKind } from '@/lib/rules';
import { listAuditEntries } from '@/lib/db/audit';
import type { Rule } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('no credential configured')),
}));

const { POST } = await import('@/app/api/rules/route');
const { PUT } = await import('@/app/api/rules/[id]/route');

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'advisory test rule ' + Math.random().toString(36).slice(2),
    description: 'a test rule',
    category: 'security',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: [],
    conditions: [],
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
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

const storedKind = async (id: string) => (await loadRules()).find(r => r.id === id)?.kind;

describe('resolveKind()', () => {
  it('is activity for Logs whatever was asked, advisory only on request for the other backends, else state', () => {
    expect(resolveKind('log-analytics')).toBe('activity');
    expect(resolveKind('log-analytics', 'advisory')).toBe('activity');
    expect(resolveKind('log-analytics', 'state')).toBe('activity');
    for (const backend of ['resource-graph', 'microsoft-graph'] as const) {
      expect(resolveKind(backend)).toBe('state');
      expect(resolveKind(backend, 'advisory')).toBe('advisory');
      expect(resolveKind(backend, 'state')).toBe('state');
      expect(resolveKind(backend, 'activity')).toBe('state');
      expect(resolveKind(backend, 'bogus' as never)).toBe('state');
    }
  });
});

describe('POST /api/rules, kind', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsEditor();
  });

  it('stores an Advisory rule as advisory', async () => {
    const res = await post(body({ kind: 'advisory' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.kind).toBe('advisory');
    expect(await storedKind(json.id)).toBe('advisory');
  });

  it('stores a rule that omits kind as state', async () => {
    const json = await (await post(body())).json();
    expect(await storedKind(json.id)).toBe('state');
  });

  it('applies to a Directory rule too', async () => {
    const res = await post(body({
      queryBackend: 'microsoft-graph', rawKql: undefined, kind: 'advisory',
      graphQuery: { path: 'users', filter: 'accountEnabled eq false' },
    }));
    expect(res.status).toBe(201);
    expect(await storedKind((await res.json()).id)).toBe('advisory');
  });

  it('refuses Advisory on a Logs rule with a stable message, and stores nothing', async () => {
    const before = (await loadRules()).length;
    const res = await post(body({
      queryBackend: 'log-analytics', rawKql: undefined, kind: 'advisory',
      logsQuery: { kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 },
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Advisory/);
    expect(json.error).not.toContain('\u2014');
    expect((await loadRules()).length).toBe(before);
  });

  it.each(['activity', 'garbage', 7, null])('never lets a forged kind %j stick on a Resource Graph rule', async (forged) => {
    const res = await post(body({ kind: forged }));
    expect(res.status).toBe(201);
    expect(await storedKind((await res.json()).id)).toBe('state');
  });
});

describe('PUT /api/rules/[id], kind', () => {
  let id: string;
  let name: string;

  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsEditor();
    name = 'switchable rule ' + Math.random().toString(36).slice(2);
    id = (await (await post(body({ name }))).json()).id;
  });

  const edit = (overrides: Record<string, unknown>) => put(id, body({ name, id, ...overrides }));

  it('switches a Problem rule to Advisory and back, and audits the field name', async () => {
    expect((await edit({ kind: 'advisory' })).status).toBe(200);
    expect(await storedKind(id)).toBe('advisory');
    const entry = (await listAuditEntries()).find(e => e.entityId === id && e.action === 'rule.update');
    expect(JSON.stringify(entry?.details)).toContain('"kind"');

    expect((await edit({ kind: 'state' })).status).toBe(200);
    expect(await storedKind(id)).toBe('state');
  });

  it('keeps the stored kind when the edit omits it', async () => {
    await edit({ kind: 'advisory' });
    expect((await edit({ description: 'edited again' })).status).toBe(200);
    expect(await storedKind(id)).toBe('advisory');
  });

  it('does not list kind as changed when it did not change', async () => {
    await edit({ kind: 'advisory' });
    await edit({ kind: 'advisory', description: 'only the description' });
    const entries = (await listAuditEntries()).filter(e => e.entityId === id && e.action === 'rule.update');
    expect(JSON.stringify(entries[0].details)).not.toContain('"kind"');
  });

  it.each(['activity', 'garbage'])('resolves a forged kind %j to state', async (forged) => {
    await edit({ kind: 'advisory' });
    expect((await edit({ kind: forged })).status).toBe(200);
    expect(await storedKind(id)).toBe('state');
  });

  it('refuses Advisory on a Logs rule and leaves it activity', async () => {
    const logsId = globalThis.crypto.randomUUID();
    const logs: Rule = {
      id: logsId, name: 'logs rule ' + logsId, description: 'd', category: 'identity', severity: 'medium',
      enabled: true, type: 'custom', queryBackend: 'log-analytics', scope: { level: 'resource' },
      resourceTypes: [], conditions: [], logsQuery: { kql: 'SigninLogs', timeWindowDays: 30 },
    };
    await saveRules([...await loadRules(), logs]);
    const res = await put(logsId, { ...logs, kind: 'advisory' });
    expect(res.status).toBe(400);
    expect(await storedKind(logsId)).toBe('activity');
  });

  it('lets a built-in rule be marked Advisory while its query stays locked', async () => {
    const builtin = (await loadRules()).find(r => r.type === 'builtin' && (r.queryBackend ?? 'resource-graph') === 'resource-graph')!;
    expect(builtin).toBeDefined();
    const res = await put(builtin.id, { ...builtin, kind: 'advisory' });
    expect(res.status).toBe(200);
    expect(await storedKind(builtin.id)).toBe('advisory');
    const omitted = await put(builtin.id, { ...builtin, kind: undefined, enabled: false });
    expect(omitted.status).toBe(200);
    expect(await storedKind(builtin.id)).toBe('advisory');
  });
});
