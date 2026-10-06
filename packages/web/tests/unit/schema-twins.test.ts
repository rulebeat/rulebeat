/**
 * Issue #150: `schema.ts` (SQLite) and `schema.pg.ts` (Postgres) are hand-kept twins, and
 * `lib/db/tables.ts` casts one to the other's type. That is safe only while they declare the same
 * tables and the same columns with the same nullability. A column added to one twin and missed in
 * the other type-checks against the SQLite side, then on Postgres the write is silently dropped and
 * the read comes back undefined. Nothing else compares the two files, so this does.
 *
 * Pure static comparison through Drizzle's `getTableConfig`; it opens no database and runs
 * identically on the SQLite and Postgres passes. The Postgres-only companion that checks the live
 * database against `schema.pg.ts` is pg-schema-columns.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig as getSqliteConfig } from 'drizzle-orm/sqlite-core';
import { PgTable, getTableConfig as getPgConfig } from 'drizzle-orm/pg-core';
import * as sqliteSchema from '@/lib/db/schema';
import * as pgSchema from '@/lib/db/schema.pg';

interface ColumnShape { notNull: boolean }
type TableShapes = Map<string, Map<string, ColumnShape>>;

/**
 * Every intentional difference between the twins, keyed by table. A difference not listed here
 * fails the test, so a new one has to be declared (and justified) in this file.
 */
const PG_ONLY_COLUMNS: Record<string, Record<string, string>> = {
  notification_deliveries: { seq: 'insertion-order tiebreak standing in for SQLite rowid' },
  saved_queries: { seq: 'insertion-order tiebreak standing in for SQLite rowid' },
  query_runs: { seq: 'insertion-order tiebreak standing in for SQLite rowid' },
};
const SQLITE_ONLY_COLUMNS: Record<string, Record<string, string>> = {};

/** Keyed by the database table and column name, never the TypeScript property name. */
function sqliteShapes(): TableShapes {
  const out: TableShapes = new Map();
  for (const v of Object.values(sqliteSchema) as unknown[]) {
    if (!is(v, SQLiteTable)) continue;
    const cfg = getSqliteConfig(v);
    out.set(cfg.name, new Map(cfg.columns.map(c => [c.name, { notNull: c.notNull }])));
  }
  return out;
}

function pgShapes(): TableShapes {
  const out: TableShapes = new Map();
  for (const v of Object.values(pgSchema) as unknown[]) {
    if (!is(v, PgTable)) continue;
    const cfg = getPgConfig(v);
    out.set(cfg.name, new Map(cfg.columns.map(c => [c.name, { notNull: c.notNull }])));
  }
  return out;
}

/** Human-readable list of every way `pg` departs from `sqlite`, minus the declared exceptions. */
function differences(sqlite: TableShapes, pg: TableShapes): string[] {
  const diffs: string[] = [];
  for (const name of sqlite.keys()) {
    if (!pg.has(name)) diffs.push(`table ${name} is in schema.ts only`);
  }
  for (const name of pg.keys()) {
    if (!sqlite.has(name)) diffs.push(`table ${name} is in schema.pg.ts only`);
  }
  for (const [table, sqliteCols] of sqlite) {
    const pgCols = pg.get(table);
    if (!pgCols) continue;
    for (const [col, shape] of sqliteCols) {
      const other = pgCols.get(col);
      if (!other) {
        if (!SQLITE_ONLY_COLUMNS[table]?.[col]) diffs.push(`${table}.${col} is in schema.ts only`);
        continue;
      }
      if (other.notNull !== shape.notNull) {
        diffs.push(`${table}.${col} is notNull=${shape.notNull} in schema.ts but notNull=${other.notNull} in schema.pg.ts`);
      }
    }
    for (const col of pgCols.keys()) {
      if (!sqliteCols.has(col) && !PG_ONLY_COLUMNS[table]?.[col]) {
        diffs.push(`${table}.${col} is in schema.pg.ts only`);
      }
    }
  }
  return diffs;
}

describe('schema.ts and schema.pg.ts declare the same tables and columns', () => {
  it('match table for table, column for column, with the same nullability', () => {
    const sqlite = sqliteShapes();
    // Guards against a vacuous pass if the exports ever stop being recognised as tables.
    expect(sqlite.size).toBeGreaterThanOrEqual(24);
    expect(differences(sqlite, pgShapes())).toEqual([]);
  });

  it('every listed exception is real, so a stale entry cannot linger', () => {
    const sqlite = sqliteShapes();
    const pg = pgShapes();
    for (const [table, cols] of Object.entries(PG_ONLY_COLUMNS)) {
      for (const col of Object.keys(cols)) {
        expect(pg.get(table)?.has(col), `${table}.${col} should exist in schema.pg.ts`).toBe(true);
        expect(sqlite.get(table)?.has(col), `${table}.${col} should be absent from schema.ts`).toBe(false);
      }
    }
    for (const [table, cols] of Object.entries(SQLITE_ONLY_COLUMNS)) {
      for (const col of Object.keys(cols)) {
        expect(sqlite.get(table)?.has(col), `${table}.${col} should exist in schema.ts`).toBe(true);
        expect(pg.get(table)?.has(col), `${table}.${col} should be absent from schema.pg.ts`).toBe(false);
      }
    }
  });

  it('reports a column missing from one twin and a nullability mismatch', () => {
    // The comparison itself must be able to fail; drive it with shapes that differ on purpose.
    const sqlite: TableShapes = new Map([
      ['t', new Map([['a', { notNull: true }], ['b', { notNull: false }], ['c', { notNull: true }]])],
      ['only_sqlite', new Map([['x', { notNull: true }]])],
    ]);
    const pg: TableShapes = new Map([
      ['t', new Map([['a', { notNull: true }], ['b', { notNull: true }], ['d', { notNull: false }]])],
    ]);
    expect(differences(sqlite, pg).sort()).toEqual([
      't.b is notNull=false in schema.ts but notNull=true in schema.pg.ts',
      't.c is in schema.ts only',
      't.d is in schema.pg.ts only',
      'table only_sqlite is in schema.ts only',
    ].sort());
  });
});
