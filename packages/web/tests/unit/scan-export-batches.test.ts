/**
 * Issue #226: the snapshot and compare exports read each batch by key, after the last record of the
 * one before, never by offset. The contract is that for any query and any batch size the batches
 * together are the records the routes list page after page, in the same order, with none skipped or
 * repeated, and that every batch but the last is full. Driven through the two export functions over
 * scans stored by runCategoryScan().
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { scanFindings } from '@/lib/db/tables';
import { openSnapshotExport } from '@/lib/db/scan-snapshots';
import { openCompareExport } from '@/lib/db/scan-compare';
import { emptySnapshotQuery, snapshotQueryToParams, type SnapshotQuery } from '@/lib/snapshot-query';
import type { CompareResponse, CompareSide } from '@/lib/compare-response';
import type { SnapshotItem, SnapshotRecord, SnapshotResponse } from '@/lib/snapshot-response';
import type { OpenSnapshotExport } from '@/lib/snapshot-export';
import { resetDb } from '../helpers/db';
import { scan, type Seed } from '../helpers/stored-scans';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));

const snapshot = await import('@/app/api/scans/[id]/snapshot/route');
const compare = await import('@/app/api/scans/compare/route');

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);
const recordOf = ({ exists: _e, tab: _t, ...record }: SnapshotItem): SnapshotRecord => record;

/** Every record the snapshot route lists for the query, page after page. */
async function listedSnapshot(scanId: string, query: SnapshotQuery): Promise<SnapshotRecord[]> {
  const pageOf = async (page: number) => {
    const params = snapshotQueryToParams({ ...query, page });
    const res = await snapshot.GET(new Request(`http://localhost/api/scans/${scanId}/snapshot?${params}`), { params: Promise.resolve({ id: scanId }) });
    expect(res.status).toBe(200);
    return await res.json() as SnapshotResponse;
  };
  const first = await pageOf(1);
  const all = [...first.items];
  for (let page = 2; page <= first.pageCount; page += 1) all.push(...(await pageOf(page)).items);
  return all.map(recordOf);
}

/** Every record the compare route lists for one side, page after page. */
async function listedCompare(older: string, newer: string, side: CompareSide): Promise<SnapshotRecord[]> {
  const pageOf = async (page: number) => {
    const res = await compare.GET(new Request(`http://localhost/api/scans/compare?compare=${older}..${newer}&compareSide=${side}&comparePage=${page}`));
    expect(res.status).toBe(200);
    return await res.json() as CompareResponse;
  };
  const first = await pageOf(1);
  const all = [...first.items];
  for (let page = 2; page <= first.pageCount; page += 1) all.push(...(await pageOf(page)).items);
  return all.map(recordOf);
}

/** The batches an export yields, as the stream reads them. */
async function batchesOf(open: OpenSnapshotExport): Promise<SnapshotRecord[][]> {
  return open(async source => {
    const out: SnapshotRecord[][] = [];
    for await (const batch of source.batches()) out.push(batch);
    return out;
  });
}

/** The batches are full but for the last, none is empty, and together they are `expected`. */
function expectBatches(batches: SnapshotRecord[][], expected: SnapshotRecord[], batchSize: number): void {
  expect(batches.every(b => b.length > 0)).toBe(true);
  expect(batches.slice(0, -1).every(b => b.length === batchSize)).toBe(true);
  expect(batches.length).toBe(Math.ceil(expected.length / batchSize));
  expect(batches.flat()).toEqual(expected);
}

const BATCH_SIZES = [1, 2, 7];
const ALL = emptySnapshotQuery();

// One rule with many vms shares severity and title, so a boundary inside it advances on fingerprint alone.
const SHARED: Seed[] = [{ id: 'eb-many', name: 'many rule', severity: 'high', vms: names('vm', 120) }];
// Every severity, a title shared by two rules and one resource name found by several rules.
const MIXED: Seed[] = [
  { id: 'eb-crit', name: 'critical rule', severity: 'critical', vms: names('c', 3) },
  { id: 'eb-high', name: 'high rule', severity: 'high', vms: names('h', 4) },
  { id: 'eb-high2', name: 'high rule', severity: 'high', vms: names('h', 2) },
  { id: 'eb-med', name: 'medium rule', severity: 'medium', vms: names('m', 5) },
  { id: 'eb-low', name: 'low rule', severity: 'low', vms: names('l', 2) },
  { id: 'eb-info', name: 'info rule', severity: 'info', vms: names('i', 3) },
];
const MIXED_COUNT = 19;

beforeEach(async () => {
  await resetDb();
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
});

