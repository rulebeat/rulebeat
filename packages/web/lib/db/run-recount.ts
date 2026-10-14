/**
 * Run History numbers for a person below Everything, counted from the per-finding records a scan keeps
 * (`scan_findings`) inside their access, never from the totals a run stored (#276). A run's stored
 * totals count every finding it saw, and one a person cannot see is not theirs to count.
 *
 * Where a scan has no records (`has_records = 0`) the count cannot be made, and the answer says so
 * instead of reading 0.
 */
import { and, count, inArray } from 'drizzle-orm';
import { many } from './exec';
import { chunk } from './chunk';
import { db } from './client';
import { scanFindings, scans as scansTable } from './tables';
import { accessFilterSql } from './access-filter';
import { emptySeverityCounts } from '../severity';
import type { Access } from '../access-model';
import type { Severity } from '../types';

/** What a run stored that a recount reads: its own id and status, and the fingerprints it recorded. */
export interface RunToRecount {
  id: string;
  status: string;
  totalFindings: number;
  newFindingFingerprints: string[];
  changedFingerprints: string[];
}

export interface RunRecount {
  totalFindings: number;
  newFindings: number;
  /** The new findings the person may read. */
  newFindingFingerprints: string[];
  /** The changed findings the person may read. */
  changedFingerprints: Set<string>;
  /** True when a scan of the run has no records, so the counts above could not be made. */
  unavailable: boolean;
}

interface ScanOfRun { id: string; hasRecords: boolean }

/** The scans each run produced, with whether their records exist. */
async function scansOfRuns(runIds: readonly string[]): Promise<Map<string, ScanOfRun[]>> {
  const byRun = new Map<string, ScanOfRun[]>();
  for (const ids of chunk(runIds)) {
    const rows = await many(db
      .select({ id: scansTable.id, runId: scansTable.runId, hasRecords: scansTable.hasRecords })
      .from(scansTable)
      .where(inArray(scansTable.runId, ids)));
    for (const row of rows) {
      const list = byRun.get(row.runId!) ?? [];
      list.push({ id: row.id, hasRecords: row.hasRecords === 1 });
      byRun.set(row.runId!, list);
    }
  }
  return byRun;
}

/** How many records each scan holds inside `access`. */
async function countsPerScan(scanIds: readonly string[], access: Access): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const ids of chunk(scanIds)) {
    const rows = await many(db
      .select({ scanId: scanFindings.scanId, n: count() })
      .from(scanFindings)
      .where(and(inArray(scanFindings.scanId, ids), accessFilterSql(access, scanFindings)))
      .groupBy(scanFindings.scanId));
    for (const row of rows) out.set(row.scanId, Number(row.n));
  }
  return out;
}

/** Which of these fingerprints have a record in one of these scans inside `access`. */
async function readableFingerprints(scanIds: readonly string[], fingerprints: readonly string[], access: Access): Promise<Set<string>> {
  const out = new Set<string>();
  if (scanIds.length === 0 || fingerprints.length === 0) return out;
  for (const scanChunk of chunk(scanIds, 100)) {
    for (const fpChunk of chunk(fingerprints, 400)) {
      const rows = await many(db
        .select({ fingerprint: scanFindings.fingerprint })
        .from(scanFindings)
        .where(and(inArray(scanFindings.scanId, scanChunk), inArray(scanFindings.fingerprint, fpChunk), accessFilterSql(access, scanFindings))));
      for (const row of rows) out.add(row.fingerprint);
    }
  }
  return out;
}

/**
 * Each run's total, new findings and readable fingerprints from the records of its scans inside `access`.
 * A run that has no scan linked to it, with findings stored on it, is unavailable too: it was recorded
 * before scans pointed back at their run, so there is nothing to recount it from.
 */
export async function recountRuns(runs: readonly RunToRecount[], access: Access): Promise<Map<string, RunRecount>> {
  const out = new Map<string, RunRecount>();
  if (runs.length === 0) return out;
  const scansByRun = await scansOfRuns(runs.map(r => r.id));
  const counts = await countsPerScan([...scansByRun.values()].flat().filter(s => s.hasRecords).map(s => s.id), access);

  for (const run of runs) {
    const scans = scansByRun.get(run.id) ?? [];
    const unavailable = scans.some(s => !s.hasRecords) || (scans.length === 0 && run.totalFindings > 0 && run.status !== 'running');
    if (unavailable) {
      out.set(run.id, { totalFindings: 0, newFindings: 0, newFindingFingerprints: [], changedFingerprints: new Set(), unavailable: true });
      continue;
    }
    const readable = await readableFingerprints(
      scans.map(s => s.id), [...new Set([...run.newFindingFingerprints, ...run.changedFingerprints])], access,
    );
    const newFindingFingerprints = run.newFindingFingerprints.filter(fp => readable.has(fp));
    out.set(run.id, {
      totalFindings: scans.reduce((sum, s) => sum + (counts.get(s.id) ?? 0), 0),
      newFindings: newFindingFingerprints.length,
      newFindingFingerprints,
      changedFingerprints: new Set(run.changedFingerprints.filter(fp => readable.has(fp))),
      unavailable: false,
    });
  }
  return out;
}

/** Each scan's severity counts from its records inside `access`. A scan with no records is not in the map. */
export async function recountScans(scans: readonly { id: string; hasRecords: boolean }[], access: Access): Promise<Map<string, Record<Severity, number>>> {
  const out = new Map<string, Record<Severity, number>>();
  const ids = scans.filter(s => s.hasRecords).map(s => s.id);
  for (const id of ids) out.set(id, emptySeverityCounts());
  for (const part of chunk(ids)) {
    const rows = await many(db
      .select({ scanId: scanFindings.scanId, severity: scanFindings.severity, n: count() })
      .from(scanFindings)
      .where(and(inArray(scanFindings.scanId, part), accessFilterSql(access, scanFindings)))
      .groupBy(scanFindings.scanId, scanFindings.severity));
    for (const row of rows) {
      const counts = out.get(row.scanId);
      if (counts && row.severity in counts) counts[row.severity as Severity] = Number(row.n);
    }
  }
  return out;
}
