/**
 * Issue #334: the upgrade that adds `revision` to `dashboards` and `saved_views` keeps every row's
 * stored content exactly as it was. A dashboard's filters and window become its saved filters, so
 * none of them may be reset; a saved view's query must come back byte for byte. Migrations swallow
 * their own errors, so the content is read back through the repositories the app reads with.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';

const FILTERED = {
  autoRefresh: 60,
  widgets: [{ id: 'w1', type: 'stat-card', title: 'Open', x: 0, y: 0, w: 3, h: 2, config: { metric: 'total-findings', windowDays: 30 } }],
  filters: { categories: ['cost'], subscriptions: ['sub-1'], severities: ['critical', 'high'], tags: ['env=prod'] },
  dateWindow: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' },
};
const LEGACY = { widgets: [], windowDays: 30 };
const BARE = { widgets: [] };
const QUERY = 'severity=critical,high&status=all&cols=properties.sku&sort=lastSeen:desc';

let sqlite: Database.Database | undefined;
let closeProductDb: (() => void) | undefined;
afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
  closeProductDb?.();
  closeProductDb = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function startProductOn(file: string) {
  vi.resetModules();
  // A SQLite upgrade test: the Postgres CI job must not point the product at its database instead.
  vi.stubEnv('RULEBEAT_DATABASE_URL', '');
  vi.stubEnv('RULEBEAT_DATABASE_URL_FILE', '');
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const dashboards = await import('@/lib/db/dashboards');
  const views = await import('@/lib/db/saved-views');
  const filters = await import('@/lib/dashboard-filters');
  return { dashboards, views, filters };
}

/** A database as the release before `revision` left it: current tables, minus the new column. */
function databaseBeforeRevision(file: string, seed: (db: Database.Database) => void) {
  const db = open(file);
  runMigrations(db);
  db.exec(`ALTER TABLE dashboards DROP COLUMN revision; ALTER TABLE saved_views DROP COLUMN revision;`);
  seed(db);
  db.close();
}

describe('upgrading to dashboards and saved views with a revision', () => {
  it('gives every existing row revision 1 and keeps each dashboard\'s filters and window as stored', async () => {
    const sample = makeSample('current');
    const stored = new Map<string, string>();
    databaseBeforeRevision(sample.file, (db) => {
      const insert = db.prepare(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES (?, ?, ?, ?, ?)`);
      for (const [id, config] of [['filtered', FILTERED], ['legacy', LEGACY], ['bare', BARE]] as const) {
        const text = JSON.stringify(config);
        stored.set(id, text);
        insert.run(id, `Dashboard ${id}`, text, 0, '2026-01-01T00:00:00.000Z');
      }
    });

    const product = await startProductOn(sample.file);
    const filtered = (await product.dashboards.getDashboard('filtered'))!;
    const legacy = (await product.dashboards.getDashboard('legacy'))!;
    const bare = (await product.dashboards.getDashboard('bare'))!;

    expect([filtered.revision, legacy.revision, bare.revision]).toEqual([1, 1, 1]);
    expect(filtered.config.filters).toEqual(FILTERED.filters);
    expect(filtered.config.dateWindow).toEqual(FILTERED.dateWindow);
    expect(legacy.config.windowDays).toBe(30);
    expect(legacy.config.dateWindow).toBeUndefined();
    expect(legacy.config.filters).toBeUndefined();
    expect(bare.config.dateWindow).toBeUndefined();
    expect(bare.config.filters).toBeUndefined();
    // The widget-level override still reads as the filters module reads it.
    expect(product.filters.mergeWidgetFilters({ dateWindow: { mode: 'relative', days: 7 } }, filtered.config.widgets[0]!.config).dateWindow)
      .toEqual({ mode: 'relative', days: 30 });

    sqlite = open(sample.file);
    const rows = sqlite.prepare(`SELECT id, config FROM dashboards WHERE id IN ('filtered', 'legacy', 'bare')`).all() as { id: string; config: string }[];
    for (const row of rows) expect(row.config).toBe(stored.get(row.id));
  });

  it('keeps a saved view\'s query and tab unchanged and gives it revision 1', async () => {
    const sample = makeSample('current');
    databaseBeforeRevision(sample.file, (db) => {
      db.prepare(`INSERT INTO saved_views (id, name, tab, query, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('view-1', 'Critical and high', 'advisories', QUERY, 'u1', '2026-01-01T00:00:00.000Z', 'u2', '2026-01-02T00:00:00.000Z');
    });

    const product = await startProductOn(sample.file);
    const view = (await product.views.getSavedView('view-1'))!;

    expect(view).toEqual({
      id: 'view-1', name: 'Critical and high', tab: 'advisories', query: QUERY, revision: 1,
      createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z', updatedBy: 'u2', updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('does not reset a revision already earned when the app restarts', async () => {
    const sample = makeSample('current');
    databaseBeforeRevision(sample.file, (db) => {
      db.prepare(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES ('d', 'D', ?, 0, '2026-01-01T00:00:00.000Z')`)
        .run(JSON.stringify(BARE));
    });
    const first = await startProductOn(sample.file);
    await first.dashboards.updateDashboard('d', { description: 'edited' });
    closeProductDb?.();

    const second = await startProductOn(sample.file);

    expect((await second.dashboards.getDashboard('d'))!.revision).toBe(2);
  });
});
