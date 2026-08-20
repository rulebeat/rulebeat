import { eq, desc } from 'drizzle-orm';
import { db } from './db/client';
import { scans as scansTable } from './db/schema';
import type { ScanSummary, ScanMeta } from './types';

const MAX_HISTORY = Math.max(2, Number(process.env.SCAN_HISTORY_LIMIT) || 90);

export function loadScanHistory(module: string): ScanSummary[] {
  return db
    .select()
    .from(scansTable)
    .where(eq(scansTable.module, module))
    .orderBy(desc(scansTable.startedAt))
    .limit(MAX_HISTORY)
    .all()
    .map(rowToScanSummary);
}

export function getScanById(id: string): ScanSummary | null {
  const row = db.select().from(scansTable).where(eq(scansTable.id, id)).get();
  return row ? rowToScanSummary(row) : null;
}

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

/** History list without the findings blob — avoids deserializing every scan's full finding
 *  array just to render a clickable history list. */
export function listScanMetas(module: string, limit = 20): ScanMeta[] {
  return db
    .select(SCAN_META_COLUMNS)
    .from(scansTable)
    .where(eq(scansTable.module, module))
    .orderBy(desc(scansTable.startedAt))
    .limit(limit)
    .all()
    .map(rowToScanMeta);
}

/** All per-category scan rows produced by a single run execution (schedule_runs.id) — the
 *  Run History detail drill-down. Excludes the findings blob for the same reason as listScanMetas. */
export function getScansForRun(runId: string): ScanMeta[] {
  return db
    .select(SCAN_META_COLUMNS)
    .from(scansTable)
    .where(eq(scansTable.runId, runId))
    .orderBy(desc(scansTable.startedAt))
    .all()
    .map(rowToScanMeta);
}

export function saveScanResult(
  module: string,
  summary: ScanSummary,
  opts: { triggeredBy?: 'manual' | 'schedule'; scheduleId?: string; id?: string; runId?: string } = {},
): void {
  db.insert(scansTable).values({
    id: opts.id ?? crypto.randomUUID(),
    module: summary.module,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    durationMs: summary.durationMs,
    subscriptionsScanned: JSON.stringify(summary.subscriptionsScanned),
    findings: JSON.stringify(summary.findings),
    counts: JSON.stringify(summary.counts),
    totalRules: summary.totalRules,
    triggeredBy: opts.triggeredBy ?? 'manual',
    scheduleId: opts.scheduleId ?? null,
    runId: opts.runId ?? null,
    coverage: summary.coverage,
    incompleteRules: JSON.stringify(summary.incompleteRules),
  }).run();

  pruneOldScans(module);
}

// --- helpers ---

function rowToScanSummary(row: Row): ScanSummary {
  return {
    id: row.id,
    module: row.module,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    subscriptionsScanned: JSON.parse(row.subscriptionsScanned) as string[],
    findings: JSON.parse(row.findings) as ScanSummary['findings'],
    counts: JSON.parse(row.counts) as ScanSummary['counts'],
    totalRules: row.totalRules ?? 0,
    triggeredBy: (row.triggeredBy as 'manual' | 'schedule' | undefined) ?? 'manual',
    coverage: (row.coverage as 'complete' | 'partial' | undefined) ?? 'complete',
    incompleteRules: row.incompleteRules
      ? (JSON.parse(row.incompleteRules) as ScanSummary['incompleteRules'])
      : [],
  };
}

function pruneOldScans(module: string): void {
  const rows = db
    .select({ id: scansTable.id })
    .from(scansTable)
    .where(eq(scansTable.module, module))
    .orderBy(desc(scansTable.startedAt))
    .all();

  const toDelete = rows.slice(MAX_HISTORY);
  for (const row of toDelete) {
    db.delete(scansTable).where(eq(scansTable.id, row.id)).run();
  }
}
