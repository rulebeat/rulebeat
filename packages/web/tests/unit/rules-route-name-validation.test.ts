/**
 * POST /api/rules and PUT /api/rules/[id] pass body.name straight to isNameTaken(), which calls
 * name.trim(). A body with no name, or a name that is not a string, used to throw and answer 500.
 * Both routes must instead answer 400 with a short message, and nothing is written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, saveRules } from '@/lib/rules';
import type { Rule } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('not configured in this test file')),
}));

const { POST } = await import('@/app/api/rules/route');
const { PUT } = await import('@/app/api/rules/[id]/route');

const EXPECTED_ERROR = 'A rule needs a name.';

function baseBody(overrides: Partial<Rule> = {}): Omit<Rule, 'id'> {
  return {
    name: 'name validation test rule ' + Math.random().toString(36).slice(2),
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
  return new Request('http://localhost/api/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function putRequest(body: unknown): Request {
  return new Request('http://localhost/api/rules/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function signInAsEditor(): Promise<void> {
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('POST /api/rules name validation', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsEditor();
  });

  it('returns 400 for an empty body and creates no rule', async () => {
    const before = await loadRules();
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(EXPECTED_ERROR);
    expect((await loadRules()).length).toBe(before.length);
  });

  it('returns 400 when name is a number and creates no rule', async () => {
    const before = await loadRules();
    const res = await POST(postRequest({ ...baseBody(), name: 42 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(EXPECTED_ERROR);
    expect((await loadRules()).length).toBe(before.length);
  });

  it('returns 400 when name is blank after trimming and creates no rule', async () => {
    const before = await loadRules();
    const res = await POST(postRequest({ ...baseBody(), name: '   ' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(EXPECTED_ERROR);
    expect((await loadRules()).length).toBe(before.length);
  });

  it('still creates a rule when name is a real string', async () => {
    const body = baseBody();
    const res = await POST(postRequest(body));
    expect(res.status).toBe(201);
    expect((await loadRules()).some(r => r.name === body.name)).toBe(true);
  });
});

describe('PUT /api/rules/[id] name validation', () => {
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

  it('returns 400 when name is absent and leaves the stored rule unchanged', async () => {
    const before = (await loadRules()).find(r => r.id === customRuleId);
    const { name: _name, ...rest } = baseBody();
    const res = await PUT(
      putRequest({ ...rest, id: customRuleId }),
      { params: Promise.resolve({ id: customRuleId }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(EXPECTED_ERROR);
    expect((await loadRules()).find(r => r.id === customRuleId)).toEqual(before);
  });
});
