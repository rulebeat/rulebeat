/**
 * Issue #158: two rules could end up with the same name when created or renamed at the same
 * moment. `isNameTaken()` used to load every rule and compare in a step separate from the write,
 * so two concurrent requests could both pass the check before either wrote its row.
 *
 * The interleaving is made deterministic the same way rules-route-concurrent-writes.test.ts does
 * it: the identity probe asks Azure for a tenant context after the route has read the rules and
 * before it writes, and the mocked `createTenantContext` (Azure is the system boundary here) parks
 * on a gate the test controls, then fails, which the route treats as "no credential configured,
 * allow save". Everything else is the real route, repository and database, so the name check and
 * the write really do race through `createRule`/`updateRule`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, saveRules } from '@/lib/rules';
import type { Rule } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const gate = vi.hoisted(() => ({ open: Promise.resolve(), parked: 0 }));
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: async () => {
    gate.parked++;
    await gate.open;
    throw new Error('not configured in this test file');
  },
}));

const { POST } = await import('@/app/api/rules/route');
const { PUT } = await import('@/app/api/rules/[id]/route');

const KQL = 'resources | where type == "microsoft.compute/virtualmachines"';

function body(overrides: Partial<Rule> = {}): Omit<Rule, 'id'> {
  return {
    name: 'name race test ' + Math.random().toString(36).slice(2),
    description: 'a test rule',
    category: 'security',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: ['microsoft.compute/virtualmachines'],
    conditions: [],
    rawKql: KQL,
    ...overrides,
  };
}

function postReq(payload: unknown): Request {
  return new Request('http://localhost/api/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function post(payload: unknown): Promise<Response> {
  return POST(postReq(payload));
}

function put(id: string, payload: unknown): Promise<Response> {
  return PUT(
    new Request('http://localhost/api/rules/x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const TAKEN_MESSAGE = (name: string) => `A rule named "${name}" already exists. Rule names must be unique.`;

/** Closes the gate and returns a function that opens it. */
function closeGate(): () => void {
  gate.parked = 0;
  let open!: () => void;
  gate.open = new Promise<void>(resolve => { open = resolve; });
  return open;
}

/** Waits until `n` requests are parked inside the probe, i.e. have read the rules but not written. */
async function untilParked(n: number): Promise<void> {
  for (let i = 0; i < 200 && gate.parked < n; i++) await new Promise(r => setTimeout(r, 5));
  expect(gate.parked).toBe(n);
}

describe('rule name uniqueness under concurrent writes', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    gate.open = Promise.resolve();
    const result = await createUser({ email: 'editor@example.com', role: 'editor' });
    if ('error' in result) throw new Error(result.error);
    await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  });

  it('lets exactly one of two concurrent creates with the same name (different case) through', async () => {
    const name = 'Race Rule ' + Math.random().toString(36).slice(2);

    const release = closeGate();
    const first = post(body({ name }));
    const second = post(body({ name: name.toUpperCase() }));
    await untilParked(2);
    release();
    const [resA, resB] = await Promise.all([first, second]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);
    const aFailed = resA.status === 409;
    const failed = aFailed ? resA : resB;
    const failedName = aFailed ? name : name.toUpperCase();
    expect((await failed.json()).error).toBe(TAKEN_MESSAGE(failedName));

    const matching = (await loadRules()).filter(r => r.name.trim().toLowerCase() === name.trim().toLowerCase());
    expect(matching).toHaveLength(1);
  });

  it('lets exactly one of a rename and a concurrent create to the same name through', async () => {
    const postRes = await post(body());
    expect(postRes.status).toBe(201);
    const existing = await postRes.json() as Rule;

    const sharedName = 'Shared Name ' + Math.random().toString(36).slice(2);

    const release = closeGate();
    const rename = put(existing.id, body({ name: sharedName }));
    const create = post(body({ name: sharedName.toUpperCase() }));
    await untilParked(2);
    release();
    const [renameRes, createRes] = await Promise.all([rename, create]);

    // The race can go either way: the rename can win (200) and the create loses (409), or the
    // create can win (201) and the rename loses (409). Either is correct; both winning, or both
    // losing, is the bug.
    const renameWon = renameRes.status === 200 && createRes.status === 409;
    const createWon = createRes.status === 201 && renameRes.status === 409;
    expect(renameWon || createWon).toBe(true);

    const matching = (await loadRules()).filter(r => r.name.trim().toLowerCase() === sharedName.trim().toLowerCase());
    expect(matching).toHaveLength(1);
  });

  it('lets an edit that keeps an existing duplicate pair\'s name unchanged succeed', async () => {
    const sharedName = 'Pre-existing Duplicate ' + Math.random().toString(36).slice(2);
    const first: Rule = { ...body({ name: sharedName }), id: globalThis.crypto.randomUUID() };
    const second: Rule = { ...body({ name: sharedName.toUpperCase() }), id: globalThis.crypto.randomUUID() };
    await saveRules([...(await loadRules()).filter(r => r.type === 'builtin'), first, second]);

    const res = await put(first.id, { ...first, description: 'edited without renaming' });

    expect(res.status).toBe(200);
    const updated = (await loadRules()).find(r => r.id === first.id);
    expect(updated?.description).toBe('edited without renaming');
    expect(updated?.name).toBe(sharedName);
  });
});
