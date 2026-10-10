/**
 * ADR 0008: what the snapshot screen holds in place of a run's findings, read against a stubbed `fetch`.
 * A filter change reads once, the request is the address's query, an answer that arrives after a newer
 * request is dropped, typing waits for a pause, and each way the read can go wrong is a state of its
 * own that says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '@/lib/explorer-session';
import { SnapshotFeed } from '@/lib/snapshot-session';
import { emptySnapshotQuery, snapshotQueryToParams, type SnapshotQuery } from '@/lib/snapshot-query';
import { SNAPSHOT_ERRORS, type SnapshotResponse } from '@/lib/snapshot-response';
import { snapshotUrl } from '@/lib/snapshot-screen';

const response = (over: Partial<SnapshotResponse> = {}): SnapshotResponse => ({
  scan: { id: 'run-1', category: 'compute', startedAt: '2026-01-01T00:00:00.000Z' },
  total: 0, page: 1, pageCount: 1, pageSize: 50, items: [], facets: { severity: [], rule: [] }, ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const query = (over: Partial<SnapshotQuery> = {}): SnapshotQuery => ({ ...emptySnapshotQuery(), ...over });

const gate = () => {
  let release!: (res: Response) => void;
  const promise = new Promise<Response>(resolve => { release = resolve; });
  return { promise, release };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Lets the read the feed started settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('the snapshot feed', () => {
  it('reads the first page once, and holds what came back', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response({ total: 3 })));
    const feed = new SnapshotFeed(fetchFn);
    expect(feed.getSnapshot().status).toBe('loading');
    feed.request('run-1', query());
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/scans/run-1/snapshot');
    const state = feed.getSnapshot();
    expect(state.status === 'ready' && state.data.total).toBe(3);
  });

  it('reads once for a filter change, and the request carries exactly the address\'s query', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    const feed = new SnapshotFeed(fetchFn);
    feed.request('run-1', query());
    await settle();
    const next = query({ severity: ['high'], rule: ['rule-1'] });
    feed.request('run-1', next);
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const url = fetchFn.mock.calls[1]![0] as string;
    expect(url).toBe(snapshotUrl('run-1', next));
    expect(url.split('?')[1]).toBe(snapshotQueryToParams(next).toString());
  });

  it('does not read again for the request it already holds or is reading', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    const feed = new SnapshotFeed(fetchFn);
    feed.request('run-1', query({ page: 2 }));
    feed.request('run-1', query({ page: 2 }));
    await settle();
    feed.request('run-1', query({ page: 2 }));
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reads again for another run, at once', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    const feed = new SnapshotFeed(fetchFn);
    feed.request('run-1', query());
    await settle();
    feed.request('run-2', query());
    await settle();
    expect(fetchFn.mock.calls.map(c => c[0])).toEqual(['/api/scans/run-1/snapshot', '/api/scans/run-2/snapshot']);
  });

  it('drops an answer that arrives after a newer request was made', async () => {
    const slow = gate();
    const fetchFn = vi.fn<FetchFn>()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(async () => json(response({ total: 2 })));
    const feed = new SnapshotFeed(fetchFn);
    feed.request('run-1', query());
    feed.request('run-1', query({ severity: ['low'] }));
    await settle();
    slow.release(json(response({ total: 99 })));
    await settle();
    const state = feed.getSnapshot();
    expect(state.status === 'ready' && state.data.total).toBe(2);
  });

  it('keeps the last list on screen while the next is on its way', async () => {
    const next = gate();
    const fetchFn = vi.fn<FetchFn>()
      .mockImplementationOnce(async () => json(response({ total: 5 })))
      .mockImplementationOnce(() => next.promise);
    const feed = new SnapshotFeed(fetchFn);
    feed.request('run-1', query());
    await settle();
    feed.request('run-1', query({ page: 2 }));
    const state = feed.getSnapshot();
    expect(state.status).toBe('loading');
    expect(state.status === 'loading' && state.stale?.total).toBe(5);
    next.release(json(response()));
    await settle();
  });

  describe('typing in the search box', () => {
    it('waits for a pause, and reads once for what was typed', async () => {
      const fetchFn = vi.fn<FetchFn>(async () => json(response()));
      const feed = new SnapshotFeed(fetchFn, 250);
      feed.request('run-1', query());
      await settle();
      feed.request('run-1', query({ search: 'v' }));
      await vi.advanceTimersByTimeAsync(100);
      feed.request('run-1', query({ search: 'vm' }));
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn.mock.calls[1]![0]).toBe(snapshotUrl('run-1', query({ search: 'vm' })));
    });

    it('does not make a filter change wait', async () => {
      const fetchFn = vi.fn<FetchFn>(async () => json(response()));
      const feed = new SnapshotFeed(fetchFn, 250);
      feed.request('run-1', query());
      await settle();
      feed.request('run-1', query({ search: 'vm', severity: ['high'] }));
      await settle();
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('a read that does not give a list', () => {
    it('is a run that was not found, in the server\'s own words', async () => {
      const feed = new SnapshotFeed(async () => json(SNAPSHOT_ERRORS['not-found'].body, 404));
      feed.request('gone', query());
      await settle();
      const state = feed.getSnapshot();
      expect(state.status).toBe('not-found');
      expect(state.status === 'not-found' && state.message).toBe(SNAPSHOT_ERRORS['not-found'].body.error);
    });

    it('is a run whose records are not available, in the server\'s own words', async () => {
      const feed = new SnapshotFeed(async () => json(SNAPSHOT_ERRORS['no-records'].body, 409));
      feed.request('old', query());
      await settle();
      const state = feed.getSnapshot();
      expect(state.status).toBe('no-records');
      expect(state.status === 'no-records' && state.message).toBe(SNAPSHOT_ERRORS['no-records'].body.error);
    });

    it('is a failed read for a server error, saying it could not load', async () => {
      const feed = new SnapshotFeed(async () => json({ error: 'Could not load the findings of this run.' }, 500));
      feed.request('run-1', query());
      await settle();
      const state = feed.getSnapshot();
      expect(state.status).toBe('failed');
      expect(state.status === 'failed' && state.message).toBe('Could not load the findings of this run.');
    });

    it('is a failed read, not a not-found, for a 404 that is not the snapshot\'s own', async () => {
      const feed = new SnapshotFeed(async () => json({ error: 'Not found' }, 404));
      feed.request('run-1', query());
      await settle();
      expect(feed.getSnapshot().status).toBe('failed');
    });

    it('is a failed read when the request never reaches the server, and keeps the last list', async () => {
      const fetchFn = vi.fn<FetchFn>()
        .mockImplementationOnce(async () => json(response({ total: 7 })))
        .mockImplementationOnce(async () => { throw new TypeError('network down'); });
      const feed = new SnapshotFeed(fetchFn);
      feed.request('run-1', query());
      await settle();
      feed.request('run-1', query({ page: 2 }));
      await settle();
      const state = feed.getSnapshot();
      expect(state.status).toBe('failed');
      expect(state.status === 'failed' && state.message).toMatch(/^Could not load the findings of this run\. /);
      expect(state.status === 'failed' && state.stale?.total).toBe(7);
    });

    it('lets the next request replace a failure', async () => {
      const fetchFn = vi.fn<FetchFn>()
        .mockImplementationOnce(async () => json({ error: 'boom' }, 500))
        .mockImplementationOnce(async () => json(response({ total: 1 })));
      const feed = new SnapshotFeed(fetchFn);
      feed.request('run-1', query());
      await settle();
      feed.request('run-1', query({ severity: ['high'] }));
      await settle();
      expect(feed.getSnapshot().status).toBe('ready');
    });
  });

  it('reads the request on screen again when asked to, which is how a failed read is tried again', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockImplementationOnce(async () => json({ error: 'boom' }, 500))
      .mockImplementationOnce(async () => json(response({ total: 4 })));
    const feed = new SnapshotFeed(fetchFn);
    feed.request('run-1', query({ page: 2 }));
    await settle();
    expect(feed.getSnapshot().status).toBe('failed');
    feed.refresh();
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![0]).toBe(snapshotUrl('run-1', query({ page: 2 })));
    expect(feed.getSnapshot().status).toBe('ready');
  });

  it('reads a search that is still waiting for a pause now, when asked to read again', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    const feed = new SnapshotFeed(fetchFn, 250);
    feed.request('run-1', query());
    await settle();
    feed.request('run-1', query({ search: 'vm' }));
    feed.refresh();
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![0]).toBe(snapshotUrl('run-1', query({ search: 'vm' })));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('has nothing to read again before the first request', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    new SnapshotFeed(fetchFn).refresh();
    await settle();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads the same request again after it was disposed', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json(response()));
    const feed = new SnapshotFeed(fetchFn);
    feed.request('run-1', query());
    feed.dispose();
    await settle();
    feed.request('run-1', query());
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(feed.getSnapshot().status).toBe('ready');
  });

  it('tells a subscriber when the state changes', async () => {
    const feed = new SnapshotFeed(async () => json(response()));
    const listener = vi.fn();
    feed.subscribe(listener);
    feed.request('run-1', query());
    await settle();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
