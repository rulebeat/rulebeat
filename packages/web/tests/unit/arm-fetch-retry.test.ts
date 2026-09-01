/**
 * Spec 007 — armFetch() now goes through fetchWithRetry() instead of a bare fetch, so a transient
 * ARM failure (503) is retried rather than surfacing immediately as an error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { armFetch } from '@/lib/arm';

function fakeResponse(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null } as unknown as Headers,
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
  } as Response;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('armFetch retry (spec 007)', () => {
  it('retries a transient 503 then returns the parsed body on success', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(503, 'unavailable'))
      .mockResolvedValueOnce(fakeResponse(200, '{"value":"ok"}'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = armFetch<{ value: string }>('https://management.azure.com/x', 'token-1');
    await vi.advanceTimersByTimeAsync(2_000); // backoff before attempt 2
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ value: 'ok' });
  });

  it('does not retry a non-transient error, and throws with the status', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse(404, 'not found'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(armFetch('https://management.azure.com/x', 'token-1')).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
