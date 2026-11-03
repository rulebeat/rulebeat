/**
 * ADR 0012 (#352): the upgrade that gives every dashboard and saved view an owner, a visibility and a
 * revision, and every person a My default. Run on a database as the previous release left it: none of
 * those columns exist. Migrations swallow their own errors, so these tests read the content back: what
 * the upgrade adds (Shared, revision 1, a saved view's owner) and everything it must not touch (id, name,
 * description, config or query, timestamps, the default flag, created_by and updated_by), and that a
 * second run changes nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';

const WRITER = 'owned-writer';
const GONE = 'owned-gone';
const CONFIG = '{"widgets":[],"filters":{"category":"cost"}}';

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

const all = (db: Database.Database, text: string, ...params: unknown[]) => db.prepare(text).all(...params) as Record<string, unknown>[];

async function startProductOn(file: string) {
  vi.resetModules();
  vi.stubEnv('RULEBEAT_DATABASE_URL', '');
  vi.stubEnv('RULEBEAT_DATABASE_URL_FILE', '');
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const views = await import('@/lib/db/saved-views');
  const dashboards = await import('@/lib/db/dashboards');
  return { views, dashboards };
}

/** The database as the previous release left it: none of the new columns, and the items it held. */
function previousReleaseDatabase() {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  db.exec(`
    ALTER TABLE dashboards DROP COLUMN owner_id;
    ALTER TABLE dashboards DROP COLUMN visibility;
    ALTER TABLE dashboards DROP COLUMN revision;
    ALTER TABLE saved_views DROP COLUMN owner_id;
    ALTER TABLE saved_views DROP COLUMN visibility;
    ALTER TABLE saved_views DROP COLUMN revision;
    ALTER TABLE users DROP COLUMN default_dashboard_id;
    ALTER TABLE users DROP COLUMN default_dashboard_unavailable;
    DELETE FROM dashboards;
    DELETE FROM saved_views;
    DELETE FROM users;
  `);
  db.prepare(`INSERT INTO users (id, email, name, role, created_at) VALUES (?, 'writer@example.com', 'Wanda Writer', 'editor', '2026-01-01T00:00:00.000Z')`).run(WRITER);
  const dash = db.prepare(`INSERT INTO dashboards (id, name, description, config, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  dash.run('dash-default', 'Estate', 'The one everyone opens', CONFIG, 1, '2026-01-02T00:00:00.000Z');
  dash.run('dash-other', 'Cost', null, CONFIG, 0, '2026-01-03T00:00:00.000Z');
  const view = db.prepare(`INSERT INTO saved_views (id, name, tab, query, created_by, created_at, updated_by, updated_at) VALUES (?, ?, 'results', ?, ?, ?, ?, ?)`);
  view.run('view-live', 'Critical', 'severity=critical', WRITER, '2026-02-01T00:00:00.000Z', GONE, '2026-02-02T00:00:00.000Z');
  view.run('view-gone', 'High', 'severity=high', GONE, '2026-02-03T00:00:00.000Z', GONE, '2026-02-04T00:00:00.000Z');
  view.run('view-none', 'Medium', 'severity=medium', null, '2026-02-05T00:00:00.000Z', null, '2026-02-06T00:00:00.000Z');
  return { sample, db };
}

const DASHBOARD_KEPT = 'id, name, description, config, is_default, created_at';
const VIEW_KEPT = 'id, name, tab, query, created_by, created_at, updated_by, updated_at';

describe('upgrading to owned dashboards and saved views', () => {
  it('makes every existing dashboard Shared at revision 1 with no owner, and keeps the default flag', () => {
    const { sample, db } = previousReleaseDatabase();
    const before = all(db, `SELECT ${DASHBOARD_KEPT} FROM dashboards ORDER BY id`);
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(all(sqlite, `SELECT ${DASHBOARD_KEPT} FROM dashboards ORDER BY id`)).toEqual(before);
    expect(all(sqlite, `SELECT id, owner_id, visibility, revision, is_default FROM dashboards ORDER BY id`)).toEqual([
      { id: 'dash-default', owner_id: null, visibility: 'shared', revision: 1, is_default: 1 },
      { id: 'dash-other', owner_id: null, visibility: 'shared', revision: 1, is_default: 0 },
    ]);
  });

  it('owns a saved view by its creator while that person still exists, and by nobody otherwise', () => {
    const { sample, db } = previousReleaseDatabase();
    const before = all(db, `SELECT ${VIEW_KEPT} FROM saved_views ORDER BY id`);
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(all(sqlite, `SELECT ${VIEW_KEPT} FROM saved_views ORDER BY id`)).toEqual(before);
    expect(all(sqlite, `SELECT id, owner_id, visibility, revision FROM saved_views ORDER BY id`)).toEqual([
      { id: 'view-gone', owner_id: null, visibility: 'shared', revision: 1 },
      { id: 'view-live', owner_id: WRITER, visibility: 'shared', revision: 1 },
      { id: 'view-none', owner_id: null, visibility: 'shared', revision: 1 },
    ]);
  });

  it('gives nobody a My default', () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(all(sqlite, `SELECT id, default_dashboard_id, default_dashboard_unavailable FROM users`)).toEqual([
      { id: WRITER, default_dashboard_id: null, default_dashboard_unavailable: 0 },
    ]);
  });

  it('changes nothing on a second run, and does not hand a view back to its creator once it has no owner', () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);
    sqlite.prepare(`UPDATE saved_views SET owner_id = NULL, revision = 4 WHERE id = 'view-live'`).run();
    const after = {
      dashboards: all(sqlite, `SELECT * FROM dashboards ORDER BY id`),
      views: all(sqlite, `SELECT * FROM saved_views ORDER BY id`),
      users: all(sqlite, `SELECT * FROM users ORDER BY id`),
    };

    runMigrations(sqlite);

    expect({
      dashboards: all(sqlite, `SELECT * FROM dashboards ORDER BY id`),
      views: all(sqlite, `SELECT * FROM saved_views ORDER BY id`),
      users: all(sqlite, `SELECT * FROM users ORDER BY id`),
    }).toEqual(after);
  });

  it('reads back through the repositories with the owner, the visibility and the revision', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();

    const product = await startProductOn(sample.file);
    expect(await product.views.getSavedView('view-live')).toMatchObject({
      owner: { id: WRITER, displayName: 'Wanda Writer', email: 'writer@example.com' },
      visibility: 'shared',
      revision: 1,
    });
    expect(await product.views.getSavedView('view-gone')).toMatchObject({ owner: null, visibility: 'shared', revision: 1 });
    expect(await product.dashboards.getDashboard('dash-default')).toMatchObject({
      owner: null, visibility: 'shared', revision: 1, isDefault: true,
    });
  });
});

describe('a fresh install', () => {
  it('seeds the starter dashboard Shared, with no owner', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    sqlite = open(sample.file);

    expect(all(sqlite, `SELECT id, owner_id, visibility, revision, is_default FROM dashboards`)).toEqual([
      { id: 'default', owner_id: null, visibility: 'shared', revision: 1, is_default: 1 },
    ]);
  });
});
