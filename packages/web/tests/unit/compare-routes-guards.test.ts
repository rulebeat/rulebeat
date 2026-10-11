/**
 * ADR 0008: what the two compare routes do around the answer itself (which scan-compare-route.test.ts
 * and scan-compare-export-route.test.ts pin): they refuse a caller who may not read before touching the
 * database, and never put a database error in front of the browser. The database module is stubbed, so
 * what each route asks of it, and in what order, is what the tests watch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));

const queries = vi.hoisted(() => ({ queryCompare: vi.fn(), openCompareExport: vi.fn() }));
vi.mock('@/lib/db/scan-compare', () => ({
  ...queries,
  CompareUnavailable: class extends Error {},
}));

const page = await import('@/app/api/scans/compare/route');
const exporter = await import('@/app/api/scans/compare/export/route');

type Route = { GET(req: Request): Promise<Response> };
const ROUTES: Array<{ name: string; route: Route; fn: ReturnType<typeof vi.fn>; path: string; message: RegExp }> = [
  { name: 'compare', route: page, fn: queries.queryCompare, path: 'compare', message: /^Could not compare these runs\./ },
  { name: 'compare/export', route: exporter, fn: queries.openCompareExport, path: 'compare/export', message: /^Could not export the findings of this compare\./ },
];
const call = (route: Route, path: string) =>
  route.GET(new Request(`http://localhost/api/scans/${path}?compare=run-1..run-2&format=csv`));

beforeEach(() => { mockRequireRole.mockResolvedValue({ id: 'viewer' }); });
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe.each(ROUTES)('GET /api/scans/$name', ({ route, fn, path, message }) => {
  it('asks for read access first, and answers a refused caller without touching the database', async () => {
    mockRequireRole.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await call(route, path);
    expect(res.status).toBe(401);
    expect(mockRequireRole).toHaveBeenCalledWith('read');
    expect(fn).not.toHaveBeenCalled();
  });

  it('answers a failed read with the stable message, never the error itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('connection to 10.1.2.3 refused for tenant 11111111-2222-3333-4444-555555555555');
    fn.mockImplementation(() => { throw failure; });
    const res = await call(route, path);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(message);
    expect(JSON.stringify(body)).not.toMatch(/10\.1\.2\.3|tenant/);
  });
});
