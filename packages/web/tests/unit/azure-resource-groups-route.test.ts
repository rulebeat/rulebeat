/**
 * #272: GET /api/azure/subscriptions/[id]/resource-groups, the list the Access page's Scope picker offers
 * under a subscription. Admin-only, over the fake Azure of tests/helpers/fake-azure.ts: no live call. The
 * subscription is the query's scope and never part of its KQL, and no raw Azure error reaches the browser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { fakeTenantContext, TEST_SUB_A } from '../helpers/fake-azure';
import type { FakeTenantContext } from '../helpers/fake-azure';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import type { Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fakeCtx: FakeTenantContext | null;
let connectError: Error | null;
vi.mock('@/lib/azure-credential', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure-credential')>('@/lib/azure-credential');
  return {
    ...actual,
    createTenantContext: () => connectError ? Promise.reject(connectError) : Promise.resolve(fakeCtx),
  };
});

const { GET } = await import('@/app/api/azure/subscriptions/[id]/resource-groups/route');

const call = (id: string) => GET(new Request(`http://localhost/api/azure/subscriptions/${id}/resource-groups`), { params: Promise.resolve({ id }) });

async function signInAs(role: Role): Promise<void> {
  const result = await createUser({ email: `${role}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  connectError = null;
  fakeCtx = null;
});

describe('GET /api/azure/subscriptions/[id]/resource-groups', () => {
  it('lists the resource groups of the subscription, sorted, scoped to that subscription alone', async () => {
    await signInAs('admin');
    fakeCtx = fakeTenantContext({ rows: [{ name: 'rg-b' }, { name: 'rg-a' }, { name: '' }, { id: 'no-name' }] });
    const res = await call(TEST_SUB_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resourceGroups: ['rg-a', 'rg-b'] });
    expect(fakeCtx.queries).toHaveLength(1);
    expect(fakeCtx.queries[0]!.scope).toEqual({ subscriptions: [TEST_SUB_A] });
    expect(fakeCtx.queries[0]!.kql).not.toContain(TEST_SUB_A);
  });

  it.each(['viewer', 'editor'] as const)('refuses a %s with a 403 and asks Azure nothing', async (role) => {
    await signInAs(role);
    fakeCtx = fakeTenantContext({ rows: [{ name: 'rg-a' }] });
    expect((await call(TEST_SUB_A)).status).toBe(403);
    expect(fakeCtx.queries).toEqual([]);
  });

  it('answers 401 with no session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await call(TEST_SUB_A)).status).toBe(401);
  });

  it('refuses an id that is not a subscription id, before any Azure call', async () => {
    await signInAs('admin');
    fakeCtx = fakeTenantContext({ rows: [] });
    for (const id of ['x', "1' | take 1000 //", '..%2F..']) {
      expect((await call(id)).status, id).toBe(400);
    }
    expect(fakeCtx.queries).toEqual([]);
  });

  it('answers 503 naming the missing credential when Azure has never been configured', async () => {
    await signInAs('admin');
    connectError = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
    const res = await call(TEST_SUB_A);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('azure_not_configured');
  });

  it('never returns a raw Azure error: a failed connection or a failed query is a stable message', async () => {
    await signInAs('admin');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const leak = 'AuthorizationFailed: client 00000000-aaaa-bbbb-cccc-000000000000 over /subscriptions/secret-sub';

    connectError = new Error(leak);
    const connect = await call(TEST_SUB_A);
    expect(connect.status).toBe(500);

    connectError = null;
    fakeCtx = fakeTenantContext({ failWith: new Error(leak) });
    const query = await call(TEST_SUB_A);
    expect(query.status).toBe(500);

    for (const res of [connect, query]) {
      const text = JSON.stringify(await res.json());
      expect(text).not.toMatch(/AuthorizationFailed|00000000|secret-sub/);
      expect(text).toContain('Check the RuleBeat server logs');
    }
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });
});
