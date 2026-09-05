/**
 * Issue #88: two containers booting against one empty Postgres database at the same time (the
 * first Postgres start of a rolling deploy) must both come up. `CREATE TABLE IF NOT EXISTS` is not
 * atomic across sessions: each one runs the whole DDL in one implicit transaction, the second
 * cannot see the first's uncommitted tables, blocks on the catalog's unique index, and fails with
 * a duplicate-key error once the first commits. `bootstrapPg` takes a transaction-scoped advisory
 * lock so the second waits and then finds every table already there. Postgres only by nature.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';

describe.skipIf(dbKind !== 'pg')('bootstrapPg under two concurrent first boots (issue #88)', () => {
  it('both bootstraps of an empty database succeed and leave one complete schema', async () => {
    await dbReady;
    await pgDb!.execute(sql.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'));

    await expect(Promise.all([bootstrapPg(pgDb!), bootstrapPg(pgDb!)])).resolves.toBeDefined();

    const res = await pgDb!.execute(sql.raw(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    ));
    expect(Number((res.rows[0] as { n: unknown }).n)).toBeGreaterThan(20);
  });
});
