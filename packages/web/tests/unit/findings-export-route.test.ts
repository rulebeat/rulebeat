/**
 * ADR 0007: what the export route does around the file itself (findings-export-parity.test.ts pins the
 * file): it refuses a caller who may not read before opening anything, answers a malformed query or a
 * missing format with a 400, and answers a failure before the first byte with the stable message,
 * never the error. The database module is mocked, so what the route asks of it is what is seen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { ExportSource, OpenExport } from '@/lib/export-stream';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));

const mockOpenExport = vi.fn<(view: unknown, query: unknown) => OpenExport>();
vi.mock('@/lib/db/finding-views', () => ({ openExport: (view: unknown, query: unknown) => mockOpenExport(view, query) }));

const route = await import('@/app/api/findings/export/route');

const get = (query: string) => route.GET(new Request(`http://localhost/api/findings/export${query ? `?${query}` : ''}`));

const finishedSource: ExportSource = {
  columns: async () => ({ evidenceKeys: [], lifecycle: false }),
  async *batches() { /* nothing to write */ },
};

beforeEach(() => {
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
  mockOpenExport.mockReturnValue(use => use(finishedSource));
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('GET /api/findings/export', () => {
  it('asks for read access first, and answers a refused caller without opening anything', async () => {
    mockRequireRole.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await get('format=csv');
    expect(res.status).toBe(401);
    expect(mockRequireRole).toHaveBeenCalledWith('read');
    expect(mockOpenExport).not.toHaveBeenCalled();
  });

  it('answers a tab that is neither results nor advisories with a 400', async () => {
    const res = await get('format=csv&tab=reports');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The tab must be results or advisories.' });
    expect(mockOpenExport).not.toHaveBeenCalled();
  });

  it.each(['', 'format=', 'format=xml', 'format=CSV', 'format=csv,json'])('answers a format of %j with a 400', async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The format must be csv or json.' });
    expect(mockOpenExport).not.toHaveBeenCalled();
  });

  it('hands the view, the tab and the suppressed flag the query holds to the database module', async () => {
    const res = await get('format=json&tab=advisories&suppressed=1&severity=high&q=alpha&sort=rule:desc');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[]');
    const [view, query] = mockOpenExport.mock.calls[0]!;
    expect(view).toMatchObject({ filters: [{ field: 'severity', values: ['high'] }], search: 'alpha', sort: { field: 'rule', dir: 'desc' } });
    expect(query).toEqual({ tab: 'advisories', showSuppressed: true });
  });

  it('reads the Results tab when none is given', async () => {
    await (await get('format=csv')).text();
    expect(mockOpenExport.mock.calls[0]![1]).toEqual({ tab: 'results', showSuppressed: false });
  });

  it('answers a failure before the first byte with the stable message, never the error itself', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockOpenExport.mockReturnValue(() => Promise.reject(new Error('connection to 10.1.2.3 refused for tenant 11111111-2222-3333-4444-555555555555')));
    const res = await get('format=csv');
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body).toEqual({ error: 'Could not export the findings. Check the RuleBeat server logs for details.' });
    expect(JSON.stringify(body)).not.toMatch(/10\.1\.2\.3|tenant/);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('sends a file only when it has one: an error answer is plain JSON that no browser names or saves as findings.csv', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockOpenExport.mockReturnValue(() => Promise.reject(new Error('boom')));
    const answers = [await get('format=xml'), await get('format=csv&tab=reports'), await get('format=csv')];
    expect(answers.map(r => r.status)).toEqual([400, 400, 500]);
    for (const res of answers) {
      expect(res.headers.get('Content-Disposition')).toBeNull();
      expect(res.headers.get('Content-Type')).toMatch(/^application\/json/);
    }
    // And the answer that is a file says so.
    mockOpenExport.mockReturnValue(use => use(finishedSource));
    const file = await get('format=csv');
    expect(file.headers.get('Content-Disposition')).toBe('attachment; filename="findings.csv"');
    await file.text();
  });

  it('answers a failure while reading the first rows the same way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockOpenExport.mockReturnValue(use => use({
      columns: async () => ({ evidenceKeys: [], lifecycle: true }),
      async *batches() { throw new Error('SQLITE_BUSY at 10.1.2.3'); },
    }));
    const res = await get('format=json');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/SQLITE|10\.1\.2\.3/);
  });
});
