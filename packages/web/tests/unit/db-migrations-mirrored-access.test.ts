/**
 * #278: the upgrade that adds Mirrored access. Run on a database as the previous release left it: people with
 * their source and rows, and none of the Linked account columns or the origin column. Migrations swallow their
 * own errors, so these tests read the content back: every user, source, row and local account is as it was,
 * nobody is mirrored, and the new columns exist and hold nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';

const ID = {
  admin: 'mir-admin',
  manualViewer: 'mir-manual-viewer',
  manualEditor: 'mir-manual-editor',
  narrowed: 'mir-narrowed',
  pending: 'mir-pending',
  withPassword: 'mir-with-password',
};

const NEW_USER_COLUMNS = ['linked_tenant_id', 'linked_object_id', 'mirror_last_success_at', 'mirror_last_attempt_at', 'mirror_error'];
const SUB = '/subscriptions/00000000-0000-0000-0000-00000000000a';
const TENANT = '00000000-0000-0000-0000-0000000000f0';

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

function insertUser(db: Database.Database, id: string, role: string, source: string | null, oid: string | null = null): void {
  db.prepare(`
    INSERT INTO users (id, email, oid, name, role, access_source, session_epoch, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 2, '2026-01-02T03:04:05.000Z', ?)
  `).run(id, `${id}@example.com`, oid, oid ? `Name ${id}` : null, role, source, oid ? '2026-02-03T04:05:06.000Z' : null);
}

const insertRow = (db: Database.Database, userId: string, tenantId: string, scope: string, role: string): void => {
  db.prepare('INSERT INTO role_assignments (user_id, tenant_id, scope, role) VALUES (?, ?, ?, ?)').run(userId, tenantId, scope, role);
};

/** The database as the previous release left it: people with sources and rows, no Linked account and no origin column. */
function previousReleaseDatabase() {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  for (const column of NEW_USER_COLUMNS) db.exec(`ALTER TABLE users DROP COLUMN ${column}`);
  db.exec('ALTER TABLE role_assignments DROP COLUMN origin');
  db.exec('DELETE FROM users');
  insertUser(db, ID.admin, 'admin', null, '00000000-0000-0000-0000-0000000000a1');
  insertUser(db, ID.manualViewer, 'viewer', 'manual');
  insertUser(db, ID.manualEditor, 'editor', 'manual', '00000000-0000-0000-0000-0000000000b1');
  insertUser(db, ID.narrowed, 'viewer', 'manual');
  insertUser(db, ID.pending, 'viewer', 'manual');
  insertUser(db, ID.withPassword, 'editor', 'manual');
  insertRow(db, ID.manualViewer, '', '/', 'viewer');
  insertRow(db, ID.manualEditor, TENANT, SUB, 'editor');
  insertRow(db, ID.manualEditor, TENANT, `${SUB}/resourceGroups/rg-one`, 'editor');
  insertRow(db, ID.pending, '', '/', 'viewer');
  insertRow(db, ID.withPassword, TENANT, SUB, 'editor');
  db.prepare(`
    INSERT INTO local_accounts (user_id, password_hash, must_change_password, failed_attempts, locked_until, password_updated_at, created_at)
    VALUES (?, 'scrypt$salt$hash', 1, 2, NULL, '2026-01-03T00:00:00.000Z', '2026-01-02T03:04:05.000Z')
  `).run(ID.withPassword);
  return { sample, db };
}

const USER_COLUMNS = 'id, email, oid, name, role, access_source, session_epoch, created_at, last_seen_at, scope';
const ROW_COLUMNS = 'user_id, tenant_id, scope, role';
const columnsOf = (db: Database.Database, table: string) => all(db, `PRAGMA table_info(${table})`).map(c => c.name as string);

