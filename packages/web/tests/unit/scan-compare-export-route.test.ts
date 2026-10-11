/**
 * Issue #218 (ADR 0008): the compare export streams one side of a compare as CSV or JSON, the same
 * records the compare route lists for that side, with the snapshot export's columns. Driven through both
 * routes over scans stored by runCategoryScan(), so parity is between what the screen is shown and what
 * the file holds for one query string.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { scans as scansTable } from '@/lib/db/tables';
import { COMPARE_ERRORS, type CompareResponse } from '@/lib/compare-response';
import { SNAPSHOT_EXPORT_COLUMNS, type SnapshotItem } from '@/lib/snapshot-response';
import { resetDb } from '../helpers/db';
import { scan, type Seed } from '../helpers/stored-scans';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));

const compareRoute = await import('@/app/api/scans/compare/route');
const exporter = await import('@/app/api/scans/compare/export/route');

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);

const BEFORE: Seed[] = [
  { id: 'cx-many', name: 'many rule', severity: 'high', vms: names('old', 30) },
  { id: 'cx-keep', name: 'keep rule', severity: 'low', vms: names('keep', 5) },
];
const AFTER: Seed[] = [
  { id: 'cx-many', name: 'many rule', severity: 'high', vms: names('new', 120) },
  { id: 'cx-keep', name: 'keep rule', severity: 'low', vms: names('keep', 5) },
  { id: 'cx-crit', name: 'critical rule', severity: 'critical', vms: names('crit', 3) },
];

const exportOf = (query: string, format = 'json') =>
  exporter.GET(new Request(`http://localhost/api/scans/compare/export?${query}&format=${format}`));
const pageOf = async (query: string): Promise<CompareResponse> => {
  const res = await compareRoute.GET(new Request(`http://localhost/api/scans/compare?${query}`));
  expect(res.status).toBe(200);
  return await res.json() as CompareResponse;
};

type Record = Omit<SnapshotItem, 'exists' | 'tab'>;
const recordOf = ({ exists: _e, tab: _t, ...record }: SnapshotItem): Record => record;

/** Every record the compare route lists for the query, page after page. */
async function listed(query: string): Promise<Record[]> {
  const first = await pageOf(query);
  const all = [...first.items];
  for (let page = 2; page <= first.pageCount; page += 1) all.push(...(await pageOf(`${query}&comparePage=${page}`)).items);
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

describe('GET /api/scans/compare/export: JSON', () => {
  it.each(['added', 'fixed', 'persisted'] as const)('holds every record of the %s side, in the route\'s order', async (side) => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const query = `compare=${before.id}..${after.id}&compareSide=${side}`;
    const res = await exportOf(query);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="compare-${side}.json"`);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const file = JSON.parse(await res.text()) as Record[];
    const expected = await listed(query);
    expect(expected.length).toBe({ added: 123, fixed: 30, persisted: 5 }[side]);
    expect(file).toEqual(expected);
  });

  it('is the Added side when the address names no side', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const res = await exportOf(`compare=${before.id}..${after.id}`);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="compare-added.json"');
    expect(JSON.parse(await res.text())).toHaveLength(123);
  });

  it('is every record of the side whatever page the address names, and whichever order the ids came in', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const forward = JSON.parse(await (await exportOf(`compare=${before.id}..${after.id}&compareSide=added&comparePage=3`)).text()) as Record[];
    const backward = JSON.parse(await (await exportOf(`compare=${after.id}..${before.id}&compareSide=added`)).text()) as Record[];
    expect(forward).toHaveLength(123);
    expect(backward).toEqual(forward);
  });

  it('is an empty array for a side with nothing on it', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(BEFORE, 1);
    const res = await exportOf(`compare=${before.id}..${after.id}&compareSide=added`);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual([]);
  });
});

describe('GET /api/scans/compare/export: CSV', () => {
  it('has the snapshot export\'s columns and one line a record of the side', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const query = `compare=${before.id}..${after.id}&compareSide=persisted`;
    const res = await exportOf(query, 'csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="compare-persisted.csv"');
    const [header, ...lines] = parseCsv(await res.text());
    expect(header).toEqual(SNAPSHOT_EXPORT_COLUMNS.map(c => c.header));
    const expected = await listed(query);
    expect(lines).toHaveLength(5);
    const records = lines.map(cells => Object.fromEntries(SNAPSHOT_EXPORT_COLUMNS.map((c, i) => [c.key, cells[i]!])));
    expect(records.map(r => r.fingerprint)).toEqual(expected.map(r => r.fingerprint));
  });

  it('is only the header for a side with nothing on it', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(BEFORE, 1);
    const text = await (await exportOf(`compare=${before.id}..${after.id}&compareSide=fixed`, 'csv')).text();
    expect(parseCsv(text)).toEqual([SNAPSHOT_EXPORT_COLUMNS.map(c => c.header)]);
  });
});

describe('GET /api/scans/compare/export: streaming', () => {
  it.each(['csv', 'json'] as const)('sends the first batch while later ones are still unread (%s)', async (format) => {
    const before = await scan([{ id: 'cx-old', name: 'old rule', severity: 'low', vms: ['gone'] }], 0);
    const after = await scan([{ id: 'cx-big', name: 'big rule', severity: 'high', vms: names('big', 1100) }], 1);
    const res = await exportOf(`compare=${before.id}..${after.id}&compareSide=added`, format);
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

describe('GET /api/scans/compare/export: what it refuses', () => {
  it.each(['', 'format=xml', 'format='])('answers 400 for a format that is not csv or json (%s)', async (query) => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const res = await exporter.GET(new Request(`http://localhost/api/scans/compare/export?compare=${before.id}..${after.id}${query ? `&${query}` : ''}`));
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it.each(['', 'compare=only-one', 'compare=a..b..c'])('answers 400 for ids that are not two (%s)', async (query) => {
    const res = await exportOf(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(COMPARE_ERRORS['bad-request'].body);
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it('answers a scan that is unknown or aged out with the 404 the compare route gives', async () => {
    const before = await scan(BEFORE, 0);
    const res = await exportOf(`compare=${before.id}..no-such-scan`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(COMPARE_ERRORS['not-found'].body);
  });

  it('answers two scans of different categories with the status and message the compare route gives', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    await execRun(db.update(scansTable).set({ module: 'security' }).where(eq(scansTable.id, after.id)));
    const res = await exportOf(`compare=${before.id}..${after.id}`);
    expect(res.status).toBe(COMPARE_ERRORS['different-categories'].status);
    expect(await res.json()).toEqual(COMPARE_ERRORS['different-categories'].body);
  });

  it('answers a scan whose records were never stored with the 409 the compare route gives, not a file of everything', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    await execRun(db.update(scansTable).set({ hasRecords: 0 }).where(eq(scansTable.id, before.id)));
    const res = await exportOf(`compare=${before.id}..${after.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(COMPARE_ERRORS['no-records'].body);
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });
});
