/**
 * ADR 0007: what the explorer reads and when. Every read goes to a stubbed `fetch` standing in for the
 * four /api/findings routes, so what is pinned is the contract between the explorer and the server:
 * which URL a change asks for, that the address and the request agree, what a failed read says, and
 * that an answer for an older request never replaces the one for the newer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyView, filterValues, rowField, viewFromSearchParams, viewToSearchParams, type View } from '@/lib/finding-view';
import {
  ExplorerSession, READ_TIMEOUT_MS, SEARCH_DEBOUNCE_MS, columnValuesUrl, explorerAddress, filtersWithoutLockedCategory, groupUrl, readJson, remoteValuesFor, rowsUrl, ruleFindingsUrl,
  viewQuery, viewUrl, type FetchFn, type ViewRequest,
} from '@/lib/explorer-session';
import type { ViewResponse } from '@/lib/view-response';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A view response that holds only what a test looks at. */
const viewAnswer = (total: number, extra: Partial<ViewResponse> = {}) => ({ total, page: 1, pageCount: 1, items: [], ...extra }) as unknown as ViewResponse;

interface Pending { url: string; resolve(res: Response): void; reject(err: unknown): void; signal?: AbortSignal }

/** A fetch that answers nothing until the test says so, so the order of answers is the test's.
 *  `ignoreAbort` is a network that delivers an answer whether or not the caller gave up on it. */
