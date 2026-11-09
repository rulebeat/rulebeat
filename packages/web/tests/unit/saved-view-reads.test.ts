/**
 * With a saved view open, a read of the findings carries the view's id, its revision and the changes
 * on top of it, and the server puts the effective View together (ADR 0013). The browser never sends a
 * copy of the view, so an old full-copy link opens as bookmarked and never widens, and a view that is
 * unknown or deleted answers one 404 whichever it is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createSavedView, deleteSavedView } from '@/lib/db/saved-views';
import { effectiveView } from '@/lib/effective-filters';
import { readViewRequest } from '@/lib/view-request';
import { filterValues, viewToSearchParams } from '@/lib/finding-view';
import { SAVED_VIEW_UNAVAILABLE } from '@/lib/saved-view-query';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));
const queries = { queryView: vi.fn(), queryFindingRows: vi.fn(), queryGroup: vi.fn(), queryColumnValues: vi.fn(), openExport: vi.fn() };
vi.mock('@/lib/db/finding-views', () => queries);
vi.mock('@/lib/export-stream', () => ({ streamExport: () => Promise.resolve('[]') }));

const routes = {
  view: (await import('@/app/api/findings/view/route')).GET,
  rows: (await import('@/app/api/findings/rows/route')).GET,
  group: (await import('@/app/api/findings/group/route')).GET,
  'column-values': (await import('@/app/api/findings/column-values/route')).GET,
  export: (await import('@/app/api/findings/export/route')).GET,
};
const EXTRA: Record<keyof typeof routes, string> = {
  view: '', rows: '&fingerprint=abc', group: '&groupPath=%5B%5D', 'column-values': '&column=row.zone', export: '&format=json',
};

const SAVED_QUERY = 'category=security&severity=critical%2Chigh&subscription=sub-a&status=all&window=30&q=vm&sort=rule%3Adesc';
let viewId: string;
let revision: number;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ id: 'viewer', access: { everything: true } });
  for (const fn of Object.values(queries)) fn.mockResolvedValue({ answered: true });
  const created = await createSavedView({ name: 'Critical in A', tab: 'results', query: SAVED_QUERY }, null);
  if (!created.ok) throw new Error(created.reason);
  viewId = created.view.id;
  revision = created.view.revision;
});

describe('the effective view', () => {
  it('is the saved view when the address names nothing but the view', async () => {
    const result = await effectiveView({ viewId, changes: new URLSearchParams('tab=results&view=x') });
    if (!result.ok) throw new Error('unavailable');
    expect(viewToSearchParams(result.view).toString()).toBe(SAVED_QUERY);
    expect(result.saved).toMatchObject({ id: viewId, revision });
  });

  it('puts the changes on top, replacing the part each names and leaving the rest as saved', async () => {
    const result = await effectiveView({ viewId, changes: new URLSearchParams('severity=low&q=&page=3') });
    if (!result.ok) throw new Error('unavailable');
    expect(filterValues(result.view.filters, 'severity')).toEqual(['low']);
    expect(filterValues(result.view.filters, 'subscription')).toEqual(['sub-a']);
    expect(result.view.search).toBe('');
    expect(result.view.page).toBe(3);
  });

  it('opens an old full-copy link as bookmarked and never widens it', async () => {
    const result = await effectiveView({ viewId, changes: new URLSearchParams(`tab=results&view=${viewId}&${SAVED_QUERY}`) });
    if (!result.ok) throw new Error('unavailable');
    expect(viewToSearchParams(result.view).toString()).toBe(SAVED_QUERY);
  });

  it('keeps a saved dimension an old link does not name instead of widening to all', async () => {
    const result = await effectiveView({ viewId, changes: new URLSearchParams('severity=low') });
    if (!result.ok) throw new Error('unavailable');
    expect(filterValues(result.view.filters, 'category')).toEqual(['security']);
    expect(filterValues(result.view.filters, 'subscription')).toEqual(['sub-a']);
  });

  it('never takes a page from a saved query written before the page was dropped, since the page is not a layer', async () => {
    const created = await createSavedView({ name: 'Old with a page', tab: 'results', query: 'severity=low&page=4' }, null);
    if (!created.ok) throw new Error(created.reason);
    const result = await effectiveView({ viewId: created.view.id, changes: new URLSearchParams() });
    if (!result.ok) throw new Error('unavailable');
    expect(result.view.page).toBe(1);
    expect(result.saved.view.page).toBe(1);
  });

  it('is unavailable for a view that never existed and one that was deleted, the same way', async () => {
    const unknown = await effectiveView({ viewId: 'no-such-view', changes: new URLSearchParams() });
    await deleteSavedView(viewId);
    const deleted = await effectiveView({ viewId, changes: new URLSearchParams() });
    expect(unknown).toEqual({ ok: false, reason: 'unavailable' });
    expect(deleted).toEqual(unknown);
  });
});

describe('reading a request', () => {
  it('is the plain View when no view is open', async () => {
    const request = await readViewRequest(new URLSearchParams('severity=low'));
    expect(request.ok && filterValues(request.value.view.filters, 'severity')).toEqual(['low']);
  });

  it('reads the tab and the suppressed flag as before, with the effective View in place of the query\'s own', async () => {
    const request = await readViewRequest(new URLSearchParams(`tab=advisories&suppressed=1&view=${viewId}&rev=${revision}&severity=low`));
    if (!request.ok) throw new Error(request.error);
    expect(request.value).toMatchObject({ tab: 'advisories', showSuppressed: true });
    expect(filterValues(request.value.view.filters, 'severity')).toEqual(['low']);
    expect(filterValues(request.value.view.filters, 'subscription')).toEqual(['sub-a']);
  });

  it('answers a bad tab with a 400 and an unavailable view with a 404', async () => {
    expect(await readViewRequest(new URLSearchParams(`tab=reports&view=${viewId}`))).toMatchObject({ ok: false, status: 400 });
    expect(await readViewRequest(new URLSearchParams('view=nope'))).toEqual({ ok: false, error: SAVED_VIEW_UNAVAILABLE, status: 404 });
  });
});

describe.each(Object.entries(routes))('GET /api/findings/%s with a view open', (name, GET) => {
  const url = (query: string) => `http://localhost/api/findings/${name}?${query}${EXTRA[name as keyof typeof routes]}`;
  const queryFn = { view: queries.queryView, rows: queries.queryFindingRows, group: queries.queryGroup, 'column-values': queries.queryColumnValues, export: queries.openExport }[name]!;

  it('reads the effective View the server assembled, not a copy from the browser', async () => {
    await GET(new Request(url(`tab=results&view=${viewId}&rev=${revision}&severity=low`)));
    const read = queryFn.mock.calls[0]![0] as { filters: { field: string; values: string[] }[]; search: string };
    expect(read.filters.find(f => f.field === 'severity')?.values).toEqual(['low']);
    expect(read.filters.find(f => f.field === 'subscription')?.values).toEqual(['sub-a']);
    expect(read.search).toBe('vm');
  });

  it('answers one 404 for a view that is not there and reads nothing', async () => {
    const res = await GET(new Request(url('tab=results&view=gone')));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: SAVED_VIEW_UNAVAILABLE });
    expect(queryFn).not.toHaveBeenCalled();
  });
});

describe('GET /api/findings/view', () => {
  it('answers with the list alone, whether or not a view is open', async () => {
    queries.queryView.mockResolvedValue({ total: 1 });
    const res = await routes.view(new Request(`http://localhost/api/findings/view?view=${viewId}&rev=${revision}`));
    expect(await res.json()).toEqual({ total: 1 });
  });

  it('adds nothing when no view is open', async () => {
    queries.queryView.mockResolvedValue({ total: 1 });
    const res = await routes.view(new Request('http://localhost/api/findings/view'));
    expect(await res.json()).toEqual({ total: 1 });
  });
});
