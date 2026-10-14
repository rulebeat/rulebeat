/**
 * `createTenantContext(access)` hands out a context already limited to the person (#267), so a
 * route that forgot to narrow still cannot reach outside what they hold. The limit itself is tested
 * in `access-limited-context.test.ts`; this proves the one door every route uses applies it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAccess } from '@/lib/access-model';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { fakeTenantContext, TEST_SUB_A, TEST_SUB_B, TEST_TENANT_ID, type FakeTenantContext } from '../helpers/fake-azure';

const built: FakeTenantContext[] = [];

vi.mock('@rulebeat/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@rulebeat/core')>()),
  buildTenantContext: async () => {
    const fake = fakeTenantContext();
    built.push(fake);
    return fake;
  },
}));

const { createTenantContext } = await import('@/lib/azure-credential');

const ENV = {
  AZURE_TENANT_ID: TEST_TENANT_ID,
  AZURE_CLIENT_ID: '44444444-4444-4444-4444-444444444444',
  AZURE_CLIENT_SECRET: 'not-a-real-secret',
};
let saved: Record<string, string | undefined>;

beforeEach(() => {
  built.length = 0;
  saved = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]));
  Object.assign(process.env, ENV);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('createTenantContext limits the context to the person', () => {
  it('sends Resource Graph only the subscriptions a scoped person holds', async () => {
    const access = buildAccess(
      [{ tenantId: TEST_TENANT_ID, scope: { kind: 'subscription', path: `/subscriptions/${TEST_SUB_A}` }, role: 'viewer' }],
      'manual',
    );
    const ctx = await createTenantContext(access);
    await ctx.queryARG('resources', { subscriptions: [TEST_SUB_A, TEST_SUB_B] });
    expect(built[0]!.queries.map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
    await expect(ctx.graphGet('/applications')).rejects.toThrow();
    expect(built[0]!.graphRequests).toEqual([]);
  });

  it('leaves Everything unlimited', async () => {
    const ctx = await createTenantContext(EVERYTHING_ACCESS);
    await ctx.queryARG('resources', { subscriptions: [TEST_SUB_B] });
    expect(built[0]!.queries.map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_B] }]);
  });
});
