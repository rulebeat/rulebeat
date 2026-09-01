/**
 * Spec 031 — POST /api/rules and PUT /api/rules/[id] must derive `shape` from the request's own
 * `appliesTo` (never trust a client-sent shape — see deriveShape()'s comment in lib/rules.ts) and
 * must reject an Applies-to block with no compilable filter, the same way RB-RM-004 already guards
 * an empty visualQuery — see route.ts's own comments next to each check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, clearRules } from '../helpers/db';
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

// Same minimal-but-real stage-based VisualQuery shape used in rules-taxonomy-roundtrip.test.ts and
// core's runner-outcomes.test.ts.
const appliesTo: VisualQuery = {
  stages: [{
    id: 'f1',
    type: 'filter',
    groups: [{ id: 'g1', conditions: [{ id: 'c1', field: 'name', operator: 'exists' }] }],
  }],
};

// A stages array present but with nothing that compiles to a filter — hasCompilableFilter() is
// false for this on both the visualQuery and appliesTo guards, since .some() on [] is false.
const emptyAppliesTo: VisualQuery = { stages: [] };

function baseBody(overrides: Partial<Rule> = {}): Omit<Rule, 'id'> {
  return {
    name: 'applies-to test rule ' + Math.random().toString(36).slice(2),
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

describe('POST /api/rules — Applies-to shape derivation and guard (spec 031)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsEditor();
  });

  it('saves a rule with no appliesTo as shape detect', async () => {
    const res = await POST(postRequest(baseBody()));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.shape).toBe('detect');
    expect(json.appliesTo).toBeUndefined();
  });

  it('saves a rule with a compilable appliesTo as shape assert', async () => {
    const res = await POST(postRequest(baseBody({ appliesTo })));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.shape).toBe('assert');
    expect(json.appliesTo).toEqual(appliesTo);
    expect((await loadRules()).find(r => r.id === json.id)?.shape).toBe('assert');
  });

  it('ignores a forged shape on the request body and derives it from appliesTo instead', async () => {
    const res = await POST(postRequest(baseBody({ appliesTo, shape: 'detect' })));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.shape).toBe('assert');
  });

  it('rejects an appliesTo with no compilable filter and does not persist the rule', async () => {
    const before = (await loadRules()).length;
    const res = await POST(postRequest(baseBody({ appliesTo: emptyAppliesTo })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Applies-to/);
    expect((await loadRules()).length).toBe(before);
  });
});

describe('PUT /api/rules/[id] — Applies-to shape derivation and guard (spec 031)', () => {
  let detectRuleId: string;
  let assertRuleId: string;

  beforeEach(async () => {
    await resetDb();
    // await resetDb() deliberately preserves the seeded rules baseline (see its own comment) — clear it
    // outright so this file's fixed-name fixtures below can never collide with a prior test's rows
    // or with a seeded built-in, across runs within this describe block.
    await clearRules();
    mockAuth.mockReset();
    await signInAsEditor();

    detectRuleId = globalThis.crypto.randomUUID();
    assertRuleId = globalThis.crypto.randomUUID();
    await saveRules([
      { ...baseBody({ name: 'existing detect rule' }), id: detectRuleId },
      { ...baseBody({ name: 'existing assert rule', appliesTo }), id: assertRuleId },
    ]);
  });

  it('flips shape from detect to assert when an edit adds appliesTo', async () => {
    expect((await loadRules()).find(r => r.id === detectRuleId)?.shape).toBe('detect');
    const res = await PUT(
      putRequest({ ...baseBody({ name: 'existing detect rule', appliesTo }), id: detectRuleId }),
      { params: Promise.resolve({ id: detectRuleId }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.shape).toBe('assert');
    expect((await loadRules()).find(r => r.id === detectRuleId)?.shape).toBe('assert');
  });

  it('flips shape from assert back to detect when an edit removes appliesTo', async () => {
    expect((await loadRules()).find(r => r.id === assertRuleId)?.shape).toBe('assert');
    const res = await PUT(
      putRequest({ ...baseBody({ name: 'existing assert rule' }), id: assertRuleId }),
      { params: Promise.resolve({ id: assertRuleId }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.shape).toBe('detect');
    expect(json.appliesTo).toBeUndefined();
    expect((await loadRules()).find(r => r.id === assertRuleId)?.shape).toBe('detect');
  });

  it('rejects an edit whose new appliesTo has no compilable filter, leaving the stored rule untouched', async () => {
    const res = await PUT(
      putRequest({ ...baseBody({ name: 'existing detect rule', appliesTo: emptyAppliesTo }), id: detectRuleId }),
      { params: Promise.resolve({ id: detectRuleId }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Applies-to/);
    expect((await loadRules()).find(r => r.id === detectRuleId)?.shape).toBe('detect');
    expect((await loadRules()).find(r => r.id === detectRuleId)?.appliesTo).toBeUndefined();
  });
});
