/**
 * Spec 007 — fetchWithRetry: shared timeout/retry wrapper for the codebase's raw fetch call sites.
 *
 * Fake-timer tests follow the same pattern as
 * packages/web/tests/unit/notification-dispatch-retry.test.ts (vi.useFakeTimers() +
 * vi.stubGlobal('fetch', ...) + vi.advanceTimersByTimeAsync()). The hanging-response timeout test
 * deliberately runs under REAL timers instead — AbortSignal.timeout()'s internal scheduling is not
 * guaranteed to be intercepted by vi.useFakeTimers(), so faking time there would make the test's
 * pass/fail depend on an implementation detail of the timer-faking library rather than of the code
 * under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../src/net/fetch-retry.js';

function fakeResponse(status: number, headers: Record<string, string> = {}): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null } as unknown as Headers,
  } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchWithRetry (spec 007)', () => {
  it('retries a thrown network error, then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.test/x');
    await vi.advanceTimersByTimeAsync(2_000); // default backoff before attempt 2
    const res = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('honors a numeric Retry-After header instead of the default backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(429, { 'retry-after': '5' }))
      .mockResolvedValueOnce(fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.test/x');

    // The default backoff (2s) alone must not be enough — the header asked for 5s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    const res = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('does not retry a non-transient status', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeResponse(404));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('https://example.test/x');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
  });

  it('gives up after the fixed attempt count and returns the last transient response', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithRetry('https://example.test/x');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    const res = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(503);
  });

  it('rejects once the per-attempt timeout elapses, rather than hanging forever', async () => {
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });

    await expect(
      fetchWithRetry('https://example.test/x', {}, { timeoutMs: 50, maxAttempts: 1, fetchImpl: hangingFetch }),
    ).rejects.toThrow(/abort/i);
  }, 2_000);
});
