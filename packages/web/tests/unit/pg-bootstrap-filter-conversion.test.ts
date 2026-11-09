/**
 * ADR 0015: the Postgres half of the upgrade that turns dashboard filters and saved view queries into Scope
 * picks. The same plan the SQLite migration runs runs in a savepoint on every boot, and the cases are the ones
 * db-migrations-filter-conversion.test.ts runs (tests/helpers/filter-conversion-cases.ts). Postgres only by
 * nature; skipped on the default SQLite run.
 */
import { afterAll, beforeAll, describe } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { resetDb } from '../helpers/db';
import { defineFilterConversionCases, type ConversionHarness } from '../helpers/filter-conversion-cases';

const harness: ConversionHarness = {
  async reset() {
    await resetDb();
    await pgDb!.execute(sql.raw(`DELETE FROM scan_findings`));
  },
  async run(statement) { await pgDb!.execute(sql.raw(statement)); },
  async all(statement) { return (await pgDb!.execute(sql.raw(statement))).rows as Record<string, unknown>[]; },
  async startUp() { await bootstrapPg(pgDb!); },
};

describe.skipIf(dbKind !== 'pg')('bootstrapPg converts dashboard filters and saved views to Scope picks', () => {
  beforeAll(async () => { await dbReady; });
  afterAll(async () => {
    await pgDb!.execute(sql.raw(`DELETE FROM dashboards WHERE id LIKE 'conv-%'`));
    await resetDb();
  });

  defineFilterConversionCases(() => harness);
});
