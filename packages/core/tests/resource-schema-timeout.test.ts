/**
 * Spec 007 — Resource schema client request timeouts.
 *
 * `getResourceTypeFields()` makes a single ARM call (`providers.get`) and must use the true
 * per-request budget, `AZURE_CALL_TIMEOUT_MS`. `getAllResourceTypes()` drives an SDK pager
 * (`providers.list`) and must use the larger operation-wide budget, `AZURE_LIST_TIMEOUT_MS` — the
 * two are asserted here against the literal options object handed to the SDK so the constants can
 * never be silently swapped between the single-shot and pager call sites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { TenantContext } from '../src/types.js';

const { getMock, listMock } = vi.hoisted(() => ({ getMock: vi.fn(), listMock: vi.fn() }));

vi.mock('@azure/arm-resources', () => ({
  ResourceManagementClient: vi.fn().mockImplementation(function (this: unknown) {
    return { providers: { get: getMock, list: listMock } };
  }),
}));

const { getResourceTypeFields, getAllResourceTypes } = await import('../src/clients/resource-schema.js');
const { AZURE_CALL_TIMEOUT_MS, AZURE_LIST_TIMEOUT_MS } = await import('../src/net/fetch-retry.js');

const FAKE_CREDENTIAL = {} as TokenCredential;

function fakeCtx(): TenantContext {
  return {
    tenantId: 'tenant-1',
    subscriptionIds: ['sub-1'],
    credential: FAKE_CREDENTIAL,
    queryARG: async () => [],
    log: () => {},
  };
}

let timeoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getMock.mockReset();
  listMock.mockReset();
  getMock.mockResolvedValue({ resourceTypes: [] });
  // eslint-disable-next-line @typescript-eslint/require-await
  listMock.mockImplementation(async function* () {});
  // AbortSignal itself doesn't expose the ms it was constructed with, so the only way to prove the
  // *correct* constant reached each call site (not just *some* AbortSignal) is to intercept the
  // call that builds it.
  timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
});

afterEach(() => {
  timeoutSpy.mockRestore();
});

describe('resource-schema request timeouts (spec 007)', () => {
  it('bounds providers.get() with the per-request timeout, not the operation-wide one', async () => {
    await getResourceTypeFields('Microsoft.Compute/virtualMachines', fakeCtx());

    expect(getMock).toHaveBeenCalledTimes(1);
    const options = getMock.mock.calls[0]![1] as { abortSignal?: AbortSignal };
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(AZURE_CALL_TIMEOUT_MS);
    expect(timeoutSpy).not.toHaveBeenCalledWith(AZURE_LIST_TIMEOUT_MS);
  });

  it('bounds providers.list() with the operation-wide timeout, not the per-request one', async () => {
    await getAllResourceTypes(fakeCtx());

    expect(listMock).toHaveBeenCalledTimes(1);
    const options = listMock.mock.calls[0]![0] as { abortSignal?: AbortSignal };
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(AZURE_LIST_TIMEOUT_MS);
    expect(timeoutSpy).not.toHaveBeenCalledWith(AZURE_CALL_TIMEOUT_MS);
  });

  it('uses two distinct constants, sized so the pager budget is larger than the single-call budget', () => {
    expect(AZURE_LIST_TIMEOUT_MS).toBeGreaterThan(AZURE_CALL_TIMEOUT_MS);
  });
});
