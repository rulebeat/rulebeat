/**
 * Issue #150, the live half: after `bootstrapPg` has run, the columns Postgres actually holds must
 * be the columns `schema.pg.ts` declares, with the same nullability. schema-twins.test.ts proves the
 * two Drizzle files agree with each other; this proves the hand-written DDL in `pg/bootstrap.ts`
 * agrees with `schema.pg.ts`. A column declared in the schema but missing from the DDL fails at the
 * first query on a real install, and one in the DDL but not the schema is invisible to Drizzle.
 *
 * Only the comparison logic runs on every backend; the database check itself runs under the
 * Postgres CI job (RULEBEAT_TEST_PG_URL set). `tests/setup.ts` recreates the `public` schema per
 * test file and importing the client bootstraps it, so `dbReady` is all this needs to await.
 */
import { describe, expect, it } from 'vitest';
import { is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { dbReady, pgDb } from '@/lib/db/client';
import * as pgSchema from '@/lib/db/schema.pg';

/** `table.column` to nullability, so one flat map compares both the table set and every column. */
type ColumnMap = Map<string, { nullable: boolean }>;

function declaredColumns(): ColumnMap {
  const out: ColumnMap = new Map();
  for (const v of Object.values(pgSchema) as unknown[]) {
    if (!is(v, PgTable)) continue;
    const cfg = getTableConfig(v);
    for (const c of cfg.columns) out.set(`${cfg.name}.${c.name}`, { nullable: !c.notNull });
  }
  return out;
}

function differences(declared: ColumnMap, live: ColumnMap): string[] {
  const diffs: string[] = [];
  for (const [key, shape] of declared) {
    const found = live.get(key);
    if (!found) diffs.push(`${key} is in schema.pg.ts but not in the database`);
    else if (found.nullable !== shape.nullable) {
      diffs.push(`${key} is nullable=${shape.nullable} in schema.pg.ts but nullable=${found.nullable} in the database`);
    }
  }
  for (const key of live.keys()) {
    if (!declared.has(key)) diffs.push(`${key} is in the database but not in schema.pg.ts`);
  }
  return diffs;
}

describe('comparison of declared and live columns', () => {
  it('reports missing, extra and nullability-mismatched columns', () => {
    const declared: ColumnMap = new Map([
      ['t.a', { nullable: false }], ['t.b', { nullable: true }], ['t.c', { nullable: false }],
    ]);
    const live: ColumnMap = new Map([
      ['t.a', { nullable: false }], ['t.b', { nullable: false }], ['t.d', { nullable: true }],
    ]);
    expect(differences(declared, live).sort()).toEqual([
      't.b is nullable=true in schema.pg.ts but nullable=false in the database',
      't.c is in schema.pg.ts but not in the database',
      't.d is in the database but not in schema.pg.ts',
    ].sort());
  });
});

describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('postgres database matches schema.pg.ts', () => {
  it('has exactly the declared tables and columns, with the declared nullability', async () => {
    await dbReady;
    const res = await pgDb!.execute(sql`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `);
    const live: ColumnMap = new Map();
    for (const r of res.rows as { table_name: string; column_name: string; is_nullable: string }[]) {
      live.set(`${r.table_name}.${r.column_name}`, { nullable: r.is_nullable === 'YES' });
    }
    const declared = declaredColumns();
    // Guards against a vacuous pass if the query matched nothing.
    expect(live.size).toBeGreaterThan(0);
    expect(declared.size).toBeGreaterThan(0);
    expect(differences(declared, live)).toEqual([]);
  });
});