function heldFetch(opts: { ignoreAbort?: boolean } = {}) {
  const calls: Pending[] = [];
  const fetchFn: FetchFn = (url, init) => new Promise<Response>((resolve, reject) => {
    calls.push({ url, resolve, reject, signal: init?.signal });
    if (!opts.ignoreAbort) init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  return { calls, fetchFn };
}

/** A fetch that answers each call at once from a function of its URL. */
function answeringFetch(answer: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (url) => { urls.push(url); return answer(url); };
  return { urls, fetchFn };
}

const request = (view: View = emptyView(), extra: Partial<ViewRequest> = {}): ViewRequest => ({ view, tab: 'results', showSuppressed: false, ...extra });
const withFilter = (field: 'severity' | 'category', values: string[]): View => ({ ...emptyView(), filters: [{ field, values }] });
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the requests', () => {
  it('ask the view route for exactly the query the address carries, behind the tab', () => {
    const view: View = {
      ...withFilter('severity', ['high', 'medium']), search: 'alpha', columns: ['zone'], page: 3,
      sort: { field: 'rule', dir: 'desc' }, groupBy: ['category'],
    };
    const address = viewToSearchParams(view, { tab: 'results' }).toString();
    expect(viewQuery(request(view))).toBe(address);
    expect(viewUrl(request(view))).toBe(`/api/findings/view?${address}`);
    expect(address).toBe('tab=results&severity=high%2Cmedium&q=alpha&cols=zone&sort=rule%3Adesc&group=category&page=3');
  });

  it('put the suppressed flag and the Advisories tab after what the address carries', () => {
    expect(viewQuery(request(emptyView(), { tab: 'advisories', showSuppressed: true }))).toBe('tab=advisories&suppressed=1');
  });

  it('carry a locked category in the read of the view, and leave it out of the address', () => {
    const view: View = { ...withFilter('severity', ['high']), filters: [{ field: 'category', values: ['security'] }, { field: 'severity', values: ['high'] }] };
    expect(viewQuery(request(view))).toBe('tab=results&category=security&severity=high');
    expect(new URL(`http://x${viewUrl(request(view))}`).searchParams.get('category')).toBe('security');
    expect(explorerAddress(view, { lockedCategory: 'security' })).toBe('severity=high');
    // Unlocked, the category is as much the viewer's filter as any other and is in the address.
    expect(explorerAddress(view)).toBe('category=security&severity=high');
    expect(filtersWithoutLockedCategory(view.filters, 'security')).toEqual([{ field: 'severity', values: ['high'] }]);
    expect(filtersWithoutLockedCategory(view.filters)).toEqual(view.filters);
  });

  it('read back, through the same reader the route uses, as the view that was asked for', () => {
    const view: View = { ...withFilter('category', ['security']), search: 'x y', columns: ['a.b', 'zone'], page: 2, groupBy: ['severity', rowField('zone')] };
    const params = new URL(`http://x${viewUrl(request(view))}`).searchParams;
    expect(viewFromSearchParams(params)).toEqual(view);
  });

  it('read a column\'s values with the view but not its page, and the search inside the column apart from it', () => {
    const view: View = { ...withFilter('severity', ['high']), search: 'vm', page: 4 };
    const url = columnValuesUrl(request(view), rowField('properties.sku'), 'prem');
    const params = new URL(`http://x${url}`).searchParams;
    expect(url.startsWith('/api/findings/column-values?')).toBe(true);
    expect([...params.entries()]).toEqual([
      ['tab', 'results'], ['severity', 'high'], ['q', 'vm'], ['column', 'row.properties.sku'], ['valueQuery', 'prem'],
    ]);
    expect(columnValuesUrl(request(view), rowField('zone'), '')).not.toContain('valueQuery');
  });

  it('read a group by the path of values from the outermost down, with null for the empty-value group', () => {
    const view: View = { ...emptyView(), groupBy: ['category', rowField('zone')] };
    const params = (url: string) => new URL(`http://x${url}`).searchParams;
    const first = params(groupUrl(request(view), ['security', null], 1));
    expect(JSON.parse(first.get('groupPath')!)).toEqual(['security', null]);
    expect(first.get('group')).toBe('category,row.zone');
    expect(first.has('groupPage')).toBe(false);
    expect(params(groupUrl(request(view), ['security'], 3)).get('groupPage')).toBe('3');
  });

  it('read a finding\'s rows by fingerprint and page, and a group\'s rows through its conditions as filters', () => {
    const view: View = { ...emptyView(), groupBy: [rowField('zone')], filters: [{ field: rowField('zone'), values: ['a', 'b'] }] };
    const params = (url: string) => new URL(`http://x${url}`).searchParams;
    const plain = params(rowsUrl(request(view), 'fp1', 1));
    expect(plain.get('fingerprint')).toBe('fp1');
    expect(plain.has('rowsPage')).toBe(false);
    expect(params(rowsUrl(request(view), 'fp1', 2)).get('rowsPage')).toBe('2');

    const inGroup = params(rowsUrl(request(view), 'fp1', 1, [{ path: 'zone', value: 'a' }]));
    expect(viewFromSearchParams(inGroup).filters).toEqual([{ field: rowField('zone'), values: ['a'] }]);
    const blank = params(rowsUrl(request(view), 'fp1', 1, [{ path: 'zone', value: null }]));
    expect(viewFromSearchParams(blank).filters).toEqual([{ field: rowField('zone'), values: [''] }]);
  });
});

describe('the By rule read', () => {
  it('reads a rule\'s findings as the view with that one rule, ungrouped, at the page asked for', () => {
    const view: View = {
      ...withFilter('severity', ['high']), search: 'vm', page: 4, groupBy: ['category'],
      filters: [{ field: 'severity', values: ['high'] }, { field: 'rule', values: ['r1', 'r2'] }],
    };
    const first = viewFromSearchParams(new URL(`http://x${ruleFindingsUrl(request(view), 'r2', 1)}`).searchParams);
    // The address writes filters in its own order, so each is read by its field.
    expect(first.filters).toHaveLength(2);
    expect(filterValues(first.filters, 'severity')).toEqual(['high']);
    expect(filterValues(first.filters, 'rule')).toEqual(['r2']);
    expect(first.search).toBe('vm');
    expect(first.groupBy).toEqual([]);
    expect(first.page).toBe(1);
    expect(ruleFindingsUrl(request(view), 'r2', 3).startsWith('/api/findings/view?tab=results')).toBe(true);
    expect(viewFromSearchParams(new URL(`http://x${ruleFindingsUrl(request(view), 'r2', 3)}`).searchParams).page).toBe(3);
  });

  it('is its own lazy read on the session, forgotten on a scan with the others', async () => {
    const { urls, fetchFn } = answeringFetch(() => json(viewAnswer(2)));
    const session = new ExplorerSession(fetchFn);
    const url = ruleFindingsUrl(request(), 'r1', 1);
    session.ruleFindings.load(url);
    await settle();
    expect(session.ruleFindings.getSnapshot().entries.get(url)).toMatchObject({ status: 'ready', data: { total: 2 } });
    session.refresh();
    expect(session.ruleFindings.getSnapshot().entries.size).toBe(0);
    expect(urls).toHaveLength(1);
  });
});

