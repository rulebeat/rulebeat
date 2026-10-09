import { rowLeafPaths } from '../finding-view';
import type { FindingRow } from '../finding-rows';

/**
 * The pure half of building `column_catalogue`: rows in, a rule's paths out, so the scan save
 * (lib/db/column-catalogue.ts), SQLite's upgrade (migrate.ts) and Postgres's (pg/bootstrap.ts) all
 * derive paths through the one walker, `rowLeafPaths`, rather than three implementations of it.
 *
 * The upgrade builds the catalogue once from the stored rows. Like the finding-rows copy it reads the
 * result back and proves it is exactly the plan before writing the marker, in the same transaction,
 * so a build that fails changes nothing and is retried on the next start.
 */

export const COLUMN_CATALOGUE_MARKER = 'column-catalogue-built-v1';

/** Rules that have findings, for the upgrade's build. Plain SQL valid on both backends. */
export const CATALOGUE_READ_RULES = `SELECT DISTINCT rule_id FROM findings`;
/** The read-back the proof compares. Unordered: Postgres sorts text by locale, so the proof sorts it. */
export const CATALOGUE_READ_BACK = `SELECT rule_id, path FROM column_catalogue`;

export interface CatalogueRecord { rule_id: string; path: string }

/** How many rows are walked at once, so one rule with a great many rows is never all in memory. */
const WALK_BATCH = 500;

/** Collects the paths of a rule's rows as they stream past, walking them a batch at a time. */
export class PathCollector {
  private readonly paths = new Set<string>();
  private pending: FindingRow[] = [];

  /** One stored row, as the JSON text finding_rows holds. Text that is not a JSON object is skipped. */
  add(data: string): void {
    let row: unknown;
    try { row = JSON.parse(data); } catch { return; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return;
    this.pending.push(row as FindingRow);
    if (this.pending.length >= WALK_BATCH) this.flush();
  }

  private flush(): void {
    for (const path of rowLeafPaths([{ rows: this.pending }])) this.paths.add(path);
    this.pending = [];
  }

  result(): string[] {
    this.flush();
    return [...this.paths].sort((a, b) => a.localeCompare(b));
  }
}

const byRecord = (a: CatalogueRecord, b: CatalogueRecord) =>
  (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Why the catalogue read back is not exactly `planned`, or null when it is. Strict: nothing missing,
 *  nothing extra. */
export function catalogueMismatch(planned: CatalogueRecord[], readBack: CatalogueRecord[]): string | null {
  const want = [...planned].sort(byRecord);
  const got = [...readBack].sort(byRecord);
  if (got.length !== want.length) return `expected ${want.length} entries, found ${got.length}`;
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.rule_id !== got[i]!.rule_id || want[i]!.path !== got[i]!.path) {
      return `entry ${want[i]!.path} of rule ${want[i]!.rule_id} did not build exactly`;
    }
  }
  return null;
}