describe('upgrading to Mirrored access', () => {
  it('adds the Linked account columns to users and the origin column to role_assignments', () => {
    const { sample, db } = previousReleaseDatabase();
    expect(columnsOf(db, 'users')).not.toContain('linked_object_id');
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(columnsOf(sqlite, 'users')).toEqual(expect.arrayContaining(NEW_USER_COLUMNS));
    expect(columnsOf(sqlite, 'role_assignments')).toContain('origin');
  });

  it('leaves every user, source and local account as it was', () => {
    const { sample, db } = previousReleaseDatabase();
    const before = {
      users: all(db, `SELECT ${USER_COLUMNS} FROM users ORDER BY id`),
      accounts: all(db, 'SELECT * FROM local_accounts ORDER BY user_id'),
    };
    expect(before.users).toHaveLength(6);
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(all(sqlite, `SELECT ${USER_COLUMNS} FROM users ORDER BY id`)).toEqual(before.users);
    expect(all(sqlite, 'SELECT * FROM local_accounts ORDER BY user_id')).toEqual(before.accounts);
    expect(all(sqlite, 'SELECT password_hash FROM local_accounts')).toEqual([{ password_hash: 'scrypt$salt$hash' }]);
  });

  it('leaves every role assignment row as it was, with no origin', () => {
    const { sample, db } = previousReleaseDatabase();
    const before = all(db, `SELECT ${ROW_COLUMNS} FROM role_assignments ORDER BY user_id, scope`);
    expect(before).toHaveLength(5);
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(all(sqlite, `SELECT ${ROW_COLUMNS} FROM role_assignments ORDER BY user_id, scope`)).toEqual(before);
    expect(all(sqlite, 'SELECT origin FROM role_assignments').map(r => r.origin)).toEqual([null, null, null, null, null]);
  });

  it('mirrors nobody, and leaves the new columns null on every person', () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();

    sqlite = open(sample.file);
    runMigrations(sqlite);

    expect(all(sqlite, `SELECT id FROM users WHERE access_source = 'mirrored'`)).toEqual([]);
    for (const user of all(sqlite, `SELECT ${NEW_USER_COLUMNS.join(', ')} FROM users`)) {
      expect(Object.values(user)).toEqual([null, null, null, null, null]);
    }
    expect(all(sqlite, `SELECT access_source FROM users WHERE id = ?`, ID.narrowed)).toEqual([{ access_source: 'manual' }]);
  });

  it('leaves a second start with nothing to change', () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();
    sqlite = open(sample.file);
    runMigrations(sqlite);
    const first = { users: all(sqlite, 'SELECT * FROM users ORDER BY id'), rows: all(sqlite, 'SELECT * FROM role_assignments ORDER BY user_id, scope') };

    runMigrations(sqlite);

    expect({ users: all(sqlite, 'SELECT * FROM users ORDER BY id'), rows: all(sqlite, 'SELECT * FROM role_assignments ORDER BY user_id, scope') }).toEqual(first);
  });

  it('lets the upgraded database hold Mirrored access, and turn it back to manual', async () => {
    const { sample, db } = previousReleaseDatabase();
    db.close();

    vi.resetModules();
    vi.stubEnv('RULEBEAT_DATABASE_URL', '');
    vi.stubEnv('RULEBEAT_DATABASE_URL_FILE', '');
    vi.stubEnv('RULEBEAT_DB_PATH', sample.file);
    const client = await import('@/lib/db/client');
    closeProductDb = () => client.rawSqlite?.close();
    const users = await import('@/lib/db/users');
    const rows = await import('@/lib/db/role-assignments');

    const written = await users.setMirroredAccess(ID.manualViewer, {
      role: 'viewer', tenantId: TENANT, objectId: '00000000-0000-0000-0000-0000000000c1', at: '2026-06-02T00:00:00.000Z',
      scopes: [{ scope: SUB, origins: [{ roleName: 'Reader', throughGroup: false, eligible: false }] }],
    });
    expect(written).toMatchObject({ user: { accessSource: 'mirrored', linkedAccount: { objectId: '00000000-0000-0000-0000-0000000000c1' } } });
    expect((await rows.listAssignmentsFor(ID.manualViewer)).map(r => [r.scope, r.origin !== null])).toEqual([[SUB, true]]);
    // Nobody else moved.
    expect((await users.getUser(ID.manualEditor))).toMatchObject({ accessSource: 'manual', linkedAccount: null, mirror: null });

    await users.setManualAccess(ID.manualViewer, [{ tenantId: TENANT, scope: SUB, role: 'viewer' }]);
    expect((await rows.listAssignmentsFor(ID.manualViewer)).map(r => r.origin)).toEqual([null]);
    expect(await users.getUser(ID.manualViewer)).toMatchObject({ accessSource: 'manual', linkedAccount: null, mirror: null });
  });
});
