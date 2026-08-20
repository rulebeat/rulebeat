/**
 * Database helpers for tests.
 *
 * `lib/db/client.ts` opens one connection at import time and every repository imports that
 * singleton, so tests share a single database per file (pointed at a temp path by tests/setup.ts).
 * That's fine — and much closer to production than a mocked repository would be — provided each
 * test starts from a known state. `resetDb()` is how.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';

/**
 * Tables `resetDb()` empties, child-before-parent so foreign keys never block a delete.
 *
 * Deliberately excludes the seeded baseline — `rules`, `categories`, `dashboards`, `meta` — because
 * that baseline *is* the state of every real install: `lib/db/client.ts` seeds built-in rules,
 * categories and the starter dashboard at import time, and those seed functions are private, so
 * clearing them would leave the database in a state no install is ever in. Suites that genuinely
 * need an empty table call the explicit `clearRules()` / `clearDashboards()` below.
 */
const CLEARABLE = [
  'finding_events',
  'findings',
  'posture_snapshots',
  'schedule_runs',
  'schedules',
  'scans',
  'suppressions',
  'audit_log',
  'local_accounts',
  'users',
  'sso_providers',
  'saved_queries',
  'query_runs',
] as const;

/** Resets the mutable state a test creates, leaving the seeded baseline intact. */
export function resetDb(): void {
  db.run(sql`PRAGMA foreign_keys = OFF`);
  for (const table of CLEARABLE) db.run(sql.raw(`DELETE FROM ${table}`));
  db.run(sql`PRAGMA foreign_keys = ON`);
}

/** Empties the rules table, for suites asserting exact rule counts. */
export function clearRules(): void {
  db.run(sql`PRAGMA foreign_keys = OFF`);
  db.run(sql`DELETE FROM rules`);
  db.run(sql`PRAGMA foreign_keys = ON`);
}

/** Empties the dashboards table, for suites testing the empty-gallery and default-promotion paths. */
export function clearDashboards(): void {
  db.run(sql`DELETE FROM dashboards`);
}

/** Row count for a table — handy for "did this actually write anything" assertions. */
export function countRows(table: string): number {
  const row = db.get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`));
  return row?.n ?? 0;
}

/** True when the table exists in the current schema. Used by the migration suite. */
export function tableExists(table: string): boolean {
  const row = db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
  );
  return (row?.n ?? 0) > 0;
}

/** Column names on a table, for asserting a migration added what it should have. */
export function columnsOf(table: string): string[] {
  const rows = db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`));
  return rows.map(r => r.name);
}
