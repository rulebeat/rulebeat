/**
 * Database helpers for tests.
 *
 * `lib/db/client.ts` opens one connection at import time and every repository imports that
 * singleton, so tests share a single database per file (pointed at a temp path by tests/setup.ts).
 * That's fine — and much closer to production than a mocked repository would be — provided each
 * test starts from a known state. `resetDb()` is how.
 */
import { sql } from 'drizzle-orm';
import { db, dbReady, pgDb } from '@/lib/db/client';
import { dbKind } from '@/lib/db/backend';

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

/** Resets the mutable state a test creates, leaving the seeded baseline intact.
 *
 *  Async for the Postgres backend (issue #73); on SQLite the body has no await, so it still
 *  completes synchronously and legacy un-awaited `resetDb()` calls stay correct there. On Postgres
 *  the helper waits for `dbReady` first — the bootstrap creates the schema asynchronously, and a
 *  DELETE racing it would fail on a table that does not exist yet. */
export async function resetDb(): Promise<void> {
  if (dbKind === 'pg') {
    await dbReady;
    for (const table of CLEARABLE) {
      await pgDb!.execute(sql.raw(`DELETE FROM ${table}`));
    }
    return;
  }
  db.run(sql`PRAGMA foreign_keys = OFF`);
  for (const table of CLEARABLE) db.run(sql.raw(`DELETE FROM ${table}`));
  db.run(sql`PRAGMA foreign_keys = ON`);
}

/** Empties the rules table, for suites asserting exact rule counts. */
export async function clearRules(): Promise<void> {
  if (dbKind === 'pg') {
    await dbReady;
    await pgDb!.execute(sql.raw('DELETE FROM rules'));
    return;
  }
  db.run(sql`PRAGMA foreign_keys = OFF`);
  db.run(sql`DELETE FROM rules`);
  db.run(sql`PRAGMA foreign_keys = ON`);
}

/** Empties the dashboards table, for suites testing the empty-gallery and default-promotion paths. */
export async function clearDashboards(): Promise<void> {
  if (dbKind === 'pg') {
    await dbReady;
    await pgDb!.execute(sql.raw('DELETE FROM dashboards'));
    return;
  }
  db.run(sql`DELETE FROM dashboards`);
}

/** Row count for a table — handy for "did this actually write anything" assertions. */
export async function countRows(table: string): Promise<number> {
  if (dbKind === 'pg') {
    await dbReady;
    const res = await pgDb!.execute(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`));
    return Number((res.rows[0] as { n: unknown }).n);
  }
  const row = db.get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`));
  return row?.n ?? 0;
}

/** Executes one raw SQL statement on whichever backend is active. For test setup and the direct
 *  column pokes assertions sometimes need; product code goes through `lib/db/exec.ts` instead. */
export async function execRaw(statement: string): Promise<void> {
  if (dbKind === 'pg') {
    await dbReady;
    await pgDb!.execute(sql.raw(statement));
    return;
  }
  db.run(sql.raw(statement));
}

/** True when the table exists in the current schema. Used by the SQLite migration suite only. */
export function tableExists(table: string): boolean {
  const row = db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
  );
  return (row?.n ?? 0) > 0;
}

/** Column names on a table, for asserting a migration added what it should have. SQLite only. */
export function columnsOf(table: string): string[] {
  const rows = db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`));
  return rows.map(r => r.name);
}
