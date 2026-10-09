/**
 * Issue #191: a rule no longer has a Deadline or a Group column. A client that still sends
 * `deadlineField` or `groupField` is treated like any other unknown field, and no response from the
 * rules API ever carries either one back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { SERVICE_RETIREMENTS_RULE_ID } from '../helpers/catalogue';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules } from '@/lib/rules';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('no credential configured')),
}));

const rulesRoute = await import('@/app/api/rules/route');
const ruleRoute = await import('@/app/api/rules/[id]/route');

const json = (method: string, body: unknown) => new Request('http://localhost/api/rules', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const post = (b: unknown) => rulesRoute.POST(json('POST', b));
const put = (id: string, b: unknown) => ruleRoute.PUT(json('PUT', b), { params: Promise.resolve({ id }) });

const REMOVED = { deadlineField: 'retirementDate', groupField: 'retirementFeatureName' };
const NEW_RULE = {
  name: 'Old client rule', description: 'Sent by a client that predates #191.', category: 'reliability',
  severity: 'medium', enabled: true, kind: 'advisory', scope: { level: 'subscription' },
  resourceTypes: [], conditions: [], rawKql: 'resources | project id, name',
};

async function signInAsAdmin(): Promise<void> {
  const result = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

const hasRemoved = (value: unknown) => /deadlineField|groupField/.test(JSON.stringify(value));

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  await signInAsAdmin();
});

describe('a client that still sends deadlineField or groupField', () => {
  it('creates the rule on POST and never sees either field in the response or the list', async () => {
    const res = await post({ ...NEW_RULE, ...REMOVED });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.kind).toBe('advisory');
    expect(hasRemoved(created)).toBe(false);

    const list = await (await rulesRoute.GET()).json();
    expect(hasRemoved(list)).toBe(false);
    expect(hasRemoved(await loadRules())).toBe(false);
  });

  it('edits a custom rule on PUT and never sees either field in the response', async () => {
    const created = await (await post({ ...NEW_RULE, name: 'Old client rule to edit' })).json();
    const res = await put(created.id, { ...created, name: 'Renamed by an old client', ...REMOVED });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe('Renamed by an old client');
    expect(hasRemoved(updated)).toBe(false);
  });

  it('toggles a built-in rule on PUT and never sees either field in the response', async () => {
    const res = await put(SERVICE_RETIREMENTS_RULE_ID, { enabled: false, ...REMOVED });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.enabled).toBe(false);
    expect(hasRemoved(updated)).toBe(false);
  });
});
