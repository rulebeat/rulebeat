import { findingRows, type FindingRow } from '../finding-rows';

/**
 * Keeps `finding_rows` (ADR 0007) in step with the old row columns on every start.
 *
 * Before this table, a finding's rows were the JSON list in `findings.evidence_rows`, or for a
 * finding stored before rows existed, one row made from its evidence. Scans still fill those
 * columns for one release, so that moving back to the previous release loses nothing. That release
 * writes only the old columns, so a database that comes back from it holds findings whose rows in
 * the table are missing or out of date. The step below finds them and copies them again:
 *
 * - a finding with no `row_count` was stored by a release that did not write the table;
 * - a finding whose `rows_scan_id` is not its `last_scan_id` was rescanned by one.
 *
 * The first start after the upgrade copies every finding. Each copy writes exactly what the app read
 * before, one record per row in the same order, then reads the records back and proves they are that
 * and nothing else. Only then is the marker written, and only once it exists do reads come from the
 * table. A copy that does not prove out rolls back and is retried on the next start; until then the
 * old columns are still the whole truth. Records whose finding no longer exists are removed.
 *
 * Pure: rows in, records out, so SQLite (migrate.ts) and Postgres (pg/bootstrap.ts) execute one plan
 * rather than two implementations of it.
 */

export const FINDING_ROWS_COPY_MARKER = 'finding-rows-copied-v1';

const SOURCE_COLUMNS = `fingerprint, evidence, evidence_rows, last_scan_id`;
/** The findings to copy, before the marker exists: all of them. Plain SQL valid on both backends. */
export const ROW_COPY_READ_ALL = `SELECT ${SOURCE_COLUMNS} FROM findings`;
/** The findings to copy once it exists: those an earlier release stored or rescanned. */
export const ROW_COPY_READ_STALE = `SELECT ${SOURCE_COLUMNS} FROM findings
  WHERE row_count IS NULL OR (last_scan_id IS NOT NULL AND (rows_scan_id IS NULL OR rows_scan_id <> last_scan_id))`;
/** The read-back the proof compares. Unordered: Postgres sorts text by locale, so the proof sorts it. */
export const ROW_COPY_READ_BACK = `SELECT fingerprint, position, data FROM finding_rows`;
/** Records of findings that are gone, deleted by a release that did not know about the table. */
export const ROW_COPY_DELETE_ORPHANS = `DELETE FROM finding_rows WHERE fingerprint NOT IN (SELECT fingerprint FROM findings)`;

export interface RowCopySource {
  fingerprint: string;
  evidence: string | null;
  evidence_rows: string | null;
  last_scan_id: string | null;
}
export interface RowRecord { fingerprint: string; position: number; data: string }

function parse(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** The rows a finding reads as from its two old columns. A column that does not parse counts as
 *  absent, so a finding whose evidence is unreadable too gets no rows. */
export function storedRows(source: Pick<RowCopySource, 'evidence' | 'evidence_rows'>): FindingRow[] {
  const rows = parse(source.evidence_rows);
  const evidence = parse(source.evidence);
  return findingRows({
    evidence: evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence as FindingRow : {},
    rows: Array.isArray(rows) ? rows as FindingRow[] : undefined,
  });
}

export interface RowCopyPlan {
  /** The findings copied. Their existing records are replaced. */
  fingerprints: string[];
  /** Every record to insert, ordered by fingerprint then position, the order the proof compares in. */
  records: RowRecord[];
  /** What each copied finding's row columns are set to, including the findings that get no rows. */
  findings: { fingerprint: string; rowCount: number; rowsScanId: string | null }[];
}

const byFingerprint = (a: { fingerprint: string }, b: { fingerprint: string }) =>
  (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);

export function planRowCopy(sources: RowCopySource[]): RowCopyPlan {
  const sorted = [...sources].sort(byFingerprint);
  const records: RowRecord[] = [];
  const findings: RowCopyPlan['findings'] = [];
  for (const f of sorted) {
    const rows = storedRows(f);
    rows.forEach((row, position) => records.push({ fingerprint: f.fingerprint, position, data: JSON.stringify(row) }));
    findings.push({ fingerprint: f.fingerprint, rowCount: rows.length, rowsScanId: f.last_scan_id });
  }
  return { fingerprints: sorted.map(f => f.fingerprint), records, findings };
}

/** Why the copied findings' records, read back, are not exactly the plan, or null when they are.
 *  `readBack` may hold every finding's records; only the copied ones are compared. The proof is
 *  strict: the same records, the same text, the same order, nothing missing and nothing extra. */
export function rowCopyMismatch(plan: RowCopyPlan, readBack: RowRecord[]): string | null {
  const copied = new Set(plan.fingerprints);
  const got = readBack
    .filter(r => copied.has(r.fingerprint))
    .sort((a, b) => byFingerprint(a, b) || Number(a.position) - Number(b.position));
  if (got.length !== plan.records.length) {
    return `expected ${plan.records.length} rows, found ${got.length}`;
  }
  for (let i = 0; i < plan.records.length; i++) {
    const want = plan.records[i]!;
    const record = got[i]!;
    if (record.fingerprint !== want.fingerprint || Number(record.position) !== want.position || record.data !== want.data) {
      return `row ${want.position} of finding ${want.fingerprint} did not copy exactly`;
    }
  }
  return null;
}
