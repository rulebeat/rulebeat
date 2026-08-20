/**
 * Spec 007 — the two raw fetch probes in this app (the Graph reachability check inside
 * runPreflight, and the Entra OIDC discovery probe) now go through fetchWithRetry() instead of a
 * bare fetch, so a transient 503 from either endpoint is retried instead of surfacing immediately
 * as unreachable.
 *
 * Follows the fake-timer pattern from tests/unit/notification-dispatch-retry.test.ts.
 * `fakeTenantContext()`'s credential deliberately throws if used for real (tests/helpers/
 * fake-azure.ts), so this suite makes zero live Azure or Graph calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeTenantContext } from '../helpers/fake-azure';
import { runPreflight } from '@/lib/preflight';
import { probeTenant } from '@/lib/sign-in-config';

function fakeResponse(status: number, body = '{}'): Response {
  return new Response(body, { status });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('probe retries (spec 007)', () => {
  it('runPreflight retries a transient Graph 503 and still reports the check ok', async () => {
    vi.useFakeTimers();
    const ctx = fakeTenantContext({
      subscriptionIds: ['sub-a'],
      rows: [{ subscriptionId: 'sub-a', name: 'Sub A' }],
    });
    const getToken = vi.fn(async () => 'fake-token');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(200));

    const promise = runPreflight({ ctx, getToken, fetchImpl, clientId: 'client-1' });
    await vi.advanceTimersByTimeAsync(2_000); // backoff before attempt 2
    const result = await promise;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const graphCheck = result.checks.find(c => c.id === 'graph-applications')!;
    expect(graphCheck.status).toBe('ok');
  });

  it('probeTenant retries a transient 503 and reports the tenant reachable', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const promise = probeTenant('11111111-1111-1111-1111-111111111111');
    await vi.advanceTimersByTimeAsync(2_000); // backoff before attempt 2
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('probeTenant does not retry a non-transient failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse(400));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeTenant('11111111-1111-1111-1111-111111111111');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});
