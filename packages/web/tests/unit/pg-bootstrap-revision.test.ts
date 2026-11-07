/**
 * Issue #334: a Postgres database bootstrapped before `revision` existed gains the column on the
 * next boot, with every existing dashboard and saved view at revision 1 and its stored content
 * untouched. Postgres only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { getDashboard, updateDashboard } from '@/lib/db/dashboards';
import { getSavedView } from '@/lib/db/saved-views';
import { mergeWidgetFilters } from '@/lib/dashboard-filters';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';

const FILTERED = {
  autoRefresh: 60,
  widgets: [{ id: 'w1', type: 'stat-card', title: 'Open', x: 0, y: 0, w: 3, h: 2, config: { metric: 'total-findings', windowDays: 30 } }],
  filters: { categories: ['cost'], severities: ['critical', 'high'] },
  dateWindow: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' },
};
const LEGACY = {
  widgets: [{ id: 'w2', type: 'stat-card', title: 'Open', x: 0, y: 0, w: 3, h: 2, config: { metric: 'total-findings', windowDays: 7 } }],
  windowDays: 30,
};
const QUERY = 'severity=critical,high&status=all&cols=properties.sku&sort=lastSeen:desc';

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds revision to an existing database (issue #334)', () => {
  afterEach(async () => { await clearDashboards(); await resetDb(); });

  it('backfills revision 1 and keeps dashboard filters, window and saved view query as stored', async () => {
    await dbReady;
    await resetDb();
    await clearDashboards();
    await execRaw('ALTER TABLE dashboards DROP COLUMN revision');
    await execRaw('ALTER TABLE saved_views DROP COLUMN revision');
    for (const [id, config] of [['filtered', FILTERED], ['legacy', LEGACY]] as const) {
      await execRaw(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES ('${id}', 'Dashboard ${id}', '${JSON.stringify(config)}', FALSE, '2026-01-01T00:00:00.000Z')`);
    }
    await execRaw(`INSERT INTO saved_views (id, name, tab, query, created_at, updated_at) VALUES ('view-1', 'Critical and high', 'advisories', '${QUERY}', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`);

    await bootstrapPg(pgDb!);

    const filtered = (await getDashboard('filtered'))!;
    const legacy = (await getDashboard('legacy'))!;
    expect([filtered.revision, legacy.revision]).toEqual([1, 1]);
    expect(filtered.config.filters).toEqual(FILTERED.filters);
    expect(filtered.config.dateWindow).toEqual(FILTERED.dateWindow);
    expect(legacy.config.windowDays).toBe(30);
    expect(legacy.config.dateWindow).toBeUndefined();
    // The widget-level windows still read as the filters module reads them.
    const base = { dateWindow: { mode: 'relative', days: 90 } } as const;
    expect(mergeWidgetFilters(base, filtered.config.widgets[0]!.config).dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(mergeWidgetFilters(base, legacy.config.widgets[0]!.config).dateWindow).toEqual({ mode: 'relative', days: 7 });
    expect(await getSavedView('view-1')).toMatchObject({ tab: 'advisories', query: QUERY, revision: 1 });

    await updateDashboard('filtered', { description: 'edited' });
    await bootstrapPg(pgDb!);
    expect((await getDashboard('filtered'))!.revision).toBe(2);
    const raw = await pgDb!.execute(sql.raw(`SELECT config FROM dashboards WHERE id = 'legacy'`));
    expect(JSON.parse((raw.rows[0] as { config: string }).config)).toEqual(LEGACY);
  });
});