describe('reading one answer', () => {
  it('returns the parsed body of an answer that is ok', async () => {
    const { fetchFn } = answeringFetch(() => json({ total: 3 }));
    expect(await readJson(fetchFn, '/x', 'the findings')).toEqual({ ok: true, data: { total: 3 } });
  });

  it('keeps the server\'s own message when it already says it could not load', async () => {
    const { fetchFn } = answeringFetch(() => json({ error: 'Could not load the findings. Check the RuleBeat server logs for details.' }, 500));
    expect(await readJson(fetchFn, '/x', 'the findings')).toEqual({
      ok: false, message: 'Could not load the findings. Check the RuleBeat server logs for details.',
    });
  });

  it('puts a message that is only a reason (a 400) after "Could not load"', async () => {
    const { fetchFn } = answeringFetch(() => json({ error: 'The tab must be results or advisories.' }, 400));
    expect(await readJson(fetchFn, '/x', 'the findings')).toEqual({
      ok: false, message: 'Could not load the findings. The tab must be results or advisories.',
    });
  });

  it('names the status when the body says nothing', async () => {
    const { fetchFn } = answeringFetch(() => new Response('<html>', { status: 502 }));
    expect(await readJson(fetchFn, '/x', 'the findings')).toEqual({ ok: false, message: 'Could not load the findings. The server answered 502.' });
  });

  it('says so when the answer cannot be read, and when the request never reached the server', async () => {
    const unreadable = answeringFetch(() => new Response('not json', { status: 200 }));
    expect(await readJson(unreadable.fetchFn, '/x', 'the values')).toEqual({ ok: false, message: 'Could not load the values. The answer could not be read.' });
    const offline: FetchFn = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await readJson(offline, '/x', 'the values')).toEqual({ ok: false, message: 'Could not load the values. The request did not reach the server.' });
  });

  it('gives up on a read that takes too long and says that is why', async () => {
    const { fetchFn } = heldFetch();
    const read = readJson(fetchFn, '/x', 'the findings');
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(await read).toEqual({ ok: false, message: 'Could not load the findings. The server took too long to answer.' });
  });

  it('never writes an em dash into what it says', async () => {
    const reads = [
      answeringFetch(() => json({ error: 'x' }, 400)), answeringFetch(() => new Response('', { status: 500 })),
      { fetchFn: (() => Promise.reject(new Error('x'))) as FetchFn },
    ];
    for (const { fetchFn } of reads) {
      const result = await readJson(fetchFn, '/x', 'the findings');
      expect(result.ok ? '' : result.message).not.toContain('—');
    }
  });
});

