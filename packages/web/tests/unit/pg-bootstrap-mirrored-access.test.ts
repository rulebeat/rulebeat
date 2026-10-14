/**
 * #278: the Postgres half of the Mirrored access upgrade. A database bootstrapped before it existed gains the
 * Linked account columns on users and the origin column on role_assignments on the next boot, and changes no
 * user, source, row or local account. Nobody is mirrored and the new columns hold nothing. Postgres only by
 * nature; skipped on the default SQLite run (db-migrations-mirrored-access.test.ts makes the same assertions there).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { resetDb } from '../helpers/db';

const ID = {
  admin: 'pg-mir-admin',
  manualViewer: 'pg-mir-manual-viewer',
  manualEditor: 'pg-mir-manual-editor',
  narrowed: 'pg-mir-narrowed',
  withPassword: 'pg-mir-with-password',
};

const NEW_USER_COLUMNS = ['linked_tenant_id', 'linked_object_id', 'mirror_last_success_at', 'mirror_last_attempt_at', 'mirror_error'];
const SUB = '/subscriptions/00000000-0000-0000-0000-00000000000a';
const TENANT = '00000000-0000-0000-0000-0000000000f0';

const raw = async (statement: string) => (await pgDb!.execute(sql.raw(statement))).rows as Record<string, unknown>[];

async function insertUser(id: string, role: string, source: string | null, oid: string | null = null): Promise<void> {
  await raw(`
    INSERT INTO users (id, email, oid, name, role, access_source, session_epoch, created_at, last_seen_at)
    VALUES ('${id}', '${id}@example.com', ${oid ? `'${oid}'` : 'NULL'}, ${oid ? `'Name ${id}'` : 'NULL'}, '${role}',
      ${source ? `'${source}'` : 'NULL'}, 2, '2026-01-02T03:04:05.000Z', ${oid ? `'2026-02-03T04:05:06.000Z'` : 'NULL'})`);
}

const insertRow = (userId: string, tenantId: string, scope: string, role: string) =>
  raw(`INSERT INTO role_assignments (user_id, tenant_id, scope, role) VALUES ('${userId}', '${tenantId}', '${scope}', '${role}')`);

/** The database as the previous release left it: people with sources and rows, no Linked account and no origin column. */
async function previousReleaseDatabase(): Promise<void> {
  await dbReady;
  await resetDb();
  await bootstrapPg(pgDb!);
  for (const column of NEW_USER_COLUMNS) await raw(`ALTER TABLE users DROP COLUMN ${column}`);
  await raw('ALTER TABLE role_assignments DROP COLUMN origin');
  await raw('DELETE FROM users');
  await insertUser(ID.admin, 'admin', null, '00000000-0000-0000-0000-0000000000a1');
  await insertUser(ID.manualViewer, 'viewer', 'manual');
  await insertUser(ID.manualEditor, 'editor', 'manual', '00000000-0000-0000-0000-0000000000b1');
  await insertUser(ID.narrowed, 'viewer', 'manual');
  await insertUser(ID.withPassword, 'editor', 'manual');
  await insertRow(ID.manualViewer, '', '/', 'viewer');
  await insertRow(ID.manualEditor, TENANT, SUB, 'editor');
  await insertRow(ID.manualEditor, TENANT, `${SUB}/resourceGroups/rg-one`, 'editor');
  await insertRow(ID.withPassword, TENANT, SUB, 'editor');
  await raw(`
    INSERT INTO local_accounts (user_id, password_hash, must_change_password, failed_attempts, locked_until, password_updated_at, created_at)
    VALUES ('${ID.withPassword}', 'scrypt$salt$hash', true, 2, NULL, '2026-01-03T00:00:00.000Z', '2026-01-02T03:04:05.000Z')`);
}

const USER_COLUMNS = 'id, email, oid, name, role, access_source, session_epoch, created_at, last_seen_at, scope';
const whatMustNotMove = async () => ({
  users: await raw(`SELECT ${USER_COLUMNS} FROM users ORDER BY id COLLATE "C"`),
  rows: await raw('SELECT user_id, tenant_id, scope, role FROM role_assignments ORDER BY user_id COLLATE "C", scope COLLATE "C"'),
  accounts: await raw('SELECT * FROM local_accounts ORDER BY user_id COLLATE "C"'),
});
const columnsOf = async (table: string) =>
  (await raw(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`)).map(c => c.column_name as string);

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds Mirrored access (#278)', () => {
  afterEach(async () => {
    await bootstrapPg(pgDb!);
    await resetDb();
  });

  it('adds the Linked account columns to users and the origin column to role_assignments', async () => {
    await previousReleaseDatabase();
    expect(await columnsOf('users')).not.toContain('linked_object_id');

    await bootstrapPg(pgDb!);

    expect(await columnsOf('users')).toEqual(expect.arrayContaining(NEW_USER_COLUMNS));
    expect(await columnsOf('role_assignments')).toContain('origin');
  });

  it('leaves every user, source, row and local account as it was', async () => {
    await previousReleaseDatabase();
    const before = await whatMustNotMove();
    expect(before.users).toHaveLength(5);
    expect(before.rows).toHaveLength(4);

    await bootstrapPg(pgDb!);

    expect(await whatMustNotMove()).toEqual(before);
    expect(await raw('SELECT password_hash FROM local_accounts')).toEqual([{ password_hash: 'scrypt$salt$hash' }]);
  });

  it('mirrors nobody, and leaves the new columns null on every person and every row', async () => {
    await previousReleaseDatabase();

    await bootstrapPg(pgDb!);

    expect(await raw(`SELECT id FROM users WHERE access_source = 'mirrored'`)).toEqual([]);
    for (const user of await raw(`SELECT ${NEW_USER_COLUMNS.join(', ')} FROM users`)) {
      expect(Object.values(user)).toEqual([null, null, null, null, null]);
    }
    expect((await raw('SELECT origin FROM role_assignments')).map(r => r.origin)).toEqual([null, null, null, null]);
  });

  it('leaves a second boot with nothing to change', async () => {
    await previousReleaseDatabase();
    await bootstrapPg(pgDb!);
    const first = await whatMustNotMove();

    await bootstrapPg(pgDb!);

    expect(await whatMustNotMove()).toEqual(first);
  });
});
