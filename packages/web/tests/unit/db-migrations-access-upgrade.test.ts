/**
 * #269: the upgrade that gives every existing Viewer and Editor their Everything row and the source
 * `manual`. Run on a database as the previous release left it: people with no `access_source` and no
 * `role_assignments` table. Migrations swallow their own errors, so these tests read the content back:
 * what the upgrade adds (one row per Viewer and Editor, a source) and everything it must not touch
 * (every user and local account column, Admins, the source of anyone already set).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { NextResponse } from 'next/server';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations, runSeeds } from '@/lib/db/migrate';
import { planAccessUpgrade } from '@/lib/db/access-upgrade';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const ID = {
  admin: 'acc-admin',
  viewer: 'acc-viewer',
  editor: 'acc-editor',
  pendingViewer: 'acc-pending-viewer',
  pendingEditor: 'acc-pending-editor',
  withPassword: 'acc-with-password',
  withOid: 'acc-with-oid',
  oddRole: 'acc-odd-role',
};

let sqlite: Database.Database | undefined;
let closeProductDb: (() => void) | undefined;
afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
  closeProductDb?.();
  closeProductDb = undefined;
  mockAuth.mockReset();
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
  const users = await import('@/lib/db/users');
  const guard = await import('@/lib/api-auth');
  return { listUsers: users.listUsers, requireRole: guard.requireRole };
}

function insertUser(db: Database.Database, id: string, role: string, extra: { oid?: string; epoch?: number } = {}): void {
  db.prepare(`
    INSERT INTO users (id, email, oid, name, role, session_epoch, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, '2026-01-02T03:04:05.000Z', ?)
  `).run(id, `${id}@example.com`, extra.oid ?? null, extra.oid ? `Name ${id}` : null, role, extra.epoch ?? 0,
    extra.oid ? '2026-02-03T04:05:06.000Z' : null);
}

/** The database as the previous release left it: no role_assignments table, no users.access_source. */
function previousReleaseDatabase() {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  db.exec('DROP TABLE role_assignments; ALTER TABLE users DROP COLUMN access_source;');
  db.exec('DELETE FROM users');
  insertUser(db, ID.admin, 'admin', { oid: '00000000-0000-0000-0000-0000000000a1' });
  insertUser(db, ID.viewer, 'viewer');
  insertUser(db, ID.editor, 'editor', { epoch: 3 });
  insertUser(db, ID.pendingViewer, 'viewer');
  insertUser(db, ID.pendingEditor, 'editor');
  insertUser(db, ID.withPassword, 'viewer');
  insertUser(db, ID.withOid, 'viewer', { oid: '00000000-0000-0000-0000-0000000000b1' });
  insertUser(db, ID.oddRole, 'owner');
  db.prepare(`
    INSERT INTO local_accounts (user_id, password_hash, must_change_password, failed_attempts, locked_until, password_updated_at, created_at)
    VALUES (?, 'scrypt$salt$hash', 1, 2, NULL, '2026-01-03T00:00:00.000Z', '2026-01-02T03:04:05.000Z')
  `).run(ID.withPassword);
  return { sample, db };
}

const rowsOf = (db: Database.Database) => all(db, 'SELECT user_id, tenant_id, scope, role FROM role_assignments ORDER BY user_id');
const sourcesOf = (db: Database.Database) =>
  Object.fromEntries(all(db, 'SELECT id, access_source FROM users').map(r => [r.id, r.access_source]));
const USER_COLUMNS = 'id, email, oid, name, role, session_epoch, created_at, last_seen_at';

