/**
 * Applies to was removed. POST /api/rules and PUT /api/rules/[id] reject a body that still carries
 * `appliesTo` with a 400 and a fixed message, rather than silently dropping the field, and nothing
 * is written: no rule is created and an existing rule, custom or built-in, is left as it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, saveRules } from '@/lib/rules';
import type { Rule, VisualQuery } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('not configured in this test file')),
}));

const { POST } = await import('@/app/api/rules/route');
const { PUT } = await import('@/app/api/rules/[id]/route');

const EXPECTED_ERROR = 'Applies to has been removed. Remove the appliesTo field from the request.';

// What an old client or script would still send: a real, compilable stage-based query.
const appliesTo: VisualQuery = {
  stages: [{
    id: 'f1',
    type: 'filter',
    groups: [{ id: 'g1', conditions: [{ id: 'c1', field: 'name', operator: 'exists' }] }],
  }],
};

function baseBody(overrides: Partial<Rule> = {}): Omit<Rule, 'id'> {
  return {
    name: 'applies-to removal test rule ' + Math.random().toString(36).slice(2),
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

describe('POST /api/rules rejects appliesTo', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsEditor();
  });

  it('returns 400 with the removal message and creates no rule', async () => {
    const body = baseBody();
    const before = await loadRules();
    const res = await POST(postRequest({ ...body, appliesTo }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(EXPECTED_ERROR);
    const after = await loadRules();
    expect(after.length).toBe(before.length);
    expect(after.some(r => r.name === body.name)).toBe(false);
  });

  it('rejects the key even when its value is null', async () => {
    const res = await POST(postRequest({ ...baseBody(), appliesTo: null }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(EXPECTED_ERROR);
  });

  it('still creates the same rule when appliesTo is absent', async () => {
    const body = baseBody();
    const res = await POST(postRequest(body));
    expect(res.status).toBe(201);
    expect((await loadRules()).some(r => r.name === body.name)).toBe(true);
  });
});

describe('PUT /api/rules/[id] rejects appliesTo', () => {
  let customRuleId: string;

  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsEditor();
    customRuleId = globalThis.crypto.randomUUID();
    await saveRules([
      ...(await loadRules()).filter(r => r.type === 'builtin'),
      { ...baseBody({ name: 'existing custom rule' }), id: customRuleId },
    ]);
  });

  it('returns 400 for a custom rule and leaves the stored rule unchanged', async () => {
    const before = (await loadRules()).find(r => r.id === customRuleId);
    const res = await PUT(
      putRequest({ ...baseBody({ name: 'renamed by a rejected edit', severity: 'high' }), id: customRuleId, appliesTo }),
      { params: Promise.resolve({ id: customRuleId }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(EXPECTED_ERROR);
    expect((await loadRules()).find(r => r.id === customRuleId)).toEqual(before);
  });

  it('returns 400 for a built-in rule and leaves the stored rule unchanged', async () => {
    const builtin = (await loadRules()).find(r => r.type === 'builtin' && r.queryBackend !== 'microsoft-graph');
    expect(builtin, 'no seeded built-in rule to edit').toBeDefined();
    const res = await PUT(
      putRequest({ enabled: !builtin!.enabled, tags: ['rejected-edit'], appliesTo }),
      { params: Promise.resolve({ id: builtin!.id }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(EXPECTED_ERROR);
    expect((await loadRules()).find(r => r.id === builtin!.id)).toEqual(builtin);
  });

  it('still saves the same custom-rule edit when appliesTo is absent', async () => {
    const res = await PUT(
      putRequest({ ...baseBody({ name: 'renamed by an accepted edit' }), id: customRuleId }),
      { params: Promise.resolve({ id: customRuleId }) },
    );
    expect(res.status).toBe(200);
    expect((await loadRules()).find(r => r.id === customRuleId)?.name).toBe('renamed by an accepted edit');
  });
});

