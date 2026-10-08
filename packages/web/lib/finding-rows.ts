/**
 * A finding holds every Row its rule's query returned for its resource (ADR 0006). A Row is the
 * object stored as the finding's evidence; `evidence` itself keeps the first Row so every older
 * reader keeps working. Pure and client-safe: the server read path, the explorer, Run History and
 * the CSV export all resolve a finding's rows through here.
 */

export type FindingRow = Record<string, unknown>;

/** A finding that was open before a scan, is still returned, and gained rows it did not have (#193):
 *  its fingerprint and only the gained rows, never a lost one. The one record shape the sync returns,
 *  a run stores for its notification outbox and the executor passes along; the notification layer
 *  pairs it with the finding itself (`ChangedFindingDetail` in lib/types.ts). */
export interface ChangedFinding {
  fingerprint: string;
  addedRows: FindingRow[];
}

interface HasRows {
  evidence?: FindingRow | null;
  rows?: FindingRow[] | null;
}

function isEmptyRow(row: FindingRow | null | undefined): boolean {
  return !row || Object.keys(row).length === 0;
}

/** The rows of a finding, in query order. A finding stored before rows existed has none, and reads
 *  as one row made from its evidence; with neither, it has no rows. */
export function findingRows(finding: HasRows): FindingRow[] {
  if (Array.isArray(finding.rows)) return finding.rows;
  return isEmptyRow(finding.evidence) ? [] : [finding.evidence as FindingRow];
}

/** A row's canonical form: JSON with keys sorted at every level and values as returned (array order
 *  is kept). Two rows are the same row when this is equal; a change detector compares a finding's
 *  previous and new rows as sets of these keys. */
export function rowKey(row: FindingRow): string {
  return JSON.stringify(row, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map(k => [k, source[k]]));
  });
}

/** What a finding gained and lost between two sightings, comparing rows on every column (rowKey).
 *  A row whose value changed is one removed and one added. Both lists keep their rows' own order. */
export function diffRows(previous: FindingRow[], current: FindingRow[]): { added: FindingRow[]; removed: FindingRow[] } {
  const previousKeys = new Set(previous.map(rowKey));
  const currentKeys = new Set(current.map(rowKey));
  return {
    added: current.filter(row => !previousKeys.has(rowKey(row))),
    removed: previous.filter(row => !currentKeys.has(rowKey(row))),
  };
}

/** Folds findings that share a fingerprint into one finding that holds every distinct row, in the
 *  order they arrived; a row equal to one already kept (see rowKey) is dropped, so a fan-out join
 *  returning the same row twice is one row. Findings keep first-seen order. The merged finding's
 *  display fields come from its last occurrence, as they did when a repeat simply replaced the
 *  earlier one; its `evidence` is the first row. */
export function mergeFindingsByFingerprint<T extends HasRows & { fingerprint: string }>(findings: T[]): (T & { rows: FindingRow[] })[] {
  const merged = new Map<string, { last: T; rows: FindingRow[]; keys: Set<string> }>();
  for (const f of findings) {
    let entry = merged.get(f.fingerprint);
    if (entry) entry.last = f;
    else merged.set(f.fingerprint, entry = { last: f, rows: [], keys: new Set() });
    for (const row of findingRows(f)) {
      const key = rowKey(row);
      if (entry.keys.has(key)) continue;
      entry.keys.add(key);
      entry.rows.push(row);
    }
  }
  return Array.from(merged.values(), ({ last, rows }) => ({
    ...last,
    evidence: rows[0] ?? last.evidence ?? {},
    rows,
  }));
}
