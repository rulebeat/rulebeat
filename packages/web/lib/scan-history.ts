import { eq, desc, inArray } from 'drizzle-orm';
import { db } from './db/client';
import { dbKind } from './db/backend';
import { scans as scansTable, scanFindings } from './db/tables';
import { many, run, inTransaction } from './db/exec';
import { chunk } from './db/chunk';
import { EMPTY_SCAN_BLOB, SCAN_FINDING_COLUMNS, recordsFromFindings } from './db/scan-findings-copy';
import type { ScanSummary, ScanMeta } from './types';

/** How many scans of a category history keeps (`SCAN_HISTORY_LIMIT`, default 90). */
export const SCAN_HISTORY_LIMIT = Math.max(2, Number(process.env.SCAN_HISTORY_LIMIT) || 90);

/** How many records one insert statement carries: as many as fit, a bound value for each column of a
 *  record, under SQLite's 900 bound values (the same budget as `CHUNK_SIZE`) or Postgres's 65,535. */
const RECORDS_PER_STATEMENT = Math.floor((dbKind === 'pg' ? 65_000 : 900) / SCAN_FINDING_COLUMNS.length);

type Row = typeof scansTable.$inferSelect;

const SCAN_META_COLUMNS = {
  id: scansTable.id,
  module: scansTable.module,
  startedAt: scansTable.startedAt,
  finishedAt: scansTable.finishedAt,
  durationMs: scansTable.durationMs,
  subscriptionsScanned: scansTable.subscriptionsScanned,
  counts: scansTable.counts,
  totalRules: scansTable.totalRules,
  triggeredBy: scansTable.triggeredBy,
  coverage: scansTable.coverage,
  incompleteRules: scansTable.incompleteRules,
};

function rowToScanMeta(row: Pick<Row, keyof typeof SCAN_META_COLUMNS>): ScanMeta {
  return {
    id: row.id,
    module: row.module,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    subscriptionsScanned: JSON.parse(row.subscriptionsScanned) as string[],
    counts: JSON.parse(row.counts) as ScanMeta['counts'],
    totalRules: row.totalRules ?? 0,
    triggeredBy: (row.triggeredBy as 'manual' | 'schedule' | undefined) ?? 'manual',
    coverage: (row.coverage as 'complete' | 'partial' | undefined) ?? 'complete',
    incompleteRules: row.incompleteRules
      ? (JSON.parse(row.incompleteRules) as ScanMeta['incompleteRules'])
      : [],
  };
}

/** The history list of a category, newest first. */
export async function listScanMetas(module: string, limit = 20): Promise<ScanMeta[]> {
  return (await many(db
    .select(SCAN_META_COLUMNS)
    .from(scansTable)
    .where(eq(scansTable.module, module))
    .orderBy(desc(scansTable.startedAt))
    .limit(limit)))
    .map(rowToScanMeta);
}

/** All per-category scan rows produced by a single run execution (schedule_runs.id): the
 *  Run History detail drill-down. */
export async function getScansForRun(runId: string): Promise<ScanMeta[]> {
  return (await many(db
    .select(SCAN_META_COLUMNS)
    .from(scansTable)
    .where(eq(scansTable.runId, runId))
    .orderBy(desc(scansTable.startedAt))))
    .map(rowToScanMeta);
}

export async function saveScanResult(
  module: string,
  summary: ScanSummary,
  opts: { triggeredBy?: 'manual' | 'schedule'; scheduleId?: string; id?: string; runId?: string } = {},
): Promise<void> {
  const id = opts.id ?? crypto.randomUUID();
  // ADR 0008: the scan row and its records are one write. If the records cannot be stored the scan is
  // not either, so a scan is never half saved. The records are all a scan keeps of its findings (#219):
  // the blob column is written empty, so the previous release still reads the scan.
  await inTransaction(async (tx) => {
    await run(tx.insert(scansTable).values({
      id,
      module: summary.module,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      durationMs: summary.durationMs,
      subscriptionsScanned: JSON.stringify(summary.subscriptionsScanned),
      findings: EMPTY_SCAN_BLOB,
      counts: JSON.stringify(summary.counts),
      totalRules: summary.totalRules,
      triggeredBy: opts.triggeredBy ?? 'manual',
      scheduleId: opts.scheduleId ?? null,
      runId: opts.runId ?? null,
      coverage: summary.coverage,
      incompleteRules: JSON.stringify(summary.incompleteRules),
      hasRecords: 1,
    }));

    const records = recordsFromFindings(id, summary.module, summary.findings).map(r => ({
      scanId: r.scan_id,
      fingerprint: r.fingerprint,
      ruleId: r.rule_id,
      severity: r.severity,
      title: r.title,
      kind: r.kind,
      category: r.category,
      resourceId: r.resource_id,
      resourceName: r.resource_name,
      resourceType: r.resource_type,
      resourceGroup: r.resource_group,
      subscriptionId: r.subscription_id,
      placement: r.placement,
      managementGroupId: r.management_group_id,
      rowCount: r.row_count,
    }));
    for (const part of chunk(records, RECORDS_PER_STATEMENT)) {
      await run(tx.insert(scanFindings).values(part));
    }
  });

  await pruneOldScans(module);
}

// --- helpers ---

async function pruneOldScans(module: string): Promise<void> {
  const rows = await many(db
    .select({ id: scansTable.id })
    .from(scansTable)
    .where(eq(scansTable.module, module))
    .orderBy(desc(scansTable.startedAt)));

  const expired = rows.slice(SCAN_HISTORY_LIMIT).map(row => row.id);
  if (expired.length === 0) return;

  // A scan goes with its records, in one transaction: one statement for each table, or one per
  // parameter-limit's worth of ids when a lowered SCAN_HISTORY_LIMIT expires many at once.
  await inTransaction(async (tx) => {
    for (const ids of chunk(expired)) {
      await run(tx.delete(scanFindings).where(inArray(scanFindings.scanId, ids)));
      await run(tx.delete(scansTable).where(inArray(scansTable.id, ids)));
    }
  });
}
