/**
 * The server side of a snapshot (ADR 0008): a past scan's findings, answered from its own records in
 * `scan_findings`. It never reads the scans blob, `finding_rows` or a finding's rows: a record is a
 * finding's header as that scan saw it, and the rows and the status belong to the live finding, which
 * the page only links to.
 *
 * One read transaction answers a whole screen: the page of records, the total for the filters, and the
 * severity and rule values with their counts. Filtering, searching, ordering and counting all run in
 * the database, on both backends, so a scan of tens of thousands of findings costs a page.
 */
import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { many, one, inReadTransaction, inSnapshotRead, type DbHandle } from './exec';
import { findings as findingsTable, scanFindings, scans as scansTable } from './tables';
import { SCAN_FINDING_ORDER } from './scan-findings-copy';
import { pageBounds } from '../finding-rows';
import { SNAPSHOT_PAGE_SIZE, type SnapshotQuery } from '../snapshot-query';
import type { SnapshotFacetValue, SnapshotItem, SnapshotRecord, SnapshotResponse, SnapshotScan } from '../snapshot-response';
import type { OpenSnapshotExport } from '../snapshot-export';
import { tabForKind } from '../view-response';
import type { RuleKind } from '../types';

/** Why a snapshot has nothing to list: the run is unknown or has aged out, or its records were never stored. */
export type SnapshotAnswer =
  | { status: 'ok'; response: SnapshotResponse }
  | { status: 'not-found' }
  | { status: 'no-records'; scan: SnapshotScan };

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const t = scanFindings;

/** `text` as the body of a LIKE pattern that matches it literally. */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, c => `\\${c}`);

/** Findings of this scan, narrowed by the filters a facet is not lifting. */
function matching(scanId: string, query: SnapshotQuery, lift?: 'severity' | 'rule'): SQL {
  const conditions: (SQL | undefined)[] = [eq(t.scanId, scanId)];
  if (query.severity.length > 0 && lift !== 'severity') conditions.push(inArray(t.severity, query.severity));
  if (query.rule.length > 0 && lift !== 'rule') conditions.push(inArray(t.ruleId, query.rule));
  const needle = query.search.trim().toLowerCase();
  if (needle !== '') {
    const pattern = `%${escapeLike(needle)}%`;
    const contains = (column: typeof t.title | typeof t.resourceName | typeof t.resourceType | typeof t.resourceId) =>
      sql`LOWER(${column}) LIKE ${pattern} ESCAPE '\\'`;
    conditions.push(sql`(${contains(t.resourceName)} OR ${contains(t.title)} OR ${contains(t.resourceType)} OR ${contains(t.resourceId)})`);
  }
  return and(...conditions)!;
}

export async function readHeader(tx: DbHandle, scanId: string): Promise<{ scan: SnapshotScan; hasRecords: boolean } | null> {
  const row = await one(tx.select({ id: scansTable.id, module: scansTable.module, startedAt: scansTable.startedAt, hasRecords: scansTable.hasRecords })
    .from(scansTable).where(eq(scansTable.id, scanId)));
  return row ? { scan: { id: row.id, category: row.module, startedAt: row.startedAt }, hasRecords: row.hasRecords === 1 } : null;
}

async function readTotal(tx: DbHandle, scanId: string, query: SnapshotQuery): Promise<number> {
  const row = await one(tx.select({ n: count() }).from(t).where(matching(scanId, query)));
  return Number(row?.n ?? 0);
}

async function readPage(tx: DbHandle, scanId: string, query: SnapshotQuery, offset: number) {
  return many(tx.select().from(t).where(matching(scanId, query))
    .orderBy(sql.raw(SCAN_FINDING_ORDER)).limit(SNAPSHOT_PAGE_SIZE).offset(offset));
}

/** Which of these fingerprints a finding still exists for, whatever its status. */
export async function readExisting(tx: DbHandle, fingerprints: readonly string[]): Promise<Set<string>> {
  if (fingerprints.length === 0) return new Set();
  const rows = await many(tx.select({ fingerprint: findingsTable.fingerprint }).from(findingsTable)
    .where(inArray(findingsTable.fingerprint, [...fingerprints])));
  return new Set(rows.map(r => r.fingerprint));
}