describe('openSnapshotExport: batches read by key', () => {
  it.each(BATCH_SIZES)('holds what the route lists, in its order, at batch size %i, across a run of one severity and title', async (batchSize) => {
    const { id } = await scan(SHARED);
    const expected = await listedSnapshot(id, ALL);
    expect(expected.length).toBe(120);
    expectBatches(await batchesOf(openSnapshotExport(id, ALL, { batchSize })), expected, batchSize);
  });

  it.each(BATCH_SIZES)('holds what the route lists at batch size %i across every severity', async (batchSize) => {
    const { id } = await scan(MIXED);
    const expected = await listedSnapshot(id, ALL);
    expect(expected.length).toBe(MIXED_COUNT);
    expect(new Set(expected.map(r => r.severity))).toEqual(new Set(['critical', 'high', 'medium', 'low', 'info']));
    expectBatches(await batchesOf(openSnapshotExport(id, ALL, { batchSize })), expected, batchSize);
  });

  it('starts a batch exactly where the severity changes', async () => {
    const { id } = await scan(MIXED);
    // 3 critical records, then 6 high: the first batch ends on the last critical one.
    const batches = await batchesOf(openSnapshotExport(id, ALL, { batchSize: 3 }));
    expect(batches[0]!.map(r => r.severity)).toEqual(['critical', 'critical', 'critical']);
    expect(batches[1]!.map(r => r.severity)).toEqual(['high', 'high', 'high']);
  });

  it.each([1, MIXED_COUNT])('yields no empty batch and no repeat when the count is a multiple of %i', async (batchSize) => {
    const { id } = await scan(MIXED);
    const expected = await listedSnapshot(id, ALL);
    const batches = await batchesOf(openSnapshotExport(id, ALL, { batchSize }));
    expect(expected.length % batchSize).toBe(0);
    expectBatches(batches, expected, batchSize);
    expect(new Set(batches.flat().map(r => r.fingerprint)).size).toBe(expected.length);
  });

  it('yields no empty batch when the count is a multiple of a batch size that is not 1', async () => {
    const { id } = await scan(SHARED);
    const expected = await listedSnapshot(id, ALL);
    const batches = await batchesOf(openSnapshotExport(id, ALL, { batchSize: 40 }));
    expect(batches.map(b => b.length)).toEqual([40, 40, 40]);
    expect(batches.flat()).toEqual(expected);
  });

  it.each(BATCH_SIZES)('holds what the route lists for a severity, rule and search together at batch size %i', async (batchSize) => {
    const { id } = await scan(MIXED);
    const query: SnapshotQuery = { severity: ['high', 'medium'], rule: ['eb-high', 'eb-med'], search: 'H-000', page: 1 };
    const expected = await listedSnapshot(id, query);
    expect(expected.length).toBeGreaterThan(1);
    expect(expected.length).toBeLessThan(MIXED_COUNT);
    expectBatches(await batchesOf(openSnapshotExport(id, query, { batchSize })), expected, batchSize);
  });

  it('yields nothing for a query nothing matches', async () => {
    const { id } = await scan(MIXED);
    expect(await batchesOf(openSnapshotExport(id, { ...ALL, search: 'no such resource' }, { batchSize: 2 }))).toEqual([]);
  });

  it.each(BATCH_SIZES)('exports a record whose severity is not one of the five, last, at batch size %i', async (batchSize) => {
    const { id } = await scan(MIXED);
    await execRun(db.update(scanFindings).set({ severity: 'unknown' }).where(and(eq(scanFindings.scanId, id), eq(scanFindings.ruleId, 'eb-crit'))));
    const expected = await listedSnapshot(id, ALL);
    expect(expected.slice(-3).map(r => r.severity)).toEqual(['unknown', 'unknown', 'unknown']);
    expectBatches(await batchesOf(openSnapshotExport(id, ALL, { batchSize })), expected, batchSize);
  });
});

describe('openCompareExport: batches read by key', () => {
  const BEFORE: Seed[] = [
    { id: 'eb-many', name: 'many rule', severity: 'high', vms: names('old', 11) },
    { id: 'eb-keep', name: 'keep rule', severity: 'low', vms: names('keep', 6) },
    { id: 'eb-info', name: 'info rule', severity: 'info', vms: names('i', 4) },
  ];
  const AFTER: Seed[] = [
    { id: 'eb-many', name: 'many rule', severity: 'high', vms: names('new', 60) },
    { id: 'eb-keep', name: 'keep rule', severity: 'low', vms: names('keep', 6) },
    { id: 'eb-crit', name: 'critical rule', severity: 'critical', vms: names('crit', 3) },
    { id: 'eb-med', name: 'medium rule', severity: 'medium', vms: names('m', 4) },
  ];

  it.each(['added', 'fixed', 'persisted'] as const)('holds what the route lists for the %s side at every batch size', async (side) => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const expected = await listedCompare(before.id, after.id, side);
    expect(expected.length).toBe({ added: 67, fixed: 15, persisted: 6 }[side]);
    for (const batchSize of [...BATCH_SIZES, expected.length, expected.length + 1]) {
      expectBatches(await batchesOf(openCompareExport(before.id, after.id, side, { batchSize })), expected, batchSize);
    }
  });

  it('yields nothing for an empty side', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(BEFORE, 1);
    expect(await batchesOf(openCompareExport(before.id, after.id, 'added', { batchSize: 2 }))).toEqual([]);
  });

  it('exports a record whose severity is not one of the five, last', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    await execRun(db.update(scanFindings).set({ severity: 'unknown' }).where(and(eq(scanFindings.scanId, after.id), eq(scanFindings.ruleId, 'eb-crit'))));
    const expected = await listedCompare(before.id, after.id, 'added');
    expect(expected.slice(-3).map(r => r.severity)).toEqual(['unknown', 'unknown', 'unknown']);
    expectBatches(await batchesOf(openCompareExport(before.id, after.id, 'added', { batchSize: 2 })), expected, 2);
  });
});