describe('upgrading to role assignments', () => {
  it('gives every Viewer and Editor, pending invites included, one Everything row at their Role and the source manual', () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(rowsOf(sqlite)).toEqual([
      { user_id: ID.editor, tenant_id: '', scope: '/', role: 'editor' },
      { user_id: ID.oddRole, tenant_id: '', scope: '/', role: 'viewer' },
      { user_id: ID.pendingEditor, tenant_id: '', scope: '/', role: 'editor' },
      { user_id: ID.pendingViewer, tenant_id: '', scope: '/', role: 'viewer' },
      { user_id: ID.viewer, tenant_id: '', scope: '/', role: 'viewer' },
      { user_id: ID.withOid, tenant_id: '', scope: '/', role: 'viewer' },
      { user_id: ID.withPassword, tenant_id: '', scope: '/', role: 'viewer' },
    ]);
    expect(sourcesOf(sqlite)).toEqual({
      [ID.admin]: null,
      [ID.viewer]: 'manual', [ID.editor]: 'manual', [ID.pendingViewer]: 'manual', [ID.pendingEditor]: 'manual',
      [ID.withPassword]: 'manual', [ID.withOid]: 'manual', [ID.oddRole]: 'manual',
    });
  });

  it('gives an Admin no rows and no source, and nobody the source mirrored, a bound oid included', () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(rowsOf(sqlite).map(r => r.user_id)).not.toContain(ID.admin);
    expect(sourcesOf(sqlite)[ID.admin]).toBeNull();
    expect(all(sqlite, `SELECT id FROM users WHERE access_source = 'mirrored'`)).toEqual([]);
    expect(sourcesOf(sqlite)[ID.withOid]).toBe('manual');
  });

  it('changes no user and no local account', () => {
    const { sample, db } = previousReleaseDatabase();
    const before = {
      users: all(db, `SELECT ${USER_COLUMNS} FROM users ORDER BY id`),
      accounts: all(db, 'SELECT * FROM local_accounts ORDER BY user_id'),
    };
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(all(sqlite, `SELECT ${USER_COLUMNS} FROM users ORDER BY id`)).toEqual(before.users);
    expect(all(sqlite, 'SELECT * FROM local_accounts ORDER BY user_id')).toEqual(before.accounts);
    expect(all(sqlite, 'SELECT password_hash FROM local_accounts')).toEqual([{ password_hash: 'scrypt$salt$hash' }]);
  });

  it('leaves a second start with nothing to change', () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    sqlite = open(sample.file);
    runMigrations(sqlite);
    const first = {
      users: all(sqlite, 'SELECT * FROM users ORDER BY id'),
      accounts: all(sqlite, 'SELECT * FROM local_accounts ORDER BY user_id'),
      rows: rowsOf(sqlite),
    };

    runMigrations(sqlite);

    expect({
      users: all(sqlite, 'SELECT * FROM users ORDER BY id'),
      accounts: all(sqlite, 'SELECT * FROM local_accounts ORDER BY user_id'),
      rows: rowsOf(sqlite),
    }).toEqual(first);
  });

  it('does not grant Everything again to a person narrowed to no Scope', () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    sqlite = open(sample.file);
    runMigrations(sqlite);

    sqlite.prepare('DELETE FROM role_assignments WHERE user_id = ?').run(ID.viewer);
    runMigrations(sqlite);

    expect(rowsOf(sqlite).map(r => r.user_id)).not.toContain(ID.viewer);
    expect(sourcesOf(sqlite)[ID.viewer]).toBe('manual');
  });

  it('picks up a person a rolled-back release added, on the next start, and no one else', () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    sqlite = open(sample.file);
    runMigrations(sqlite);
    const before = rowsOf(sqlite);

    insertUser(sqlite, 'acc-late', 'editor');
    runMigrations(sqlite);

    expect(rowsOf(sqlite)).toEqual([...before, { user_id: 'acc-late', tenant_id: '', scope: '/', role: 'editor' }].sort(
      (a, b) => String(a.user_id).localeCompare(String(b.user_id))));
    expect(sourcesOf(sqlite)['acc-late']).toBe('manual');
  });

  it('runs as valid SQL on its own and never throws out of runMigrations', () => {
    expect(planAccessUpgrade().length).toBeGreaterThan(0);
    const { sample, db } = previousReleaseDatabase();
    // A broken table makes the upgrade fail: the failure is logged and the start still completes.
    db.exec('CREATE TABLE role_assignments (nonsense TEXT)');
    db.close();
    sqlite = open(sample.file);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => runMigrations(sqlite!)).not.toThrow();

    expect(error).toHaveBeenCalled();
    expect(sourcesOf(sqlite)[ID.viewer]).toBeNull();
  });

  it('clears the rows and the source of a person the bootstrap variable promotes to Admin', () => {
    const { sample, db } = previousReleaseDatabase();
    db.exec(`DELETE FROM users WHERE role = 'admin'`);
    db.close();
    sqlite = open(sample.file);
    vi.stubEnv('RULEBEAT_INITIAL_ADMIN', `${ID.viewer}@example.com`);

    runMigrations(sqlite);
    runSeeds(sqlite, sample.dataDir, { skipOwnerBootstrap: true });

    expect(all(sqlite, 'SELECT role FROM users WHERE id = ?', ID.viewer)).toEqual([{ role: 'admin' }]);
    expect(rowsOf(sqlite).map(r => r.user_id)).not.toContain(ID.viewer);
    expect(sourcesOf(sqlite)[ID.viewer]).toBeNull();
    expect(rowsOf(sqlite).map(r => r.user_id)).toContain(ID.editor);
  });

  it('lets the upgraded Editor pass the real requireRole for rules:write once the product starts', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();

    const product = await startProductOn(sample.file);
    mockAuth.mockResolvedValue({ user: { uid: ID.editor, epoch: 3 } });

    const result = await product.requireRole('rules:write');
    if (result instanceof NextResponse) throw new Error(`refused with ${result.status}`);
    expect(result.access).toMatchObject({ everything: true, source: 'manual' });
    expect(result.access.grants.map(g => g.role)).toEqual(['editor']);

    mockAuth.mockResolvedValue({ user: { uid: ID.viewer } });
    expect(((await product.requireRole('rules:write')) as NextResponse).status).toBe(403);
    expect(await product.requireRole('read')).not.toBeInstanceOf(NextResponse);
    expect((await product.listUsers()).find(u => u.id === ID.viewer)?.accessSource).toBe('manual');
  });

  it('lets an upgraded Viewer read every finding through the findings route, and a person narrowed to no Scope none (#267)', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    await startProductOn(sample.file);
    const { loadRules } = await import('@/lib/rules');
    const { storeScan, syntheticFinding } = await import('../helpers/synthetic-findings');
    const { emptyView, viewToSearchParams } = await import('@/lib/finding-view');
    const { deleteAssignmentsOn } = await import('@/lib/db/role-assignments');
    const { db: productDb } = await import('@/lib/db/client');
    const viewRoute = await import('@/app/api/findings/view/route');
    const ruleId = (await loadRules()).find(r => r.queryBackend === 'resource-graph')!.id;
    await storeScan([
      syntheticFinding('vm-one', [{}], { ruleId, subscriptionId: 'sub-1' }),
      syntheticFinding('vm-two', [{}], { ruleId, subscriptionId: 'sub-2' }),
    ], { scanId: 'scan-after-upgrade', finishedAt: '2026-01-04T00:00:00.000Z' });
    const names = async (uid: string) => {
      mockAuth.mockResolvedValue({ user: { uid } });
      const res = await viewRoute.GET(new Request(`http://localhost/api/findings/view?${viewToSearchParams(emptyView(), { tab: 'results' })}`));
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: { finding: { resourceName: string } }[] }).items.map(i => i.finding.resourceName).sort();
    };

    expect(await names(ID.viewer)).toEqual(['vm-one', 'vm-two']);
    expect(await names(ID.pendingEditor)).toEqual(['vm-one', 'vm-two']);
    await deleteAssignmentsOn(productDb, ID.withOid);
    expect(await names(ID.withOid)).toEqual([]);
  });
});
