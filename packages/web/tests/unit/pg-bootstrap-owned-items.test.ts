/**
 * ADR 0012 (#352): the Postgres half of the owned-items upgrade. A database bootstrapped before dashboards
 * and saved views had an owner, a visibility and a revision gains them on the next boot: every row is
 * Shared at revision 1, a saved view is owned by its creator while that person still exists, nobody gets
 * a My default, and a second boot changes nothing. Postgres only by nature; skipped on the default SQLite
 * run (db-migrations-owned-items.test.ts makes the same assertions there).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { join, resolve } from 'path';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { seedPg } from '@/lib/db/pg/seeds';
import { getSavedView } from '@/lib/db/saved-views';
import { getDashboard } from '@/lib/db/dashboards';
import { clearDashboards, resetDb } from '../helpers/db';

// Anchored to this file: from the working directory the seeder quietly finds no packs and does nothing.
const DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');
const WRITER = 'pg-owned-writer';
const GONE = 'pg-owned-gone';
const CONFIG = '{"widgets":[],"filters":{"category":"cost"}}';

const raw = async (statement: string) => (await pgDb!.execute(sql.raw(statement))).rows as Record<string, unknown>[];

/** The database as the previous release left it: none of the new columns, and the items it held. */
async function previousReleaseDatabase(): Promise<void> {
  await dbReady;
  await resetDb();
  await clearDashboards();
  await bootstrapPg(pgDb!);
  for (const table of ['dashboards', 'saved_views']) {
    for (const column of ['owner_id', 'visibility', 'revision']) await raw(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  for (const column of ['default_dashboard_id', 'default_dashboard_unavailable']) await raw(`ALTER TABLE users DROP COLUMN ${column}`);
  await raw(`INSERT INTO users (id, email, name, role, created_at) VALUES ('${WRITER}', 'writer@example.com', 'Wanda Writer', 'editor', '2026-01-01T00:00:00.000Z')`);
  await raw(`INSERT INTO dashboards (id, name, description, config, is_default, created_at) VALUES
    ('dash-default', 'Estate', 'The one everyone opens', '${CONFIG}', TRUE, '2026-01-02T00:00:00.000Z'),
    ('dash-other', 'Cost', NULL, '${CONFIG}', FALSE, '2026-01-03T00:00:00.000Z')`);
  await raw(`INSERT INTO saved_views (id, name, tab, query, created_by, created_at, updated_by, updated_at) VALUES
    ('view-live', 'Critical', 'results', 'severity=critical', '${WRITER}', '2026-02-01T00:00:00.000Z', '${GONE}', '2026-02-02T00:00:00.000Z'),
    ('view-gone', 'High', 'results', 'severity=high', '${GONE}', '2026-02-03T00:00:00.000Z', '${GONE}', '2026-02-04T00:00:00.000Z'),
    ('view-none', 'Medium', 'results', 'severity=medium', NULL, '2026-02-05T00:00:00.000Z', NULL, '2026-02-06T00:00:00.000Z')`);
}

const DASHBOARD_KEPT = 'id, name, description, config, is_default, created_at';
const VIEW_KEPT = 'id, name, tab, query, created_by, created_at, updated_by, updated_at';
const dashboardsKept = () => raw(`SELECT ${DASHBOARD_KEPT} FROM dashboards ORDER BY id COLLATE "C"`);
const viewsKept = () => raw(`SELECT ${VIEW_KEPT} FROM saved_views ORDER BY id COLLATE "C"`);

describe.skipIf(dbKind !== 'pg')('bootstrapPg gives dashboards and saved views an owner, a visibility and a revision', () => {
  afterEach(async () => {
    await resetDb();
    await clearDashboards();
    await bootstrapPg(pgDb!);
  });

  it('makes every existing dashboard Shared at revision 1 with no owner, and keeps the default flag', async () => {
    await previousReleaseDatabase();
    const before = await dashboardsKept();

    await bootstrapPg(pgDb!);

    expect(await dashboardsKept()).toEqual(before);
    expect(await raw(`SELECT id, owner_id, visibility, revision, is_default FROM dashboards ORDER BY id COLLATE "C"`)).toEqual([
      { id: 'dash-default', owner_id: null, visibility: 'shared', revision: 1, is_default: true },
      { id: 'dash-other', owner_id: null, visibility: 'shared', revision: 1, is_default: false },
    ]);
  });

  it('owns a saved view by its creator while that person still exists, and by nobody otherwise', async () => {
    await previousReleaseDatabase();
    const before = await viewsKept();

    await bootstrapPg(pgDb!);

    expect(await viewsKept()).toEqual(before);
    expect(await raw(`SELECT id, owner_id, visibility, revision FROM saved_views ORDER BY id COLLATE "C"`)).toEqual([
      { id: 'view-gone', owner_id: null, visibility: 'shared', revision: 1 },
      { id: 'view-live', owner_id: WRITER, visibility: 'shared', revision: 1 },
      { id: 'view-none', owner_id: null, visibility: 'shared', revision: 1 },
    ]);
  });

  it('gives nobody a My default', async () => {
    await previousReleaseDatabase();

    await bootstrapPg(pgDb!);

    expect(await raw(`SELECT id, default_dashboard_id, default_dashboard_unavailable FROM users`)).toEqual([
      { id: WRITER, default_dashboard_id: null, default_dashboard_unavailable: false },
    ]);
  });

  it('changes nothing on a second boot, and does not hand a view back to its creator once it has no owner', async () => {
    await previousReleaseDatabase();
    await bootstrapPg(pgDb!);
    await raw(`UPDATE saved_views SET owner_id = NULL, revision = 4 WHERE id = 'view-live'`);
    const snapshot = async () => ({
      dashboards: await raw(`SELECT * FROM dashboards ORDER BY id COLLATE "C"`),
      views: await raw(`SELECT * FROM saved_views ORDER BY id COLLATE "C"`),
      users: await raw(`SELECT * FROM users ORDER BY id COLLATE "C"`),
    });
    const after = await snapshot();

    await bootstrapPg(pgDb!);

    expect(await snapshot()).toEqual(after);
  });

  it('reads back through the repositories with the owner, the visibility and the revision', async () => {
    await previousReleaseDatabase();

    await bootstrapPg(pgDb!);

    expect(await getSavedView('view-live')).toMatchObject({
      owner: { id: WRITER, displayName: 'Wanda Writer', email: 'writer@example.com' },
      visibility: 'shared',
      revision: 1,
    });
    expect(await getDashboard('dash-default')).toMatchObject({ owner: null, visibility: 'shared', revision: 1, isDefault: true });
  });

  it('seeds the starter dashboard Shared, with no owner', async () => {
    await dbReady;
    await resetDb();
    await clearDashboards();
    await raw(`DELETE FROM meta WHERE key = 'dashboards-seeded-v1'`);
    await bootstrapPg(pgDb!);
    await seedPg(pgDb!, DATA_DIR, { skipOwnerBootstrap: true });

    expect(await raw(`SELECT id, owner_id, visibility, revision, is_default FROM dashboards`)).toEqual([
      { id: 'default', owner_id: null, visibility: 'shared', revision: 1, is_default: true },
    ]);
  });
});
