/**
 * Issue #419: a Postgres database bootstrapped before `dashboards` had an owner, a visibility, a
 * revision and a last editor gains the columns on the next boot. Every existing row keeps its config
 * and default flag, reads as Shared with no owner at revision 1, and has no last editor. Postgres
 * only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { getDashboard, updateDashboard } from '@/lib/db/dashboards';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';

const LAYOUT = {
  autoRefresh: 60,
  widgets: [{ id: 'w1', type: 'stat-card', title: 'Open', x: 0, y: 0, w: 3, h: 3, config: { metric: 'total-findings' } }],
  filters: { categories: ['cost'] },
};
const BARE = { widgets: [] };

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds ownership columns to an existing database (issue #419)', () => {
  afterEach(async () => { await clearDashboards(); await resetDb(); });

  it('keeps config and the default flag, and gives every row Shared, no owner, revision 1 and no last editor', async () => {
    await dbReady;
    await resetDb();
    await clearDashboards();
    for (const column of ['owner_id', 'visibility', 'revision', 'updated_by', 'updated_at']) {
      await execRaw(`ALTER TABLE dashboards DROP COLUMN ${column}`);
    }
    for (const [id, config, isDefault] of [['layout', LAYOUT, 'TRUE'], ['bare', BARE, 'FALSE']] as const) {
      await execRaw(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES ('${id}', 'Dashboard ${id}', '${JSON.stringify(config)}', ${isDefault}, '2026-01-01T00:00:00.000Z')`);
    }

    await bootstrapPg(pgDb!);

    const layout = (await getDashboard('layout'))!;
    const bare = (await getDashboard('bare'))!;
    for (const d of [layout, bare]) {
      expect(d).toMatchObject({ ownerId: null, visibility: 'shared', revision: 1, updatedBy: null, updatedAt: null });
    }
    expect([layout.isDefault, bare.isDefault]).toEqual([true, false]);
    expect(layout.config).toEqual(LAYOUT);

    expect(await updateDashboard('layout', { description: 'edited' }, { revision: 1, actorId: 'user-1' }))
      .toMatchObject({ ok: true, dashboard: { revision: 2, updatedBy: 'user-1' } });
    await bootstrapPg(pgDb!);
    expect((await getDashboard('layout'))).toMatchObject({ revision: 2, updatedBy: 'user-1' });
    const raw = await pgDb!.execute(sql.raw(`SELECT config FROM dashboards WHERE id = 'bare'`));
    expect(JSON.parse((raw.rows[0] as { config: string }).config)).toEqual(BARE);
  });
});
