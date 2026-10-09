/**
 * ADR 0007: what the four view routes do around the answer itself (which finding-views-parity.test.ts
 * pins): they refuse a caller who may not read before touching anything, answer a malformed query
 * with a 400 and a stable message, answer an unknown finding with a 404, and never put a database
 * error in front of the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));

const queries = {
  queryView: vi.fn(), queryFindingRows: vi.fn(), queryGroup: vi.fn(), queryColumnValues: vi.fn(),
};
vi.mock('@/lib/db/finding-views', () => queries);

const view = await import('@/app/api/findings/view/route');
const rows = await import('@/app/api/findings/rows/route');
const group = await import('@/app/api/findings/group/route');
const columnValues = await import('@/app/api/findings/column-values/route');

const get = (route: { GET(req: Request): Promise<Response> }, name: string, query = '') =>
  route.GET(new Request(`http://localhost/api/findings/${name}${query ? `?${query}` : ''}`));

const ROUTES = [
  { name: 'view', route: view, fn: queries.queryView, query: '' },
  { name: 'rows', route: rows, fn: queries.queryFindingRows, query: 'fingerprint=abc' },
  { name: 'group', route: group, fn: queries.queryGroup, query: 'group=category&groupPath=%5B%22security%22%5D' },
  { name: 'column-values', route: columnValues, fn: queries.queryColumnValues, query: 'column=row.zone' },
] as const;

beforeEach(() => {
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
  for (const fn of Object.values(queries)) fn.mockResolvedValue({ answered: true });
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe.each(ROUTES)('GET /api/findings/$name', ({ name, route, fn, query }) => {
  it('asks for read access first, and answers a refused caller without touching the database', async () => {
    mockRequireRole.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await get(route, name, query);
    expect(res.status).toBe(401);
    expect(mockRequireRole).toHaveBeenCalledWith('read');
    expect(fn).not.toHaveBeenCalled();
  });

  it('answers a tab that is neither results nor advisories with a 400', async () => {
    const res = await get(route, name, `${query}&tab=reports`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The tab must be results or advisories.' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('reads the Results tab when no tab is given, and the suppressed flag only as 1', async () => {
    await get(route, name, query);
    expect(fn.mock.calls[0]![1]).toMatchObject({ tab: 'results', showSuppressed: false });
    await get(route, name, `${query}&tab=advisories&suppressed=1`);
    expect(fn.mock.calls[1]![1]).toMatchObject({ tab: 'advisories', showSuppressed: true });
    await get(route, name, `${query}&suppressed=true`);
    expect(fn.mock.calls[2]![1]).toMatchObject({ showSuppressed: false });
  });

  it('answers a failed read with the stable message, never the error itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fn.mockRejectedValue(new Error('connection to 10.1.2.3 refused for tenant 11111111-2222-3333-4444-555555555555'));
    const res = await get(route, name, query);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/^Could not load the .+\. Check the RuleBeat server logs for details\.$/);
    expect(JSON.stringify(body)).not.toMatch(/10\.1\.2\.3|tenant/);
  });
});

describe('GET /api/findings/view', () => {
  it('hands the view its query holds to the module, and returns what it answers', async () => {
    queries.queryView.mockResolvedValue({ total: 3 });
    const res = await get(view, 'view', 'severity=high&status=all&q=alpha&sort=rule:desc&page=2');
    expect(await res.json()).toEqual({ total: 3 });
    expect(queries.queryView.mock.calls[0]![0]).toMatchObject({
      filters: [{ field: 'severity', values: ['high'] }, { field: 'status', values: ['all'] }],
      search: 'alpha', sort: { field: 'rule', dir: 'desc' }, page: 2,
    });
  });

  it('lists 50 findings a page unless a page size is asked for', async () => {
    await get(view, 'view');
    expect(queries.queryView.mock.calls[0]![0]).toMatchObject({ pageSize: 50 });
  });

  it('lists as many findings a page as asked for, up to 1,000, and never more', async () => {
    await get(view, 'view', 'pageSize=200');
    await get(view, 'view', 'pageSize=1000');
    await get(view, 'view', 'pageSize=1001');
    await get(view, 'view', 'pageSize=99999999');
    expect(queries.queryView.mock.calls.map(c => (c[0] as { pageSize: number }).pageSize)).toEqual([200, 1000, 1000, 1000]);
  });

  it.each(['0', '-5', '2.5', 'many', ''])('lists 50 a page for a page size of %j', async (size) => {
    await get(view, 'view', `pageSize=${size}`);
    expect(queries.queryView.mock.calls[0]![0]).toMatchObject({ pageSize: 50 });
  });
});

describe('a page size on the other view routes', () => {
  it('is ignored: a group lists 50 findings a page whatever is asked for', async () => {
    await get(group, 'group', 'group=category&groupPath=%5B%22security%22%5D&pageSize=1000');
    expect(queries.queryGroup.mock.calls[0]![0]).toMatchObject({ pageSize: 50 });
  });
});

describe('GET /api/findings/rows', () => {
  it('answers 400 without a fingerprint', async () => {
    const res = await get(rows, 'rows', 'tab=results');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'fingerprint is required.' });
  });

  it('answers 404 for a finding the tab does not list', async () => {
    queries.queryFindingRows.mockResolvedValue(null);
    const res = await get(rows, 'rows', 'fingerprint=gone');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Finding not found.' });
  });

  it('reads rowsPage as a whole number from 1, and anything else as the first page', async () => {
    for (const [given, wanted] of [['3', 3], ['0', 1], ['-2', 1], ['1.5', 1], ['x', 1], ['', 1]] as const) {
      queries.queryFindingRows.mockClear();
      await get(rows, 'rows', `fingerprint=abc&rowsPage=${given}`);
      expect(queries.queryFindingRows.mock.calls[0]![1]).toMatchObject({ fingerprint: 'abc', rowsPage: wanted });
    }
  });
});

describe('GET /api/findings/group', () => {
  it('answers 400 without a groupPath, and for one that is not a JSON array of strings and nulls', async () => {
    const bad = ['', 'groupPath=', 'groupPath=security', 'groupPath=%7B%7D', 'groupPath=%5B1%5D', 'groupPath=%5B%5B%5D%5D'];
    for (const query of bad) {
      const res = await get(group, 'group', `group=category&${query}`);
      expect(res.status, query).toBe(400);
      expect(Object.keys(await res.json())).toEqual(['error']);
    }
    expect(queries.queryGroup).not.toHaveBeenCalled();
  });

  it('reads the path as the values from the outermost group down, null for the empty-value group', async () => {
    await get(group, 'group', `group=category,row.zone&groupPath=${encodeURIComponent('["security",null]')}&groupPage=2`);
    expect(queries.queryGroup.mock.calls[0]![1]).toMatchObject({ groupPath: ['security', null], groupPage: 2 });
  });

  it('accepts an empty path, which the answer treats as no group', async () => {
    const res = await get(group, 'group', 'groupPath=%5B%5D');
    expect(res.status).toBe(200);
    expect(queries.queryGroup.mock.calls[0]![1]).toMatchObject({ groupPath: [], groupPage: 1 });
  });
});

describe('GET /api/findings/column-values', () => {
  it('answers 400 unless the column is row.<path>', async () => {
    for (const column of ['', 'zone', 'row.', 'severity', 'rows.zone']) {
      const res = await get(columnValues, 'column-values', `column=${column}`);
      expect(res.status, column).toBe(400);
      expect(await res.json()).toEqual({ error: 'column must be row.<path>.' });
    }
    expect((await get(columnValues, 'column-values')).status).toBe(400);
    expect(queries.queryColumnValues).not.toHaveBeenCalled();
  });

  it('keeps the search inside the column apart from the view\'s own search', async () => {
    await get(columnValues, 'column-values', 'column=row.zone&q=alpha&valueQuery=2');
    const [searched, options] = queries.queryColumnValues.mock.calls[0]!;
    expect(searched.search).toBe('alpha');
    expect(options).toMatchObject({ column: 'row.zone', q: '2' });
  });

  it('passes no search when none is given', async () => {
    await get(columnValues, 'column-values', 'column=row.properties.sku.name');
    expect(queries.queryColumnValues.mock.calls[0]![1].q).toBeUndefined();
  });
});
