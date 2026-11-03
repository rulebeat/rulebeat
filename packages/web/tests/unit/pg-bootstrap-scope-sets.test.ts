/**
 * ADR 0016: a Postgres database bootstrapped before `scope_sets` existed gains the table on the next boot,
 * and a set written afterwards is read back unchanged by the repository the app reads with. Postgres only by
 * nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { createScopeSet, expandScopeSet } from '@/lib/db/scope-sets';
import { resetDb } from '../helpers/db';

const SUB = '/subscriptions/00000000-0000-0000-0000-00000000000a';

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds scope_sets to an existing database (ADR 0016)', () => {
  afterEach(async () => { await resetDb(); });

  it('creates the table on a database without it and keeps a set across a re-bootstrap', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    await pgDb!.execute(sql.raw('DROP TABLE scope_sets'));

    await bootstrapPg(pgDb!);
    const made = await createScopeSet([SUB]);

    await bootstrapPg(pgDb!);
    expect(await expandScopeSet(made.hash)).toEqual({ status: 'resolved', paths: [SUB] });
  });
});
