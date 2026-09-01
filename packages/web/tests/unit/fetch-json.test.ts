/**
 * Spec 010 — fetchJson() returns a FetchResult<T> discriminated union instead of collapsing every
 * failure into `null`, so callers can tell "fetch failed" apart from "fetch succeeded, empty body".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '@/lib/fetch-json';

function fakeResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

afterEach(async () => {
  vi.unstubAllGlobals();
});

describe('fetchJson', () => {
  it('returns { ok: true, data } on a 200 with a valid JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(200, '{"a":1}')));

    const result = await fetchJson<{ a: number }>('/api/thing');

    expect(result).toEqual({ ok: true, data: { a: 1 } });
  });

  it.each([401, 403, 500])('returns { ok: false } on a %d response', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(status, '{}')));

    const result = await fetchJson('/api/thing');

    expect(result).toEqual({ ok: false });
  });

  it('returns { ok: false } when the response body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(200, 'not json')));

    const result = await fetchJson('/api/thing');

    expect(result).toEqual({ ok: false });
  });

  it('returns { ok: false } when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await fetchJson('/api/thing');

    expect(result).toEqual({ ok: false });
  });

  it('returns { ok: false } when the passed signal is already aborted', async () => {
    // A real fetch rejects immediately when handed an already-aborted signal — the fake here
    // mirrors that contract rather than exercising the platform's own abort machinery.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError')));

    const controller = new AbortController();
    controller.abort();
    const result = await fetchJson('/api/thing', { signal: controller.signal });

    expect(result).toEqual({ ok: false });
  });
});