async function readSeverityFacet(tx: DbHandle, scanId: string, query: SnapshotQuery): Promise<SnapshotFacetValue[]> {
  const rows = await many(tx.select({ value: t.severity, n: count() }).from(t)
    .where(matching(scanId, query, 'severity')).groupBy(t.severity));
  return rows
    .map(r => ({ value: r.value, label: r.value, count: Number(r.n) }))
    .sort((a, b) => rank(a.value) - rank(b.value));
}
const rank = (severity: string) => {
  const at = SEVERITY_ORDER.indexOf(severity);
  return at === -1 ? SEVERITY_ORDER.length : at;
};

async function readRuleFacet(tx: DbHandle, scanId: string, query: SnapshotQuery): Promise<SnapshotFacetValue[]> {
  const rows = await many(tx.select({ value: t.ruleId, label: sql<string>`MIN(${t.title})`, n: count() }).from(t)
    .where(matching(scanId, query, 'rule')).groupBy(t.ruleId));
  return rows
    .map(r => ({ value: r.value, label: r.label, count: Number(r.n) }))
    .sort((a, b) => a.label.localeCompare(b.label) || (a.value < b.value ? -1 : 1));
}

/** Records an export reads in one go. */
export const SNAPSHOT_EXPORT_BATCH = 500;

/** An export of a run that has no records to list: it is unknown or aged out, or none were stored. Thrown
 *  before the first byte, so the route can still answer it with a status. */
export class SnapshotUnavailable extends Error {
  constructor(readonly code: 'not-found' | 'no-records') {
    super(code === 'not-found' ? 'The run was not found.' : 'The run has no stored findings.');
  }
}

export const toRecord = (r: typeof t.$inferSelect): SnapshotRecord => ({
  fingerprint: r.fingerprint, ruleId: r.ruleId, severity: r.severity, title: r.title, kind: r.kind,
  resourceId: r.resourceId, resourceName: r.resourceName, resourceType: r.resourceType, resourceGroup: r.resourceGroup,
  subscriptionId: r.subscriptionId, rowCount: r.rowCount,
});

/**
 * The export of a snapshot: every record that matches the query's filters and search (its page is
 * ignored), in the snapshot's order, `batchSize` at a time. Read inside one snapshot that stays open as
 * long as the download reads (lib/export-stream.ts), so the batches agree with one another.
 */
export function openSnapshotExport(scanId: string, query: SnapshotQuery, opts: { batchSize?: number } = {}): OpenSnapshotExport {
  const batchSize = opts.batchSize ?? SNAPSHOT_EXPORT_BATCH;
  return use => inSnapshotRead(async tx => {
    const header = await readHeader(tx, scanId);
    if (!header) throw new SnapshotUnavailable('not-found');
    if (!header.hasRecords) throw new SnapshotUnavailable('no-records');
    return use({
      async *batches() {
        for (let offset = 0; ; offset += batchSize) {
          const stored = await many(tx.select().from(t).where(matching(scanId, query))
            .orderBy(sql.raw(SCAN_FINDING_ORDER)).limit(batchSize).offset(offset));
          if (stored.length > 0) yield stored.map(toRecord);
          if (stored.length < batchSize) return;
        }
      },
    });
  });
}

/** A past scan's findings, one page of them, with the total and the facets for the query. */
export function querySnapshot(scanId: string, query: SnapshotQuery): Promise<SnapshotAnswer> {
  return inReadTransaction(async (tx): Promise<SnapshotAnswer> => {
    const header = await readHeader(tx, scanId);
    if (!header) return { status: 'not-found' };
    if (!header.hasRecords) return { status: 'no-records', scan: header.scan };

    const total = await readTotal(tx, scanId, query);
    const bounds = pageBounds(total, query.page, SNAPSHOT_PAGE_SIZE);
    const stored = await readPage(tx, scanId, query, bounds.firstIndex);
    const existing = await readExisting(tx, stored.map(r => r.fingerprint));
    return {
      status: 'ok',
      response: {
        scan: header.scan,
        total,
        page: bounds.page,
        pageCount: bounds.pageCount,
        pageSize: SNAPSHOT_PAGE_SIZE,
        items: stored.map((r): SnapshotItem => ({
          ...toRecord(r),
          exists: existing.has(r.fingerprint),
          tab: tabForKind(r.kind as RuleKind),
        })),
        facets: { severity: await readSeverityFacet(tx, scanId, query), rule: await readRuleFacet(tx, scanId, query) },
      },
    };
  });
}
