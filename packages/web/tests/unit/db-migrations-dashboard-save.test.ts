/**
 * Issue #419: the upgrade that gives `dashboards` an owner, a visibility, a revision and a last
 * editor keeps every existing row as it was. Rows stay Shared with no owner at revision 1, their
 * config and default flag are untouched, and the last editor is null until a write names someone.
 * Migrations swallow their own errors, so the content is read back through the repository the app
 * reads with, and the stored text is compared byte for byte.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';

const LAYOUT = {
  autoRefresh: 60,
  widgets: [{ id: 'w1', type: 'stat-card', title: 'Open', x: 0, y: 0, w: 3, h: 3, config: { metric: 'total-findings' } }],
  filters: { categories: ['cost'] },
};
const BARE = { widgets: [] };

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
  return import('@/lib/db/dashboards');
}

const NEW_COLUMNS = ['owner_id', 'visibility', 'revision', 'updated_by', 'updated_at'];

/** A database as the release before these columns left it: current tables, minus the new columns. */
function databaseBeforeOwnership(file: string, seed: (db: Database.Database) => void) {
  const db = open(file);
  runMigrations(db);
  for (const column of NEW_COLUMNS) db.exec(`ALTER TABLE dashboards DROP COLUMN ${column}`);
  seed(db);
  db.close();
}

describe('upgrading to dashboards with an owner, a revision and a last editor', () => {
  it('keeps each row\'s config and default flag, and reads it as Shared, unowned, revision 1, last edited by no one', async () => {
    const sample = makeSample('current');
    const stored = new Map<string, string>();
    databaseBeforeOwnership(sample.file, (db) => {
      const insert = db.prepare(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES (?, ?, ?, ?, ?)`);
      for (const [id, config, isDefault] of [['layout', LAYOUT, 1], ['bare', BARE, 0]] as const) {
        const text = JSON.stringify(config);
        stored.set(id, text);
        insert.run(id, `Dashboard ${id}`, text, isDefault, '2026-01-01T00:00:00.000Z');
      }
    });

    const product = await startProductOn(sample.file);
    const layout = (await product.getDashboard('layout'))!;
    const bare = (await product.getDashboard('bare'))!;

    for (const d of [layout, bare]) {
      expect(d).toMatchObject({ ownerId: null, visibility: 'shared', revision: 1, updatedBy: null, updatedAt: null, createdAt: '2026-01-01T00:00:00.000Z' });
    }
    expect([layout.isDefault, bare.isDefault]).toEqual([true, false]);
    expect(layout.config).toEqual(LAYOUT);
    expect(bare.config).toEqual(BARE);

    sqlite = open(sample.file);
    const rows = sqlite.prepare(`SELECT id, config, is_default FROM dashboards WHERE id IN ('layout', 'bare')`).all() as { id: string; config: string; is_default: number }[];
    for (const row of rows) expect(row.config).toBe(stored.get(row.id));
    expect(rows.find(r => r.id === 'layout')!.is_default).toBe(1);
  });

  it('lets an upgraded row be saved at revision 1 and records who saved it', async () => {
    const sample = makeSample('current');
    databaseBeforeOwnership(sample.file, (db) => {
      db.prepare(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES ('d', 'D', ?, 0, '2026-01-01T00:00:00.000Z')`).run(JSON.stringify(BARE));
    });
    const product = await startProductOn(sample.file);

    const saved = await product.updateDashboard('d', { description: 'edited' }, { revision: 1, actorId: 'user-1' });

    expect(saved).toMatchObject({ ok: true, dashboard: { revision: 2, updatedBy: 'user-1' } });
  });

  it('does not reset a revision already earned when the app restarts', async () => {
    const sample = makeSample('current');
    databaseBeforeOwnership(sample.file, (db) => {
      db.prepare(`INSERT INTO dashboards (id, name, config, is_default, created_at) VALUES ('d', 'D', ?, 0, '2026-01-01T00:00:00.000Z')`).run(JSON.stringify(BARE));
    });
    const first = await startProductOn(sample.file);
    await first.updateDashboard('d', { description: 'edited' }, { revision: 1, actorId: 'user-1' });
    closeProductDb?.();

    const second = await startProductOn(sample.file);

    expect(await second.getDashboard('d')).toMatchObject({ revision: 2, updatedBy: 'user-1', description: 'edited' });
  });
});