describe('the view feed', () => {
  it('fetches once for a view change, and the URL is the address behind the view route', async () => {
    const { urls, fetchFn } = answeringFetch(() => json(viewAnswer(2)));
    const session = new ExplorerSession(fetchFn);
    const view = withFilter('severity', ['high']);
    session.view.request(request(view));
    await settle();
    expect(urls).toEqual([`/api/findings/view?${viewToSearchParams(view, { tab: 'results' })}`]);
    const state = session.view.getSnapshot();
    expect(state.status === 'ready' && state.data.total).toBe(2);
  });

  it('is loading, with the last answer kept, while the next one is on its way', async () => {
    const { calls, fetchFn } = heldFetch();
    const session = new ExplorerSession(fetchFn);
    session.view.request(request());
    expect(session.view.getSnapshot()).toMatchObject({ status: 'loading' });
    calls[0]!.resolve(json(viewAnswer(1)));
    await settle();
    session.view.request(request(withFilter('severity', ['high'])));
    const state = session.view.getSnapshot();
    expect(state.status === 'loading' && state.stale?.total).toBe(1);
  });

  it('does not fetch again for the request it already holds', async () => {
    const { urls, fetchFn } = answeringFetch(() => json(viewAnswer(1)));
    const session = new ExplorerSession(fetchFn);
    session.view.request(request());
    session.view.request(request());
    await settle();
    session.view.request(request());
    await settle();
    expect(urls).toHaveLength(1);
  });

  it('reads again for each of the changes a viewer can make, one fetch each', async () => {
    const { urls, fetchFn } = answeringFetch(() => json(viewAnswer(1)));
    const session = new ExplorerSession(fetchFn);
    const base = emptyView();
    const changes: ViewRequest[] = [
      request(base),
      request({ ...base, filters: [{ field: 'category', values: ['security'] }] }),
      request({ ...base, window: { mode: 'relative', days: 30 } }),
      request({ ...base, columns: ['zone'] }),
      request({ ...base, sort: { field: 'rule', dir: 'asc' } }),
      request({ ...base, groupBy: ['category'] }),
      request({ ...base, page: 2 }),
      request(base, { tab: 'advisories' }),
      request(base, { showSuppressed: true }),
    ];
    for (const change of changes) { session.view.request(change); await settle(); }
    expect(urls).toHaveLength(changes.length);
    expect(new Set(urls).size).toBe(changes.length);
  });

  it('shows a failed read as failed, with why, and never as an answer', async () => {
    const { fetchFn } = answeringFetch(() => json({ error: 'Could not load the findings. Check the RuleBeat server logs for details.' }, 500));
    const session = new ExplorerSession(fetchFn);
    session.view.request(request());
    await settle();
    expect(session.view.getSnapshot()).toEqual({
      status: 'failed', message: 'Could not load the findings. Check the RuleBeat server logs for details.', query: 'tab=results',
    });
  });

  it('keeps the last answer beside a failed read, so the controls stay on screen to change the view', async () => {
    let ok = true;
    const { fetchFn } = answeringFetch(() => (ok ? json(viewAnswer(4)) : json({ error: 'no' }, 500)));
    const session = new ExplorerSession(fetchFn);
    session.view.request(request());
    await settle();
    ok = false;
    session.view.refresh();
    await settle();
    const snapshot = session.view.getSnapshot();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.status === 'failed' ? snapshot.stale?.total : undefined).toBe(4);
  });

  it('recovers from a failure when the next read succeeds', async () => {
    let ok = false;
    const { fetchFn } = answeringFetch(() => (ok ? json(viewAnswer(4)) : json({ error: 'no' }, 500)));
    const session = new ExplorerSession(fetchFn);
    session.view.request(request());
    await settle();
    expect(session.view.getSnapshot().status).toBe('failed');
    ok = true;
    session.view.refresh();
    await settle();
    expect(session.view.getSnapshot().status).toBe('ready');
  });

  it('fetches the view again when a scan completes, for the request on screen', async () => {
    const { urls, fetchFn } = answeringFetch(() => json(viewAnswer(1)));
    const session = new ExplorerSession(fetchFn);
    const view = withFilter('category', ['security']);
    session.view.request(request(view));
    await settle();
    session.refresh();
    await settle();
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(urls[0]);
  });

  it('drops a late answer to an older request instead of overwriting the newer one', async () => {
    const { calls, fetchFn } = heldFetch({ ignoreAbort: true });
    const session = new ExplorerSession(fetchFn);
    session.view.request(request(withFilter('severity', ['high'])));
    session.view.request(request(withFilter('severity', ['low'])));
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(json(viewAnswer(2)));
    await settle();
    // The older one answers after the newer one. Resolving it directly, as a network that ignored the
    // abort would deliver it.
    calls[0]!.resolve(json(viewAnswer(99)));
    await settle();
    const state = session.view.getSnapshot();
    expect(state.status === 'ready' && state.data.total).toBe(2);
    expect(state.query).toBe('tab=results&severity=low');
  });

  it('drops a late failure of an older request too', async () => {
    const { calls, fetchFn } = heldFetch({ ignoreAbort: true });
    const session = new ExplorerSession(fetchFn);
    session.view.request(request(withFilter('severity', ['high'])));
    session.view.request(request(withFilter('severity', ['low'])));
    calls[1]!.resolve(json(viewAnswer(2)));
    await settle();
    calls[0]!.resolve(json({ error: 'x' }, 500));
    await settle();
    expect(session.view.getSnapshot().status).toBe('ready');
  });

  it('aborts the read it no longer needs', () => {
    const { calls, fetchFn } = heldFetch();
    const session = new ExplorerSession(fetchFn);
    session.view.request(request(withFilter('severity', ['high'])));
    session.view.request(request(withFilter('severity', ['low'])));
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[1]!.signal?.aborted).toBe(false);
  });

  it('reads the view again when it is asked for after being stopped, as when a screen mounts twice in development', async () => {
    const { calls, fetchFn } = heldFetch();
    const session = new ExplorerSession(fetchFn);
    session.view.request(request());
    session.dispose();
    session.view.request(request());
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(json(viewAnswer(3)));
    await settle();
    expect(session.view.getSnapshot()).toMatchObject({ status: 'ready', data: { total: 3 } });
  });

  describe('typing in the search box', () => {
    const typed = (text: string) => request({ ...emptyView(), search: text });

    it('waits for the typing to stop, then reads once for what was typed', async () => {
      const { urls, fetchFn } = answeringFetch(() => json(viewAnswer(1)));
      const session = new ExplorerSession(fetchFn);
      session.view.request(request());
      await settle();
      urls.length = 0;
      for (const text of ['a', 'al', 'alp']) {
        session.view.request(typed(text));
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50);
      }
      expect(urls).toEqual([]);
      await vi.advanceTimersByTimeAsync(50);
      expect(urls).toEqual(['/api/findings/view?tab=results&q=alp']);
    });

    it('reads at once when something other than the search changes, and drops the waiting search read', async () => {
      const { urls, fetchFn } = answeringFetch(() => json(viewAnswer(1)));
      const session = new ExplorerSession(fetchFn);
      session.view.request(request());
      await settle();
      urls.length = 0;
      session.view.request(typed('alp'));
      session.view.request(request({ ...emptyView(), search: 'alp', filters: [{ field: 'severity', values: ['high'] }] }));
      await settle();
      expect(urls).toEqual(['/api/findings/view?tab=results&severity=high&q=alp']);
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
      expect(urls).toHaveLength(1);
    });

    it('reads nothing when the text is typed and deleted again before the wait is over', async () => {
      const { urls, fetchFn } = answeringFetch(() => json(viewAnswer(1)));
      const session = new ExplorerSession(fetchFn);
      session.view.request(request());
      await settle();
      urls.length = 0;
      session.view.request(typed('a'));
      session.view.request(request());
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
      expect(urls).toEqual([]);
    });

    it('does not wait for the first read', async () => {
      const { urls, fetchFn } = answeringFetch(() => json(viewAnswer(1)));
      const session = new ExplorerSession(fetchFn);
      session.view.request(typed('opened from a link'));
      await settle();
      expect(urls).toHaveLength(1);
    });
  });
});

