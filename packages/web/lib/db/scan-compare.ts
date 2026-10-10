/**
 * The server side of a compare (ADR 0008): two past scans of one category set side by side, matched by
 * fingerprint, answered from their records in `scan_findings`. A finding in the newer scan only is Added,
 * in the older scan only is Fixed, and in both is Persisted, listed as the newer scan recorded it. Nothing
 * here reads the scans blob, so a compare of two scans of tens of thousands of findings costs a page.
 *
 * One read transaction answers a whole screen: the side's page and the totals of all three sides. Both
 * sides are a filtered, ordered, paged read of one scan's records, so they use the snapshot's own order
 * (`SCAN_FINDING_ORDER`, served by `idx_scan_findings_order` for one `scan_id`), and the other scan is
 * looked up by its primary key, `(scan_id, fingerprint)`. The database does the matching on both backends.
 */
import { and, count, eq, sql, type SQL } from 'drizzle-orm';
import { many, one, inReadTransaction, inSnapshotRead, type DbHandle } from './exec';
import { scanFindings } from './tables';
import { SCAN_FINDING_ORDER } from './scan-findings-copy';
import { readExisting, readHeader, toRecord } from './scan-snapshots';
import { pageBounds } from '../finding-rows';
import { COMPARE_PAGE_SIZE, type CompareQuery } from '../compare-query';
import type { CompareErrorCode, CompareResponse, CompareSide, CompareTotals } from '../compare-response';
import type { SnapshotItem, SnapshotScan } from '../snapshot-response';
import type { OpenSnapshotExport } from '../snapshot-export';
import { tabForKind } from '../view-response';
import type { RuleKind } from '../types';

/** Why two scans have nothing to compare, each with its own words and status in `COMPARE_ERRORS`. */
export type CompareAnswer =
  | { status: 'ok'; response: CompareResponse }
  | { status: Exclude<CompareErrorCode, 'bad-request' | 'no-records'> }
  | { status: 'no-records'; scan: SnapshotScan };

const t = scanFindings;

/** The two scans in the order they started, which is the one thing a compare says about them. */
interface ComparedPair { older: SnapshotScan; newer: SnapshotScan }

type PairRead = { status: 'ok'; pair: ComparedPair } | Exclude<CompareAnswer, { status: 'ok' }>;

const startedAtMs = (scan: SnapshotScan) => Date.parse(scan.startedAt);

/** Reads both scans' headers and decides which is older: the one that started first, and the one with
 *  the lower id when they started together, so the two orders of one pair are one compare. A scan that is
 *  unknown, that is of another category, or whose records were never stored is a compare with nothing to
 *  say, never a compare in which everything was added or fixed. */
async function readPair(tx: DbHandle, idA: string, idB: string): Promise<PairRead> {
  const a = await readHeader(tx, idA);
  const b = await readHeader(tx, idB);
  if (!a || !b) return { status: 'not-found' };
  if (a.scan.category !== b.scan.category) return { status: 'different-categories' };
  if (!a.hasRecords) return { status: 'no-records', scan: a.scan };
  if (!b.hasRecords) return { status: 'no-records', scan: b.scan };
  const aFirst = startedAtMs(a.scan) < startedAtMs(b.scan) || (startedAtMs(a.scan) === startedAtMs(b.scan) && a.scan.id <= b.scan.id);
  return { status: 'ok', pair: aFirst ? { older: a.scan, newer: b.scan } : { older: b.scan, newer: a.scan } };
}

/** Whether `fingerprint` of the outer record has a record in `otherScanId`, by the primary key. */
const inScan = (otherScanId: string, present: boolean): SQL =>
  sql`${sql.raw(present ? '' : 'NOT ')}EXISTS (SELECT 1 FROM scan_findings o WHERE o.scan_id = ${otherScanId} AND o.fingerprint = ${t.fingerprint})`;

