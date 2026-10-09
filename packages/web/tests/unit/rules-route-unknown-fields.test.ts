/**
 * POST /api/rules answers with the rule as it was stored, not the request echoed back. A field the
 * rules table has no column for is dropped on the way in, so the response must not carry it either;
 * a client that trusted the echo would believe the server kept something it never did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRule } from '@/lib/rules';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('no credential configured')),
}));

const rulesRoute = await import('@/app/api/rules/route');

const post = (body: unknown) => rulesRoute.POST(new Request('http://localhost/api/rules', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

const NEW_RULE = {
  name: 'Rule with extras', description: 'Sent with fields the server does not keep.', category: 'reliability',
  severity: 'medium', enabled: true, scope: { level: 'subscription' },
  resourceTypes: [], conditions: [], rawKql: 'resources | project id, name',
};

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  const result = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
});

describe('POST /api/rules and a field it does not store', () => {
  it('answers with the rule as stored, without the unknown field', async () => {
    const res = await post({ ...NEW_RULE, notARuleField: 'kept?', lastRunStatus: 'success' });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).not.toHaveProperty('notARuleField');
    expect(created.lastRunStatus).toBeUndefined();
    expect(created).toEqual(JSON.parse(JSON.stringify(await loadRule(created.id))));
  });
});
