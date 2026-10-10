import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core/finding';
import { findingRows, mergeFindingsByFingerprint, type FindingRow } from '../finding-rows';

/**
 * What a scan keeps of each finding (ADR 0008), and how a stored scan's blob becomes those records.
 *
 * A record is a finding's header as one scan saw it: no rows, no description, no remediation. The scan
 * path (`lib/scan-history.ts`) derives its records from the findings it is saving; the upgrade derives
 * the same records from the findings blob a scan stored. Both go through `recordsFromFindings()`, so a
 * finding cannot read one way when it is saved and another when it is converted.
 *
 * The one thing a blob does not hold reliably is the fingerprint. A blob written before the
 * case-insensitive formula carries the old value, and the scan path stores the current one, so the
 * conversion recomputes it from the finding's own fields with the same two formulas the scan path
 * uses (`findingFingerprint()`), then folds findings that now share one exactly as the scan does.
 *
 * Pure: blobs in, records out, so SQLite (migrate.ts) and Postgres (pg/bootstrap.ts) execute one plan.
 */

/** The columns of a record, in the order every insert writes them. */
export const SCAN_FINDING_COLUMNS = [
  'scan_id', 'fingerprint', 'rule_id', 'severity', 'title', 'kind', 'category',
  'resource_id', 'resource_name', 'resource_type', 'resource_group', 'subscription_id', 'row_count',
] as const;

/**
 * A scan's records in display order: severity from worst to least, then title, then fingerprint. The
 * severity is ranked rather than sorted as text, which would put "info" before "low" and "medium"
 * before "high". The same expression is the second part of the index on `scan_findings`, so a query
 * that orders by exactly this is served from it; anything else would sort.
 */
export const SCAN_FINDING_SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5 END`;
export const SCAN_FINDING_ORDER = `${SCAN_FINDING_SEVERITY_RANK}, title, fingerprint`;

/** Scans whose records are not written yet: every stored scan the first time, and any scan a
 *  release without this table saved since. Plain SQL valid on both backends. The blobs are not read
 *  here: they can be large, so each is read as its own scan converts. */
export const SCAN_COPY_READ_PENDING = `SELECT id, module FROM scans WHERE has_records = 0 ORDER BY started_at, id`;

/** Records of scans that are gone, left by a release that pruned scans without knowing the table. */
export const SCAN_COPY_DELETE_ORPHANS = `DELETE FROM scan_findings WHERE scan_id NOT IN (SELECT id FROM scans)`;

export interface ScanFindingRecord {
  scan_id: string;
  fingerprint: string;
  rule_id: string;
  severity: string;
  title: string;
  kind: string;
  category: string;
  resource_id: string | null;
  resource_name: string | null;
  resource_type: string | null;
  resource_group: string | null;
  subscription_id: string;
  row_count: number;
}

/** The parts of a finding a record is made from. A stored blob may lack any optional one. */
export interface RecordSource {
  ruleId: string;
  severity: string;
  title: string;
  fingerprint: string;
  subscriptionId?: string;
  kind?: string;
  dimensionKey?: string;
  resourceId?: string;
  resourceName?: string;
  resourceType?: string;
  resourceGroup?: string;
  evidence?: FindingRow | null;
  rows?: FindingRow[] | null;
}

/**
 * The fingerprint the scan path gives a finding: an activity finding has no resource, so it hashes
 * its rule and dimension key; every other kind (state, advisory) hashes its rule and resource id.
 */
export function findingFingerprint(f: Pick<RecordSource, 'ruleId' | 'kind' | 'dimensionKey' | 'resourceId'>): string {
  return f.kind === 'activity'
    ? computeActivityFingerprint(f.ruleId, f.dimensionKey ?? '')
    : computeFingerprint(f.ruleId, f.resourceId ?? '');
}

/** One record per finding. `category` is the scan's own category, as the findings table keeps it. */
export function recordsFromFindings(scanId: string, category: string, findings: readonly RecordSource[]): ScanFindingRecord[] {
  return findings.map(f => ({
    scan_id: scanId,
    fingerprint: f.fingerprint,
    rule_id: f.ruleId,
    severity: f.severity,
    title: f.title,
    kind: f.kind ?? 'state',
    category,
    resource_id: f.resourceId ?? null,
    resource_name: f.resourceName ?? null,
    resource_type: f.resourceType ?? null,
    resource_group: f.resourceGroup ?? null,
    subscription_id: f.subscriptionId ?? '',
    row_count: findingRows(f).length,
  }));
}

/** The values of one record, in `SCAN_FINDING_COLUMNS` order. */
export function recordValues(r: ScanFindingRecord): (string | number | null)[] {
  return SCAN_FINDING_COLUMNS.map(column => r[column]);
}

export type BlobPlan =
  | { ok: true; records: ScanFindingRecord[] }
  | { ok: false; reason: string };

const isText = (value: unknown): value is string => typeof value === 'string';

/**
 * The records a stored scan's blob converts to, or why it cannot be read. A blob that is not JSON, is
 * not a list, or holds an entry with no rule, severity or title is unreadable as a whole: the scan
 * gets no records rather than records made of guesses, and the caller leaves it unconverted.
 */
export function planScanBlob(scanId: string, category: string, blob: string): BlobPlan {
  let parsed: unknown;
  try { parsed = JSON.parse(blob); } catch { return { ok: false, reason: 'the stored findings are not valid JSON' }; }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'the stored findings are not a list' };
  const findings: RecordSource[] = [];
  for (const [index, entry] of parsed.entries()) {
    const f = entry as Partial<RecordSource> | null;
    if (f === null || typeof f !== 'object' || !isText(f.ruleId) || !isText(f.severity) || !isText(f.title)) {
      return { ok: false, reason: `finding ${index} has no rule, severity or title` };
    }
    findings.push({ ...f, ruleId: f.ruleId, severity: f.severity, title: f.title, fingerprint: findingFingerprint({ ...f, ruleId: f.ruleId }) });
  }
  return { ok: true, records: recordsFromFindings(scanId, category, mergeFindingsByFingerprint(findings)) };
}