describe('the lazy reads', () => {
  const view: View = { ...emptyView(), groupBy: [rowField('zone')] };

  it('read a column\'s values once when asked, and show them as loading, then ready', async () => {
    const { calls, fetchFn } = heldFetch();
    const session = new ExplorerSession(fetchFn);
    const url = columnValuesUrl(request(view), rowField('zone'), '');
    session.values.load(url);
    session.values.load(url);
    expect(calls).toHaveLength(1);
    expect(session.values.getSnapshot().entries.get(url)).toEqual({ status: 'loading' });
    calls[0]!.resolve(json({ column: 'row.zone', values: [{ value: 'a', count: 2 }], total: 1 }));
    await settle();
    expect(session.values.getSnapshot().entries.get(url)).toEqual({
      status: 'ready', data: { column: 'row.zone', values: [{ value: 'a', count: 2 }], total: 1 },
    });
  });

  it('search a column through the route, a new key for each text, and keep a late answer to older text out of the newer', async () => {
    const { calls, fetchFn } = heldFetch();
    const session = new ExplorerSession(fetchFn);
    const older = columnValuesUrl(request(view), rowField('zone'), 'a');
    const newer = columnValuesUrl(request(view), rowField('zone'), 'ab');
    session.values.load(older);
    session.values.load(newer);
    expect(calls.map(c => new URL(`http://x${c.url}`).searchParams.get('valueQuery'))).toEqual(['a', 'ab']);
    calls[1]!.resolve(json({ column: 'row.zone', values: [{ value: 'ab', count: 1 }], total: 1 }));
    calls[0]!.resolve(json({ column: 'row.zone', values: [{ value: 'a', count: 5 }, { value: 'ab', count: 1 }], total: 2 }));
    await settle();
    const { entries } = session.values.getSnapshot();
    expect(entries.get(newer)).toMatchObject({ status: 'ready', data: { total: 1 } });
    expect(entries.get(older)).toMatchObject({ status: 'ready', data: { total: 2 } });
  });

  it('say why a read failed, and read again only when asked to retry', async () => {
    let ok = false;
    const { urls, fetchFn } = answeringFetch(() => (ok ? json({ column: 'row.zone', values: [], total: 0 }) : json({ error: 'x' }, 500)));
    const session = new ExplorerSession(fetchFn);
    const url = columnValuesUrl(request(view), rowField('zone'), '');
    session.values.load(url);
    await settle();
    expect(session.values.getSnapshot().entries.get(url)).toEqual({ status: 'failed', message: 'Could not load the values. x.' });
    session.values.load(url);
    await settle();
    expect(urls).toHaveLength(1);
    ok = true;
    session.values.load(url, { retry: true });
    await settle();
    expect(urls).toHaveLength(2);
    expect(session.values.getSnapshot().entries.get(url)?.status).toBe('ready');
  });

  it('read a group\'s contents when it is opened, and its further page when that is asked for', async () => {
    const { urls, fetchFn } = answeringFetch(() => json({ group: {}, groups: [], items: [], total: 0, page: 1, pageCount: 1 }));
    const session = new ExplorerSession(fetchFn);
    session.groups.load(groupUrl(request(view), ['a'], 1));
    session.groups.load(groupUrl(request(view), ['a'], 2));
    await settle();
    expect(urls.map(u => new URL(`http://x${u}`).searchParams.get('groupPage'))).toEqual([null, '2']);
  });

  it('page a finding\'s rows from the rows route, one read per page', async () => {
    const { urls, fetchFn } = answeringFetch(() => json({ fingerprint: 'fp', rows: [], page: 1, pageCount: 3, matchedRowCount: 45, rowCount: 45, firstIndex: 0 }));
    const session = new ExplorerSession(fetchFn);
    for (const page of [2, 3, 2]) session.rows.load(rowsUrl(request(view), 'fp', page));
    await settle();
    expect(urls.map(u => new URL(`http://x${u}`).searchParams.get('rowsPage'))).toEqual(['2', '3']);
  });

  it('forget everything on a scan, so an open dropdown, group or rows page reads again', async () => {
    const { urls, fetchFn } = answeringFetch(() => json({ values: [], total: 0 }));
    const session = new ExplorerSession(fetchFn);
    const url = columnValuesUrl(request(view), rowField('zone'), '');
    session.values.load(url);
    await settle();
    session.refresh();
    expect(session.values.getSnapshot().entries.size).toBe(0);
    session.values.load(url);
    await settle();
    expect(urls.filter(u => u.startsWith('/api/findings/column-values'))).toHaveLength(2);
  });

  it('drop an answer that arrives after a scan reset the reads', async () => {
    const { calls, fetchFn } = heldFetch();
    const session = new ExplorerSession(fetchFn);
    const url = columnValuesUrl(request(view), rowField('zone'), '');
    session.values.load(url);
    session.values.reset();
    calls[0]!.resolve(json({ column: 'row.zone', values: [], total: 0 }));
    await settle();
    expect(session.values.getSnapshot().entries.has(url)).toBe(false);
  });
});

