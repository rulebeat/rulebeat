/**
 * Deterministic snapshots of a SQLite database, for the upgrade-path suite.
 *
 * Two jobs:
 *
 *  - **Prove a refactor of the upgrade code changed nothing.** Dump each sample database before the
 *    change and after it; the two must be identical.
 *  - **Prove upgrading twice is the same as upgrading once** (QA case 25-11).
 *
 * Both need a dump that is stable across runs, and parts of seeding are legitimately not: category
 * rows carry `created_at = new Date()`, the default dashboard gets a fresh `crypto.randomUUID()`, and
 * the legacy-slug rule renames mint new ids every time. Those are normalised away.
 *
 * The normalisation is deliberately confined to the ROWS section. SCHEMA and COUNTS are printed
 * exactly, so the failures that actually matter for a refactor — a migration that stopped running, a
 * column that never got added, a seed that ran twice — still show up precisely even though the
 * individual identifiers are masked.
 */
import type { Database } from 'better-sqlite3';

/**
 * Tables whose contents are large, machine-generated caches — shape matters, contents don't.
 * `local_accounts` joins them for a narrower reason: `password_hash` embeds a fresh random salt
 * on every run (see lib/password.ts), so even two runs seeding the exact same owner account would
 * never produce byte-identical rows.
 */
const COUNT_ONLY = new Set(['schema_cache', 'resource_types_cache', 'local_accounts']);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
/**
 * A finding fingerprint: `sha256(ruleId::resourceId)` truncated to 16 hex characters. Masked because
 * one lineage renames rules to freshly generated ids, so the fingerprints derived from them are
 * legitimately different on every run. Their *correctness* is asserted directly, and far more
 * precisely, in `db-migrations-integrity.test.ts`.
 */
const FINGERPRINT_RE = /\b[0-9a-f]{16}\b/g;

export function tableNames(sqlite: Database): string[] {
  const rows = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map(r => r.name);
}

export function tableExists(sqlite: Database, table: string): boolean {
  const row = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return row !== undefined;
}

export function columnsOf(sqlite: Database, table: string): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
  return rows.map(r => r.name);
}

export function countRows(sqlite: Database, table: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number };
  return row.n;
}

/** Every row of a table, as plain objects, ordered deterministically. */
export function rowsOf(sqlite: Database, table: string): Record<string, unknown>[] {
  const rows = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[];
  return rows.map(sortKeys).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function dumpDb(sqlite: Database): string {
  const out: string[] = [];

  out.push('== SCHEMA ==');
  for (const name of tableNames(sqlite)) {
    out.push(`table ${name}`);
    const cols = sqlite.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as ColumnInfo[];
    for (const c of cols) {
      const flags = [
        c.type || 'BLOB',
        c.notnull ? 'NOT NULL' : null,
        c.pk ? `PK(${c.pk})` : null,
        c.dflt_value !== null ? `DEFAULT ${c.dflt_value}` : null,
      ].filter(Boolean).join(' ');
      out.push(`  ${c.name} ${flags}`);
    }
  }
  const indexes = sqlite
    .prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string; tbl_name: string }[];
  for (const i of indexes) out.push(`index ${i.name} on ${i.tbl_name}`);

  out.push('', '== COUNTS ==');
  for (const name of tableNames(sqlite)) out.push(`${name}: ${countRows(sqlite, name)}`);

  out.push('', '== ROWS ==');
  for (const name of tableNames(sqlite)) {
    if (COUNT_ONLY.has(name)) continue;
    // Masked *before* sorting, not after: two rows that differ only by a freshly generated id sort
    // into an arbitrary order otherwise, and the dump stops being comparable with itself.
    const lines = rowsOf(sqlite, name).map(row => `${name} ${normalise(JSON.stringify(row))}`);
    out.push(...lines.sort());
  }

  return out.join('\n');
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * Masks the values that are legitimately regenerated on every startup. Anything else differing
 * between two dumps is a real behaviour change.
 */
function normalise(s: string): string {
  return s.replace(UUID_RE, '<UUID>').replace(ISO_TS_RE, '<TS>').replace(FINGERPRINT_RE, '<FP>');
}

function sortKeys(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
}

/** Table names come from sqlite_master or a fixed list, never user input — this is belt and braces. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
