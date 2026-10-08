/**
 * Issue #196: the upgrade that adds `saved_views` is additive. An install from before it keeps its
 * rules, and the new table starts empty; a saved view stored afterwards survives a restart
 * unchanged. Migrations swallow their own errors, so these tests read the content back through the
 * repository the app reads with rather than trusting that nothing threw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';

const RULE = '9a4e7c31-5b2d-4e8f-8c6a-1d3f5b7a9c21';
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

/** Starts the product against `file`: a fresh import of the db client runs the real startup
 *  migrations, and the repository then reads that database, exactly as the running app does. */
async function startProductOn(file: string) {
  vi.resetModules();
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const views = await import('@/lib/db/saved-views');
  return { views, stop: () => { client.rawSqlite?.close(); closeProductDb = undefined; } };
}

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

describe('upgrading to a database with saved views', () => {
  it('keeps what an install from before saved views held and starts the new table empty', async () => {
    const sample = makeSample('current');
    const db = open(sample.file);
    runMigrations(db);
    db.exec(`DROP TABLE saved_views;`);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type)
      VALUES (?, 'VM retirements', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]',
        'resources | project id, name, type, location, resourceGroup, subscriptionId', 'custom')
    `).run(RULE);
    expect(all(db, `SELECT name FROM sqlite_master WHERE name = 'saved_views'`)).toEqual([]);
    db.close();

    const product = await startProductOn(sample.file);
    expect(await product.views.listSavedViews()).toEqual([]);
    product.stop();

    sqlite = open(sample.file);
    expect(all(sqlite, `SELECT name, raw_kql FROM rules WHERE id = ?`, RULE)).toEqual([
      { name: 'VM retirements', raw_kql: 'resources | project id, name, type, location, resourceGroup, subscriptionId' },
    ]);
  });

  it('keeps a saved view, query and all, across a restart', async () => {
    const sample = makeSample('current');
    const first = await startProductOn(sample.file);
    const made = await first.views.createSavedView({ name: 'Critical and high', tab: 'advisories', query: QUERY }, null);
    if (!made.ok) throw new Error('create failed');
    first.stop();

    const second = await startProductOn(sample.file);
    const stored = await second.views.getSavedView(made.view.id);
    expect(stored).toEqual(made.view);
    expect(stored).toMatchObject({ name: 'Critical and high', tab: 'advisories', query: QUERY });
    expect((await second.views.listSavedViews()).map(v => v.id)).toEqual([made.view.id]);
  });
});
