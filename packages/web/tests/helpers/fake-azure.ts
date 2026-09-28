/**
 * A fake Azure for tests. The context itself lives in `lib/demo/fake-tenant.ts` because the Demo
 * generator ships in the image and builds on it; this file adds the fixed ids and row builders
 * only tests use.
 *
 * Deliberately not a mocking-library mock. It returns real rows through the real code path, so a
 * test failure means the scan logic is wrong, not that a mock's expectations drifted.
 */
import { fakeTenantContext as baseFakeTenantContext, type FakeOptions, type FakeTenantContext } from '@/lib/demo/fake-tenant';

export type { FakeTenantContext, RecordedQuery } from '@/lib/demo/fake-tenant';

export const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const TEST_SUB_A = '11111111-1111-1111-1111-111111111111';
export const TEST_SUB_B = '22222222-2222-2222-2222-222222222222';

export function fakeTenantContext(opts: FakeOptions = {}): FakeTenantContext {
  return baseFakeTenantContext({ tenantId: TEST_TENANT_ID, subscriptionIds: [TEST_SUB_A], ...opts });
}

/** A realistic ARG row for a VM, so tests aren't asserting against invented shapes. */
export function argRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const name = String(overrides.name ?? 'vm-test-01');
  const sub = String(overrides.subscriptionId ?? TEST_SUB_A);
  const rg = String(overrides.resourceGroup ?? 'rg-test');
  return {
    id: `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}`,
    name,
    type: 'microsoft.compute/virtualmachines',
    location: 'westeurope',
    resourceGroup: rg,
    subscriptionId: sub,
    ...overrides,
  };
}
