/**
 * Codex review Phase 5, item 5: Microsoft Graph pagination at the transport boundary.
 *
 * `graphGetAll()` (packages/core/src/auth/index.ts) is `TenantContext.graphGet`'s real
 * implementation for a live Azure connection. `identity-graph-seam.test.ts` proves
 * `collectIdentityFindings()` against a *fake* `graphGet` and never runs this function at all, so
 * the actual pagination loop — following `@odata.nextLink` until it's absent, merging every page's
 * `value` array — had no test at any boundary. This suite mocks global `fetch` directly (the same
 * pattern `fetch-retry.test.ts` uses) and proves that loop, with no network involved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import { buildTenantContext, GRAPH_MAX_ROWS, GraphTruncatedError } from '../src/auth/index.js';

function fakeCredential(token: string | null = 'fake-token'): TokenCredential {
  return {
    getToken: vi.fn().mockResolvedValue(token ? { token, expiresOnTimestamp: Date.now() + 3_600_000 } : null),
  } as unknown as TokenCredential;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// subscriptionIds is passed explicitly so buildTenantContext() never reaches
// listAccessibleSubscriptions()'s real SubscriptionClient call — this suite is only about graphGet.
function graphCtx(credential: TokenCredential = fakeCredential()) {
  return buildTenantContext({ tenantId: 'tenant-1', subscriptionIds: ['sub-1'], credential });
}

describe('TenantContext.graphGet — graphGetAll() pagination (packages/core/src/auth/index.ts)', () => {
  it('returns a single page verbatim when there is no @odata.nextLink', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { value: [{ id: 'a' }, { id: 'b' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = await graphCtx();
    const rows = await ctx.graphGet!<{ id: string }>('/applications');

    expect(rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows @odata.nextLink until exhausted and merges every page in order', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        value: [{ id: 'a' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/applications?$skiptoken=p2',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        value: [{ id: 'b' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/applications?$skiptoken=p3',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { value: [{ id: 'c' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = await graphCtx();
    const rows = await ctx.graphGet!<{ id: string }>('/applications');

    expect(rows).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The second and third calls hit the exact nextLink URL Graph handed back, not a re-derived one.
    expect(fetchMock.mock.calls[1]![0]).toBe('https://graph.microsoft.com/v1.0/applications?$skiptoken=p2');
    expect(fetchMock.mock.calls[2]![0]).toBe('https://graph.microsoft.com/v1.0/applications?$skiptoken=p3');
  });

  it('sends a bearer token from the given credential against the v1.0 base URL for a relative path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { value: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = await graphCtx(fakeCredential('my-token'));
    await ctx.graphGet!('/applications?$top=999');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://graph.microsoft.com/v1.0/applications?$top=999');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer my-token' });
  });

  it('throws a clear error on a non-ok response instead of returning a silently partial result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { error: { message: 'Insufficient privileges' } }));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = await graphCtx();
    await expect(ctx.graphGet!('/applications')).rejects.toThrow(/Graph API 403/);
  });

  it('throws when no token can be acquired, rather than calling Graph unauthenticated', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const ctx = await graphCtx(fakeCredential(null));
    await expect(ctx.graphGet!('/applications')).rejects.toThrow(/Could not acquire a Microsoft Graph token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws GraphTruncatedError once the accumulated result crosses GRAPH_MAX_ROWS while more pages remain', async () => {
    const overCap = Array.from({ length: GRAPH_MAX_ROWS + 1 }, (_, i) => ({ id: String(i) }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      value: overCap,
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/applications?$skiptoken=p2',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = await graphCtx();
    const err = await ctx.graphGet!('/applications').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphTruncatedError);
    expect((err as InstanceType<typeof GraphTruncatedError>).rowsSeen).toBe(GRAPH_MAX_ROWS + 1);
    // The cap check fires as soon as the running total crosses it — no second page is ever fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the page that crosses GRAPH_MAX_ROWS is genuinely the last one', async () => {
    const overCap = Array.from({ length: GRAPH_MAX_ROWS + 1 }, (_, i) => ({ id: String(i) }));
    // No @odata.nextLink on this page — the result set is complete, just large.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { value: overCap }));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = await graphCtx();
    const rows = await ctx.graphGet!<{ id: string }>('/applications');

    expect(rows).toHaveLength(GRAPH_MAX_ROWS + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
