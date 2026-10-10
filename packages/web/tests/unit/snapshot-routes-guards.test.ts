/**
 * ADR 0008: what the two snapshot routes do around the answer itself (which scan-snapshot-route.test.ts
 * and snapshot-export-route.test.ts pin): they refuse a caller who may not read before touching the
 * database, and never put a database error in front of the browser. The database module is stubbed, so
 * what each route asks of it, and in what order, is what the tests watch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));

const queries = vi.hoisted(() => ({ querySnapshot: vi.fn(), openSnapshotExport: vi.fn() }));
vi.mock('@/lib/db/scan-snapshots', () => ({
  ...queries,
  SnapshotUnavailable: class extends Error {},
}));

const page = await import('@/app/api/scans/[id]/snapshot/route');
const exporter = await import('@/app/api/scans/[id]/snapshot/export/route');

type Route = { GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> };
const ROUTES: Array<{ name: string; route: Route; fn: ReturnType<typeof vi.fn>; path: string; message: RegExp }> = [
  { name: 'snapshot', route: page, fn: queries.querySnapshot, path: 'snapshot', message: /^Could not load the findings of this run\./ },
  { name: 'snapshot/export', route: exporter, fn: queries.openSnapshotExport, path: 'snapshot/export?format=csv', message: /^Could not export the findings of this run\./ },
];
const call = (route: Route, path: string) =>
  route.GET(new Request(`http://localhost/api/scans/run-1/${path}`), { params: Promise.resolve({ id: 'run-1' }) });

beforeEach(() => { mockRequireRole.mockResolvedValue({ id: 'viewer' }); });
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe.each(ROUTES)('GET /api/scans/[id]/$name', ({ route, fn, path, message }) => {
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
