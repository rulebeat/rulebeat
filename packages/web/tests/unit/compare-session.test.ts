/**
 * ADR 0008: what the compare screen holds in place of two scans' findings, read against a stubbed `fetch`.
 * Choosing a side reads once, the request is the address's query, an answer that arrives after a newer
 * request is dropped, and each way the read can go wrong is a state of its own that says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '@/lib/explorer-session';
import { CompareFeed } from '@/lib/compare-session';
import { COMPARE_ERRORS, type CompareResponse } from '@/lib/compare-response';
import { compareQueryToParams, emptyCompareQuery, type CompareQuery } from '@/lib/compare-query';
import { compareUrl, switchedCompareQuery, type CompareIds } from '@/lib/compare-screen';

const IDS: CompareIds = ['run-1', 'run-2'];
const response = (over: Partial<CompareResponse> = {}): CompareResponse => ({
  older: { id: 'run-1', category: 'compute', startedAt: '2026-01-01T00:00:00.000Z' },
  newer: { id: 'run-2', category: 'compute', startedAt: '2026-01-02T00:00:00.000Z' },
  side: 'added', totals: { added: 0, fixed: 0, persisted: 0 }, page: 1, pageCount: 1, pageSize: 50, items: [], ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const query = (over: Partial<CompareQuery> = {}): CompareQuery => ({ ...emptyCompareQuery(), ...over });

const gate = () => {
  let release!: (res: Response) => void;
  const promise = new Promise<Response>(resolve => { release = resolve; });
  return { promise, release };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Lets the read the feed started settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('the compare feed', () => {
  it('reads the Added side once, and holds what came back', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response({ totals: { added: 3, fixed: 1, persisted: 2 } })));
    const feed = new CompareFeed(fetchFn);
    expect(feed.getSnapshot().status).toBe('loading');
    feed.request(IDS, query());
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/scans/compare?compare=run-1..run-2');
    const state = feed.getSnapshot();
    expect(state.status === 'ready' && state.data.totals.added).toBe(3);
  });

  it('reads once when a side is chosen, and the request carries exactly the address\'s query', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    const feed = new CompareFeed(fetchFn);
    feed.request(IDS, query({ side: 'added', page: 3 }));
    await settle();
    const next = switchedCompareQuery(query({ side: 'added', page: 3 }), 'fixed');
    expect(next).toEqual({ side: 'fixed', page: 1 });
    feed.request(IDS, next);
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const url = fetchFn.mock.calls[1]![0] as string;
    expect(url).toBe(compareUrl(IDS, next));
    expect(url).toBe('/api/scans/compare?compare=run-1..run-2&compareSide=fixed');
    expect(new URL(url, 'http://localhost').searchParams.toString())
      .toBe(compareQueryToParams(next, new URLSearchParams({ compare: 'run-1..run-2' })).toString());
  });

  it('does not read again for the request it already holds or is reading', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    const feed = new CompareFeed(fetchFn);
    feed.request(IDS, query({ page: 2 }));
    feed.request(IDS, query({ page: 2 }));
    await settle();
    feed.request(IDS, query({ page: 2 }));
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reads again for other scans, at once', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    const feed = new CompareFeed(fetchFn);
    feed.request(IDS, query());
    await settle();
    feed.request(['run-1', 'run-3'], query());
    await settle();
    expect(fetchFn.mock.calls.map(c => c[0])).toEqual([
      '/api/scans/compare?compare=run-1..run-2',
      '/api/scans/compare?compare=run-1..run-3',
    ]);
  });

  it('drops an answer that arrives after a newer request was made', async () => {
    const slow = gate();
    const fetchFn = vi.fn<FetchFn>()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(async () => json(response({ side: 'fixed', totals: { added: 0, fixed: 2, persisted: 0 } })));
    const feed = new CompareFeed(fetchFn);
    feed.request(IDS, query());
    feed.request(IDS, query({ side: 'fixed' }));
    await settle();
    slow.release(json(response({ totals: { added: 99, fixed: 0, persisted: 0 } })));
    await settle();
    const state = feed.getSnapshot();
    expect(state.status === 'ready' && state.data.side).toBe('fixed');
    expect(state.status === 'ready' && state.data.totals.fixed).toBe(2);
  });

  it('keeps the last answer on screen while the next is on its way', async () => {
    const next = gate();
    const fetchFn = vi.fn<FetchFn>()
      .mockImplementationOnce(async () => json(response({ totals: { added: 5, fixed: 0, persisted: 0 } })))
      .mockImplementationOnce(() => next.promise);
    const feed = new CompareFeed(fetchFn);
    feed.request(IDS, query());
    await settle();
    feed.request(IDS, query({ page: 2 }));
    const state = feed.getSnapshot();
    expect(state.status).toBe('loading');
    expect(state.status === 'loading' && state.stale?.totals.added).toBe(5);
    next.release(json(response()));
    await settle();
  });

  describe('a read that does not give a list', () => {
    it.each(['not-found', 'no-records', 'different-categories', 'bad-request'] as const)('is the server\'s own %s, in its own words', async code => {
      const { status, body } = COMPARE_ERRORS[code];
      const feed = new CompareFeed(async () => json(body, status));
      feed.request(IDS, query());
      await settle();
      const state = feed.getSnapshot();
      expect(state.status).toBe(code);
      expect('message' in state && state.message).toBe(body.error);
    });

    it('is a failed read for a server error, saying it could not load', async () => {
      const feed = new CompareFeed(async () => json({ error: 'Could not compare these runs.' }, 500));
      feed.request(IDS, query());
      await settle();
      const state = feed.getSnapshot();
      expect(state.status).toBe('failed');
      expect(state.status === 'failed' && state.message).toBe('Could not compare these runs.');
    });

    it('is a failed read, not a refusal, for a 404 or a 409 that is not the compare\'s own', async () => {
      for (const status of [404, 409, 400]) {
        const feed = new CompareFeed(async () => json({ error: 'Something else' }, status));
        feed.request(IDS, query());
        await settle();
        expect(feed.getSnapshot().status).toBe('failed');
      }
    });

    it('is a failed read when the request never reaches the server, and keeps the last answer', async () => {
      const fetchFn = vi.fn<FetchFn>()
        .mockImplementationOnce(async () => json(response({ totals: { added: 7, fixed: 0, persisted: 0 } })))
        .mockImplementationOnce(async () => { throw new TypeError('network down'); });
      const feed = new CompareFeed(fetchFn);
      feed.request(IDS, query());
      await settle();
      feed.request(IDS, query({ side: 'fixed' }));
      await settle();
      const state = feed.getSnapshot();
      expect(state.status).toBe('failed');
      expect(state.status === 'failed' && state.message).toMatch(/^Could not load the findings of this compare\. /);
      expect(state.status === 'failed' && state.stale?.totals.added).toBe(7);
    });

    it('lets the next request replace a failure', async () => {
      const fetchFn = vi.fn<FetchFn>()
        .mockImplementationOnce(async () => json({ error: 'boom' }, 500))
        .mockImplementationOnce(async () => json(response()));
      const feed = new CompareFeed(fetchFn);
      feed.request(IDS, query());
      await settle();
      feed.request(IDS, query({ side: 'persisted' }));
      await settle();
      expect(feed.getSnapshot().status).toBe('ready');
    });
  });

  it('reads the request on screen again when asked to, which is how a failed read is tried again', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockImplementationOnce(async () => json({ error: 'boom' }, 500))
      .mockImplementationOnce(async () => json(response()));
    const feed = new CompareFeed(fetchFn);
    feed.request(IDS, query({ side: 'fixed', page: 2 }));
    await settle();
    expect(feed.getSnapshot().status).toBe('failed');
    feed.refresh();
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![0]).toBe(compareUrl(IDS, query({ side: 'fixed', page: 2 })));
    expect(feed.getSnapshot().status).toBe('ready');
  });

  it('has nothing to read again before the first request', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    new CompareFeed(fetchFn).refresh();
    await settle();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads the same request again after it was disposed', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    const feed = new CompareFeed(fetchFn);
    feed.request(IDS, query());
    feed.dispose();
    await settle();
    feed.request(IDS, query());
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(feed.getSnapshot().status).toBe('ready');
  });

  it('tells a subscriber when the state changes', async () => {
    const feed = new CompareFeed(async () => json(response()));
    const listener = vi.fn();
    feed.subscribe(listener);
    feed.request(IDS, query());
    await settle();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
