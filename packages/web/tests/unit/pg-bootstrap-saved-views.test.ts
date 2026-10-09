/**
 * Issue #196: a Postgres database bootstrapped before `saved_views` existed gains the table on the
 * next boot, and a saved view written afterwards is read back unchanged by the repository the app
 * reads with. Postgres only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { createSavedView, getSavedView, listSavedViews } from '@/lib/db/saved-views';
import { resetDb } from '../helpers/db';

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds saved_views to an existing database (issue #196)', () => {
  afterEach(async () => { await resetDb(); });

  it('creates the table on a database without it and keeps a saved view across a re-bootstrap', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    await pgDb!.execute(sql.raw('DROP TABLE saved_views'));

    await bootstrapPg(pgDb!);
    expect(await listSavedViews()).toEqual([]);

    const made = await createSavedView({ name: 'Critical only', tab: 'results', query: 'severity=critical' }, null);
    if (!made.ok) throw new Error('create failed');

    await bootstrapPg(pgDb!);
    expect(await getSavedView(made.view.id)).toEqual(made.view);
  });
});
