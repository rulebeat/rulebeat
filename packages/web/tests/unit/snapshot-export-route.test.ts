/**
 * Issue #217 (ADR 0008): the snapshot export streams the records that match a query as CSV or JSON,
 * the same records the snapshot route lists, with the human headers the screen shows and the row count.
 * Driven through both routes over scans stored by runCategoryScan(), so parity is between what the screen
 * is shown and what the file holds for one query string.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { scans as scansTable } from '@/lib/db/tables';
import { SNAPSHOT_COLUMNS, SNAPSHOT_EXPORT_COLUMNS, SNAPSHOT_ERRORS, type SnapshotItem, type SnapshotResponse } from '@/lib/snapshot-response';
import { addSuppression } from '@/lib/suppressions';
import { resetDb } from '../helpers/db';
import { scan, type Seed } from '../helpers/stored-scans';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));

const snapshot = await import('@/app/api/scans/[id]/snapshot/route');
const exporter = await import('@/app/api/scans/[id]/snapshot/export/route');

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);

const MIXED: Seed[] = [
  { id: 'exp-low', name: 'low rule', severity: 'low', vms: ['vm-a'] },
  { id: 'exp-crit', name: 'critical rule', severity: 'critical', vms: ['vm-a', 'vm-b'] },
  { id: 'exp-med', name: 'medium rule', severity: 'medium', vms: ['vm-a', 'vm-b', 'vm-c'] },
  { id: 'exp-high', name: 'high rule', severity: 'high', vms: ['vm-b'] },
];

const exportOf = (scanId: string, query: string, format = 'json') =>
  exporter.GET(new Request(`http://localhost/api/scans/${scanId}/snapshot/export?${query ? `${query}&` : ''}format=${format}`), {
    params: Promise.resolve({ id: scanId }),
  });
const pageOf = async (scanId: string, query: string): Promise<SnapshotResponse> => {
  const res = await snapshot.GET(new Request(`http://localhost/api/scans/${scanId}/snapshot?${query}`), { params: Promise.resolve({ id: scanId }) });
  expect(res.status).toBe(200);
  return await res.json() as SnapshotResponse;
};

type Record = Omit<SnapshotItem, 'exists' | 'tab'>;
const recordOf = ({ exists: _e, tab: _t, ...record }: SnapshotItem): Record => record;

/** Every record the snapshot route lists for the query, page after page. */
async function listed(scanId: string, query: string): Promise<Record[]> {
  const first = await pageOf(scanId, query);
  const all = [...first.items];
  for (let page = 2; page <= first.pageCount; page += 1) all.push(...(await pageOf(scanId, `${query}${query ? '&' : ''}snapPage=${page}`)).items);
  return all.map(recordOf);
}