describe('what a dropdown of a returned column reads', () => {
  const view: View = { ...withFilter('severity', ['high']), groupBy: [rowField('zone')] };
  const zones = { column: 'row.zone', values: [{ value: 'a', count: 2 }, { value: '', count: 1 }], total: 2 };

  it('has nothing to read for a column the findings carry themselves', () => {
    const session = new ExplorerSession(answeringFetch(() => json(zones)).fetchFn);
    expect(remoteValuesFor(session, request(view), 'severity')).toBeUndefined();
    expect(remoteValuesFor(session, request(view), 'subscription')).toBeUndefined();
  });

  it('reads nothing until the dropdown asks, and then exactly the values route for the view and the text', async () => {
    const { urls, fetchFn } = answeringFetch(() => json(zones));
    const remote = remoteValuesFor(new ExplorerSession(fetchFn), request(view), rowField('zone'))!;
    expect(urls).toEqual([]);
    expect(remote.read('')).toBeUndefined();
    remote.load('');
    await settle();
    expect(urls).toEqual(['/api/findings/column-values?tab=results&severity=high&group=row.zone&column=row.zone']);
    remote.load('al');
    await settle();
    expect(urls[1]).toBe('/api/findings/column-values?tab=results&severity=high&group=row.zone&column=row.zone&valueQuery=al');
  });

  it('holds the answer for the text it was read for, and tells a listener when it changes', async () => {
    const { fetchFn } = answeringFetch(() => json(zones));
    const remote = remoteValuesFor(new ExplorerSession(fetchFn), request(view), rowField('zone'))!;
    const heard = vi.fn();
    const stop = remote.subscribe(heard);
    remote.load('');
    expect(remote.read('')).toEqual({ status: 'loading' });
    await settle();
    expect(remote.read('')).toEqual({ status: 'ready', data: zones });
    expect(remote.read('al')).toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    remote.load('al');
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('reads a failed read again only when told to retry', async () => {
    let ok = false;
    const { urls, fetchFn } = answeringFetch(() => (ok ? json(zones) : json({ error: 'x' }, 500)));
    const remote = remoteValuesFor(new ExplorerSession(fetchFn), request(view), rowField('zone'))!;
    remote.load('');
    await settle();
    expect(remote.read('')).toEqual({ status: 'failed', message: 'Could not load the values. x.' });
    remote.load('');
    await settle();
    expect(urls).toHaveLength(1);
    ok = true;
    remote.load('', { retry: true });
    await settle();
    expect(urls).toHaveLength(2);
    expect(remote.read('')).toEqual({ status: 'ready', data: zones });
  });

  it('does not show one view\'s values for another', async () => {
    const { fetchFn } = answeringFetch(() => json(zones));
    const session = new ExplorerSession(fetchFn);
    remoteValuesFor(session, request(view), rowField('zone'))!.load('');
    await settle();
    const other = remoteValuesFor(session, request(withFilter('severity', ['low'])), rowField('zone'))!;
    expect(other.read('')).toBeUndefined();
  });
});

describe('reading every finding for an export', () => {
  const finding = (n: number) => ({ fingerprint: `fp${n}`, ruleId: 'r', title: `t${n}` });

  it('pages through the view with no grouping, and takes a finding\'s further rows from the rows route', async () => {
    const { urls, fetchFn } = answeringFetch(url => {
      const params = new URL(`http://x${url}`).searchParams;
      if (url.startsWith('/api/findings/rows')) {
        return json({ fingerprint: 'fp1', rows: [{ n: 3 }], page: Number(params.get('rowsPage')), pageCount: 2, matchedRowCount: 3, rowCount: 3, firstIndex: 2 });
      }
      const page = Number(params.get('page') ?? 1);
      return json(page === 1
        ? { page: 1, pageCount: 2, items: [{ finding: finding(1), rows: [{ n: 1 }, { n: 2 }], rowCount: 3, matchedRowCount: 3 }] }
        : { page: 2, pageCount: 2, items: [{ finding: finding(2), rows: [], rowCount: 0, matchedRowCount: 0 }] });
    });
    const out = await new ExplorerSession(fetchFn).readEvery(request({ ...emptyView(), groupBy: ['category'], page: 5 }));
    expect(out.ok && out.data).toEqual([
      { ...finding(1), rows: [{ n: 1 }, { n: 2 }, { n: 3 }], evidence: { n: 1 } },
      { ...finding(2), rows: [], evidence: {} },
    ]);
    expect(urls).toEqual([
      '/api/findings/view?tab=results&pageSize=1000',
      '/api/findings/rows?tab=results&fingerprint=fp1&rowsPage=2',
      '/api/findings/view?tab=results&page=2&pageSize=1000',
    ]);
  });

  it('asks for 1,000 findings a page, and for further rows only of a finding that holds more than it carried', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ n: i }));
    const items = [
      { finding: finding(1), rows: twenty, rowCount: 20, matchedRowCount: 20 },
      { finding: finding(2), rows: [{ n: 0 }], rowCount: 1, matchedRowCount: 1 },
      { finding: finding(3), rows: twenty, rowCount: 25, matchedRowCount: 25 },
    ];
    const { urls, fetchFn } = answeringFetch(url => (url.startsWith('/api/findings/rows')
      ? json({ fingerprint: 'fp3', rows: [{ n: 20 }, { n: 21 }, { n: 22 }, { n: 23 }, { n: 24 }], page: 2, pageCount: 2, matchedRowCount: 25, rowCount: 25, firstIndex: 20 })
      : json({ page: 1, pageCount: 1, items })));
    const out = await new ExplorerSession(fetchFn).readEvery(request());
    expect(out.ok && out.data.map(f => f.rows.length)).toEqual([20, 1, 25]);
    expect(urls).toEqual([
      '/api/findings/view?tab=results&pageSize=1000',
      '/api/findings/rows?tab=results&fingerprint=fp3&rowsPage=2',
    ]);
  });

  it('keeps the page size out of the address and out of every other read', () => {
    const view: View = { ...withFilter('severity', ['high']), page: 2 };
    for (const url of [
      viewUrl(request(view)), rowsUrl(request(view), 'fp1', 2), groupUrl(request(view), ['a'], 2),
      columnValuesUrl(request(view), rowField('zone'), 'q'), ruleFindingsUrl(request(view), 'r1', 2),
    ]) expect(url).not.toContain('pageSize');
    expect(viewToSearchParams(view, { tab: 'results' }).toString()).not.toContain('pageSize');
  });

  it('fails as a whole, with why, when any read fails', async () => {
    const { fetchFn } = answeringFetch(() => json({ error: 'Could not load the findings. Check the RuleBeat server logs for details.' }, 500));
    expect(await new ExplorerSession(fetchFn).readEvery(request())).toEqual({
      ok: false, message: 'Could not load the findings. Check the RuleBeat server logs for details.',
    });
  });
});
