/**
 * Issue #142: two rule writes in flight at once must both land, and a scan's run status written
 * while a save is in flight must survive it.
 *
 * The interleaving is made deterministic through the one slow step a rule save has: the identity
 * probe, which asks Azure for a tenant context after the route has read the rules and before it
 * writes. The mocked `createTenantContext` (Azure is the system boundary here) parks on a gate the
 * test controls and then fails, which the route treats as "no credential configured, allow save".
 * Everything else is the real route, repository and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, setRulesLastRunStatus } from '@/lib/rules';
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

// Rules survive resetDb(), so each test needs names no earlier test has stored.
const uniq = (label: string) => label + ' ' + Math.random().toString(36).slice(2);

const KQL = 'resources | where type == "microsoft.compute/virtualmachines"';

function body(overrides: Partial<Rule> = {}): Omit<Rule, 'id'> {
  return {
    name: 'concurrent write test ' + Math.random().toString(36).slice(2),
    description: 'a test rule',
    category: 'security',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: ['microsoft.compute/virtualmachines'],
    conditions: [],
    ...overrides,
  };
}

function req(method: 'POST' | 'PUT', payload: unknown): Request {
  return new Request('http://localhost/api/rules', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function createViaRoute(overrides: Partial<Rule> = {}): Promise<Rule> {
  const res = await POST(req('POST', body(overrides)));
  expect(res.status).toBe(201);
  return await res.json() as Rule;
}

function put(id: string, payload: Omit<Rule, 'id'>): Promise<Response> {
  return PUT(req('PUT', payload), { params: Promise.resolve({ id }) });
}

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

describe('concurrent rule writes through the routes', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    gate.open = Promise.resolve();
    const result = await createUser({ email: 'editor@example.com', role: 'editor' });
    if ('error' in result) throw new Error(result.error);
    await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  });

  it('keeps both of two edits made to different rules at the same time', async () => {
    const a = await createViaRoute();
    const b = await createViaRoute();

    const nameA = uniq('edited A');
    const nameB = uniq('edited B');
    const release = closeGate();
    const first = put(a.id, body({ name: nameA, rawKql: KQL, description: 'A was edited' }));
    const second = put(b.id, body({ name: nameB, rawKql: KQL, description: 'B was edited' }));
    await untilParked(2);
    release();
    const [resA, resB] = await Promise.all([first, second]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const rules = await loadRules();
    expect(rules.find(r => r.id === a.id)).toMatchObject({ name: nameA, description: 'A was edited' });
    expect(rules.find(r => r.id === b.id)).toMatchObject({ name: nameB, description: 'B was edited' });
  });

  it('keeps a rule created while another rule is being edited', async () => {
    const a = await createViaRoute();

    const release = closeGate();
    const editedName = uniq('edited A');
    const midEditName = uniq('created mid-edit');
    const edit = put(a.id, body({ name: editedName, rawKql: KQL }));
    await untilParked(1);
    const created = await createViaRoute({ name: midEditName });
    release();
    expect((await edit).status).toBe(200);

    const names = (await loadRules()).map(r => r.name);
    expect(names).toContain(midEditName);
    expect(names).toContain(editedName);
    expect((await loadRules()).some(r => r.id === created.id)).toBe(true);
  });

  it("keeps a scan's run status written while a save is in flight, for the saved rule and its neighbours", async () => {
    const edited = await createViaRoute();
    const neighbour = await createViaRoute();

    const release = closeGate();
    const editedName = uniq('edited during scan');
    const edit = put(edited.id, body({ name: editedName, rawKql: KQL }));
    await untilParked(1);
    // The scan finishes while the save is parked between its read and its write.
    await setRulesLastRunStatus([edited.id, neighbour.id], 'success', '2026-05-01T00:00:00.000Z');
    release();
    expect((await edit).status).toBe(200);

    const rules = await loadRules();
    for (const id of [edited.id, neighbour.id]) {
      expect(rules.find(r => r.id === id)).toMatchObject({
        lastRunStatus: 'success',
        lastRunAt: '2026-05-01T00:00:00.000Z',
      });
    }
    expect(rules.find(r => r.id === edited.id)?.name).toBe(editedName);
  });
});