/** A CSV text as its rows of cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

beforeEach(async () => {
  await resetDb();
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
});

describe('GET /api/scans/[id]/snapshot/export: JSON', () => {
  it('holds the records of every page of the route, in the route\'s order', async () => {
    const summary = await scan([{ id: 'exp-many', name: 'many rule', severity: 'high', vms: names('vm', 120) }, ...MIXED]);
    const res = await exportOf(summary.id, '');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="snapshot.json"');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const file = JSON.parse(await res.text()) as Record[];
    const expected = await listed(summary.id, '');
    expect(expected.length).toBe(127);
    expect(file).toEqual(expected);
  });

  it('holds exactly what the route lists for the same filters and search', async () => {
    const summary = await scan([{ id: 'exp-many', name: 'many rule', severity: 'high', vms: names('vm', 120) }, ...MIXED]);
    for (const query of ['snapSeverity=critical&snapSeverity=medium', 'snapRule=exp-med', 'snapQ=vm-00', 'snapSeverity=high&snapRule=exp-many&snapQ=vm-01']) {
      const file = JSON.parse(await (await exportOf(summary.id, query)).text()) as Record[];
      expect(file, query).toEqual(await listed(summary.id, query));
      expect(file.length, query).toBeGreaterThan(0);
    }
  });

  it('is every matching record whatever page the address names', async () => {
    const summary = await scan([{ id: 'exp-many', name: 'many rule', severity: 'high', vms: names('vm', 120) }]);
    const file = JSON.parse(await (await exportOf(summary.id, 'snapPage=3')).text()) as Record[];
    expect(file).toHaveLength(120);
  });

  it('keeps a finding that is suppressed now', async () => {
    const summary = await scan(MIXED);
    const first = (await listed(summary.id, 'snapRule=exp-high'))[0]!;
    await addSuppression({ id: 'sup-1', fingerprint: first.fingerprint, resourceId: first.resourceId ?? '', reason: 'accepted', suppressedAt: new Date().toISOString() });
    const file = JSON.parse(await (await exportOf(summary.id, 'snapRule=exp-high')).text()) as Record[];
    expect(file.map(r => r.fingerprint)).toEqual([first.fingerprint]);
  });

  it('is an empty array for a run that found nothing', async () => {
    const summary = await scan([{ id: 'exp-none', name: 'none rule', severity: 'low', vms: [] }]);
    const res = await exportOf(summary.id, '');
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual([]);
  });

  it('is an empty array when the filters match nothing', async () => {
    const summary = await scan(MIXED);
    expect(JSON.parse(await (await exportOf(summary.id, 'snapQ=zzz-nothing')).text())).toEqual([]);
  });
});

describe('GET /api/scans/[id]/snapshot/export: CSV', () => {
  it('has the screen\'s column headers first, then the export-only columns, and one line a record', async () => {
    const summary = await scan(MIXED);
    const res = await exportOf(summary.id, '', 'csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="snapshot.csv"');
    const [header, ...lines] = parseCsv(await res.text());
    expect(header).toEqual(SNAPSHOT_EXPORT_COLUMNS.map(c => c.header));
    expect(header!.slice(0, SNAPSHOT_COLUMNS.length)).toEqual(SNAPSHOT_COLUMNS.map(c => c.header));
    expect(header).toContain('Rows');
    expect(lines).toHaveLength(7);
  });

  it('writes each record\'s fields under its header, the same records as the JSON', async () => {
    const summary = await scan(MIXED);
    const expected = await listed(summary.id, 'snapSeverity=critical&snapSeverity=medium');
    const [header, ...lines] = parseCsv(await (await exportOf(summary.id, 'snapSeverity=critical&snapSeverity=medium', 'csv')).text());
    const records = lines.map(cells => Object.fromEntries(SNAPSHOT_EXPORT_COLUMNS.map((c, i) => [c.key, cells[i]!])));
    expect(header).toHaveLength(SNAPSHOT_EXPORT_COLUMNS.length);
    expect(records.map(r => r.fingerprint)).toEqual(expected.map(r => r.fingerprint));
    expect(records.map(r => r.rowCount)).toEqual(expected.map(r => String(r.rowCount)));
    expect(records.map(r => r.title)).toEqual(expected.map(r => r.title));
    expect(records.map(r => r.resourceId)).toEqual(expected.map(r => r.resourceId ?? ''));
    expect(records.map(r => r.severity)).toEqual(expected.map(r => r.severity));
  });

  it('is only the header for a run that found nothing', async () => {
    const summary = await scan([{ id: 'exp-none', name: 'none rule', severity: 'low', vms: [] }]);
    const text = await (await exportOf(summary.id, '', 'csv')).text();
    expect(parseCsv(text)).toEqual([SNAPSHOT_EXPORT_COLUMNS.map(c => c.header)]);
  });

  it('quotes a cell a spreadsheet would read as a formula', async () => {
    const summary = await scan([{ id: 'exp-formula', name: 'formula rule', severity: 'low', vms: ['=cmd'] }]);
    const [, line] = parseCsv(await (await exportOf(summary.id, '', 'csv')).text());
    const resource = SNAPSHOT_EXPORT_COLUMNS.findIndex(c => c.key === 'resourceName');
    expect(line![resource]).toBe("'=cmd");
  });
});

describe('GET /api/scans/[id]/snapshot/export: streaming', () => {
  it.each(['csv', 'json'] as const)('sends the first batch while later ones are still unread (%s)', async (format) => {
    const summary = await scan([{ id: 'exp-big', name: 'big rule', severity: 'high', vms: names('big', 1100) }]);
    const res = await exportOf(summary.id, '', format);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const firstText = decoder.decode(first.value);
    const named = (text: string) => new Set(text.match(/big-\d{4}/g)).size;
    // Nothing has been taken from the body since, so the rest of the file has not been read.
    expect(named(firstText)).toBeGreaterThan(0);
    expect(named(firstText)).toBeLessThan(1100);
    let text = firstText;
    for (let r = await reader.read(); !r.done; r = await reader.read()) text += decoder.decode(r.value);
    expect(named(text)).toBe(1100);
  });
});

describe('GET /api/scans/[id]/snapshot/export: what it refuses', () => {
  it.each(['', 'format=xml', 'format='])('answers 400 for a format that is not csv or json (%s)', async (query) => {
    const summary = await scan(MIXED);
    const res = await exporter.GET(new Request(`http://localhost/api/scans/${summary.id}/snapshot/export${query ? `?${query}` : ''}`), {
      params: Promise.resolve({ id: summary.id }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it('answers a run that is unknown or aged out with the 404 and message the route gives', async () => {
    const res = await exportOf('no-such-run', '');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(SNAPSHOT_ERRORS['not-found'].body);
  });

  it('answers a run whose records were never stored with the 409 and message the route gives', async () => {
    const summary = await scan(MIXED);
    await execRun(db.update(scansTable).set({ hasRecords: 0 }).where(eq(scansTable.id, summary.id)));
    const res = await exportOf(summary.id, '');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(SNAPSHOT_ERRORS['no-records'].body);
  });
});
