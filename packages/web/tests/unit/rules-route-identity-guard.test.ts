/**
 * Spec 005 — POST /api/rules and PUT /api/rules/[id] must block saving a rawKql rule whose sampled
 * rows have no resource id, and must fail open (still save) when the probe itself can't run at all
 * (no Azure credential configured yet, or a transient connection failure) — see rule-identity-check.ts.
 * A GUI-built rule (no rawKql) must never trigger the probe, since there is nothing to sample.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, saveRules } from '@/lib/rules';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';
import type { Rule } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext | null;
let connectError: Error | null;
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => connectError ? Promise.reject(connectError) : Promise.resolve(fakeCtx),
}));

const { POST } = await import('@/app/api/rules/route');
const { PUT } = await import('@/app/api/rules/[id]/route');

function baseBody(overrides: Partial<Rule> = {}): Omit<Rule, 'id'> {
  return {
    name: 'test rule ' + Math.random().toString(36).slice(2),
    description: 'a test rule',
    category: 'security',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: [],
    conditions: [],
    ...overrides,
  };
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/rules', { method: 'POST', body: JSON.stringify(body) });
}
function putRequest(body: unknown): Request {
  return new Request('http://localhost/api/rules/x', { method: 'PUT', body: JSON.stringify(body) });
}

async function signInAsEditor(): Promise<void> {
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('POST /api/rules — identity guard (spec 005)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    await signInAsEditor();
  });

  it('blocks and does not persist a rawKql rule whose sample rows have no id', async () => {
    fakeCtx = fakeTenantContext({ rows: [{ name: 'no-id' }] });
    const body = baseBody({ rawKql: 'resources | summarize count() by type' });
    const before = (await loadRules()).length;

    const res = await POST(postRequest(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no resource id/);
    expect((await loadRules()).length).toBe(before);
  });

  it('saves a rawKql rule whose sample rows all carry an id', async () => {
    fakeCtx = fakeTenantContext({ rows: [argRow()] });
    const body = baseBody({ rawKql: 'resources | where type == "microsoft.compute/virtualmachines"' });

    const res = await POST(postRequest(body));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect((await loadRules()).some(r => r.id === json.id)).toBe(true);
  });

  it('fails open and still saves when the probe cannot connect to Azure at all', async () => {
    connectError = new Error('no credential configured');
    const body = baseBody({ rawKql: 'resources | where type == "microsoft.compute/virtualmachines"' });

    const res = await POST(postRequest(body));
    expect(res.status).toBe(201);
  });

  it('never probes a GUI-built rule that has no rawKql', async () => {
    // fakeCtx stays null — if the route tried to probe, await createTenantContext() would throw calling
    // queryARG on null, which is exactly what proves the probe was skipped.
    const body = baseBody();
    const res = await POST(postRequest(body));
    expect(res.status).toBe(201);
  });
});

describe('PUT /api/rules/[id] — identity guard (spec 005)', () => {
  let ruleId: string;

  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    connectError = null;
    fakeCtx = null;
    await signInAsEditor();

    ruleId = globalThis.crypto.randomUUID();
    await saveRules([
      ...await loadRules(),
      {
        id: ruleId,
        name: 'existing custom rule',
        description: 'a test rule',
        category: 'security',
        severity: 'medium',
        enabled: true,
        type: 'custom',
        scope: { level: 'subscription' },
        resourceTypes: [],
        conditions: [],
        rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
      },
    ]);
  });

  function put(body: Partial<Rule>) {
    return PUT(putRequest({ ...baseBody(), id: ruleId, ...body }), { params: Promise.resolve({ id: ruleId }) });
  }

  it('blocks an edit whose new rawKql samples rows with no id, leaving the stored rule untouched', async () => {
    fakeCtx = fakeTenantContext({ rows: [{ name: 'no-id' }] });
    const res = await put({ rawKql: 'resources | summarize count() by type' });
    expect(res.status).toBe(400);
    expect((await loadRules()).find(r => r.id === ruleId)?.rawKql).toBe('resources | where type == "microsoft.compute/virtualmachines"');
  });

  it('saves an edit whose new rawKql samples rows that all carry an id', async () => {
    fakeCtx = fakeTenantContext({ rows: [argRow()] });
    const res = await put({ rawKql: 'resources | where type == "microsoft.compute/disks"' });
    expect(res.status).toBe(200);
    expect((await loadRules()).find(r => r.id === ruleId)?.rawKql).toBe('resources | where type == "microsoft.compute/disks"');
  });
});
