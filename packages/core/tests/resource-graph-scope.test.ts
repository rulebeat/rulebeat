/**
 * Spec 004 — Resource Graph request shape.
 *
 * Two documented Azure Resource Graph limits the client silently violated before this spec:
 * management groups and an explicit subscription list cannot be combined in one request, and a
 * request accepts at most 1,000 subscriptions. Both are asserted here against the literal request
 * object handed to the SDK, mocked at the module boundary — the point isn't what rows come back,
 * it's what RuleBeat actually asked Azure for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';

const { resourcesMock } = vi.hoisted(() => ({ resourcesMock: vi.fn() }));

vi.mock('@azure/arm-resourcegraph', () => ({
  // A plain arrow function has no [[Construct]] — `new mockFn()` would throw "is not a
  // constructor" even wrapped in vi.fn(). A function expression does support `new`.
  ResourceGraphClient: vi.fn().mockImplementation(function (this: unknown) {
    return { resources: resourcesMock };
  }),
}));

const { ResourceGraphClient } = await import('../src/clients/resource-graph.js');

const FAKE_CREDENTIAL = {} as TokenCredential;

function subs(n: number, prefix = 'sub'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

beforeEach(() => {
  resourcesMock.mockReset();
  resourcesMock.mockResolvedValue({ data: [], resultTruncated: 'false' });
});

describe('ResourceGraphClient request shape (spec 004)', () => {
  it('never sends subscriptions alongside managementGroups', async () => {
    // Tenant default list is populated (as every real context's is) to prove the client doesn't
    // fall back to it once a management-group scope is given — Azure rejects both together.
    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: subs(3) });

    await client.queryAll('resources', { managementGroups: ['mg-1'] });

    expect(resourcesMock).toHaveBeenCalledTimes(1);
    const request = resourcesMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.managementGroups).toEqual(['mg-1']);
    expect(request.subscriptions).toBeUndefined();
  });

  it('batches an explicit subscription list above 1,000 into multiple requests', async () => {
    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: [] });
    const explicit = subs(1500);

    await client.queryAll('resources', { subscriptions: explicit });

    expect(resourcesMock).toHaveBeenCalledTimes(2);
    const first = resourcesMock.mock.calls[0]![0] as { subscriptions: string[] };
    const second = resourcesMock.mock.calls[1]![0] as { subscriptions: string[] };
    expect(first.subscriptions).toHaveLength(1000);
    expect(second.subscriptions).toHaveLength(500);
    expect([...first.subscriptions, ...second.subscriptions]).toEqual(explicit);
  });

  it('batches the tenant-default subscription list above 1,000 when no scope is given', async () => {
    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: subs(1200) });

    await client.queryAll('resources');

    expect(resourcesMock).toHaveBeenCalledTimes(2);
    const first = resourcesMock.mock.calls[0]![0] as { subscriptions: string[] };
    const second = resourcesMock.mock.calls[1]![0] as { subscriptions: string[] };
    expect(first.subscriptions).toHaveLength(1000);
    expect(second.subscriptions).toHaveLength(200);
  });

  it('sends a single request for a subscription list at or under 1,000', async () => {
    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: subs(1000) });

    await client.queryAll('resources');

    expect(resourcesMock).toHaveBeenCalledTimes(1);
    const request = resourcesMock.mock.calls[0]![0] as { subscriptions: string[] };
    expect(request.subscriptions).toHaveLength(1000);
  });

  it('passes the request timeout as the second positional argument, not nested in the first (spec 007)', async () => {
    // The legacy arm-resourcegraph SDK's .resources() takes transport options (RequestOptionsBase,
    // which has .timeout) as a second argument — Resource Graph's own QueryRequestOptions (the
    // `options` field on the first argument) has no timeout field at all, so nesting it there is a
    // silent no-op that never bounds the call.
    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: subs(3) });

    await client.queryAll('resources');

    expect(resourcesMock).toHaveBeenCalledTimes(1);
    const call = resourcesMock.mock.calls[0]!;
    const firstArg = call[0] as { options?: Record<string, unknown> };
    const secondArg = call[1] as { timeout?: number } | undefined;
    expect(secondArg?.timeout).toEqual(expect.any(Number));
    expect(secondArg?.timeout).toBeGreaterThan(0);
    expect(firstArg.options).not.toHaveProperty('timeout');
  });
});
