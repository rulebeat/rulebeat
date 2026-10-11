import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from './client';
import { scans as scansTable } from './tables';
import { many } from './exec';
import { EMPTY_SCAN_BLOB } from './scan-findings-copy';
import { SCAN_HISTORY_LIMIT } from '../scan-history';
import type { Finding } from '../types';

/** What one stored scan's findings blob says, as the backfills replay it. */
export interface StoredScanBlob {
  finishedAt: string;
  totalRules: number;
  findings: Finding[];
}

/**
 * Every stored scan of a category with the findings its blob holds, newest first. Upgrade code only: the
 * two one-time backfills (lib/db/findings.ts and lib/db/snapshots.ts) rebuild finding and trend history
 * from the blobs of a database that predates those tables, and nothing else reads a blob (#219). The
 * upgrade empties the blobs only once both backfills have run, so a database that needs them still has
 * its blobs here.
 *
 * A scan with an empty blob and records is left out: its blob was emptied, or it was saved by this
 * release, which stores no blob (a Demo's first boot saves its scans before the backfills run). Its
 * blob is not what it found, and replaying it as a scan that found nothing would mark every open
 * finding Fixed. An empty blob with no records is a scan that found nothing, and is kept.
 */
export async function loadStoredScanBlobs(category: string): Promise<StoredScanBlob[]> {
  return (await many(db
    .select({ finishedAt: scansTable.finishedAt, totalRules: scansTable.totalRules, findings: scansTable.findings })
    .from(scansTable)
    .where(and(
      eq(scansTable.module, category),
      sql`NOT (${scansTable.findings} = ${EMPTY_SCAN_BLOB} AND EXISTS (SELECT 1 FROM scan_findings WHERE scan_findings.scan_id = ${scansTable.id}))`,
    ))
    .orderBy(desc(scansTable.startedAt))
    .limit(SCAN_HISTORY_LIMIT)))
    .map(row => ({
      finishedAt: row.finishedAt,
      totalRules: row.totalRules ?? 0,
      findings: JSON.parse(row.findings) as Finding[],
    }));
}