/** The records on one side of the compare. */
function onSide(side: CompareSide, { older, newer }: ComparedPair): SQL {
  switch (side) {
    case 'added': return and(eq(t.scanId, newer.id), inScan(older.id, false))!;
    case 'fixed': return and(eq(t.scanId, older.id), inScan(newer.id, false))!;
    case 'persisted': return and(eq(t.scanId, newer.id), inScan(older.id, true))!;
  }
}

async function readCount(tx: DbHandle, where: SQL): Promise<number> {
  const row = await one(tx.select({ n: count() }).from(t).where(where));
  return Number(row?.n ?? 0);
}

/** All three totals: the persisted ones are counted by matching, the others are what is left of each scan. */
async function readTotals(tx: DbHandle, pair: ComparedPair): Promise<CompareTotals> {
  const persisted = await readCount(tx, onSide('persisted', pair));
  const newer = await readCount(tx, eq(t.scanId, pair.newer.id));
  const older = pair.older.id === pair.newer.id ? newer : await readCount(tx, eq(t.scanId, pair.older.id));
  return { added: newer - persisted, fixed: older - persisted, persisted };
}

/** The side's own scan: a persisted finding is listed as the newer scan recorded it. */
const readPage = (tx: DbHandle, side: CompareSide, pair: ComparedPair, offset: number, limit: number) =>
  many(tx.select().from(t).where(onSide(side, pair)).orderBy(sql.raw(SCAN_FINDING_ORDER)).limit(limit).offset(offset));

/** Two past scans compared: one page of one side, with the totals of all three. The ids may come in either order. */
export function queryCompare(idA: string, idB: string, query: CompareQuery): Promise<CompareAnswer> {
  return inReadTransaction(async (tx): Promise<CompareAnswer> => {
    const read = await readPair(tx, idA, idB);
    if (read.status !== 'ok') return read;
    const { pair } = read;

    const totals = await readTotals(tx, pair);
    const bounds = pageBounds(totals[query.side], query.page, COMPARE_PAGE_SIZE);
    const stored = await readPage(tx, query.side, pair, bounds.firstIndex, COMPARE_PAGE_SIZE);
    const existing = await readExisting(tx, stored.map(r => r.fingerprint));
    return {
      status: 'ok',
      response: {
        older: pair.older,
        newer: pair.newer,
        side: query.side,
        totals,
        page: bounds.page,
        pageCount: bounds.pageCount,
        pageSize: COMPARE_PAGE_SIZE,
        items: stored.map((r): SnapshotItem => ({
          ...toRecord(r),
          exists: existing.has(r.fingerprint),
          tab: tabForKind(r.kind as RuleKind),
        })),
      },
    };
  });
}

/** Records an export reads in one go. */
export const COMPARE_EXPORT_BATCH = 500;

/** An export of a compare that has nothing to list. Thrown before the first byte, so the route can still
 *  answer it with a status. */
export class CompareUnavailable extends Error {
  constructor(readonly code: 'not-found' | 'no-records' | 'different-categories') {
    super(code === 'not-found' ? 'A run was not found.' : code === 'no-records' ? 'A run has no stored findings.' : 'The runs are of different categories.');
  }
}

/**
 * The export of one side of a compare: every record on it (its page is ignored), in the compare's order,
 * `batchSize` at a time. Read inside one snapshot that stays open as long as the download reads
 * (lib/export-stream.ts), so the batches agree with one another and with the totals the screen showed.
 */
export function openCompareExport(idA: string, idB: string, side: CompareSide, opts: { batchSize?: number } = {}): OpenSnapshotExport {
  const batchSize = opts.batchSize ?? COMPARE_EXPORT_BATCH;
  return use => inSnapshotRead(async tx => {
    const read = await readPair(tx, idA, idB);
    if (read.status !== 'ok') throw new CompareUnavailable(read.status);
    const { pair } = read;
    return use({
      async *batches() {
        for (let offset = 0; ; offset += batchSize) {
          const stored = await readPage(tx, side, pair, offset, batchSize);
          if (stored.length > 0) yield stored.map(toRecord);
          if (stored.length < batchSize) return;
        }
      },
    });
  });
}
