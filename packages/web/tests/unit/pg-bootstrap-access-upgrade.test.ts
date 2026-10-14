/**
 * #269: the Postgres half of the access upgrade. A database bootstrapped before role assignments
 * existed gains the table and `users.access_source`, and the same plan the SQLite migration runs gives
 * every Viewer and Editor one Everything row and the source `manual` on the next boot. It changes no
 * user and no local account, leaves Admins alone, and a second boot changes nothing. Postgres only by
 * nature; skipped on the default SQLite run (db-migrations-access-upgrade.test.ts makes the same
 * assertions there).
 *
 * #305: three more cases mirror the SQLite file's checks of what an upgraded install does with access:
 * the bootstrap Admin variable clears a promoted person's Scopes, an upgraded Editor passes the real
 * `requireRole` for `rules:write`, and an upgraded Viewer reads every finding through the findings route
 * while a person narrowed to no Scope reads none. The product singleton already points at the database
 * `pgDb` bootstraps, so no module reset is needed to start the product.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { join, resolve } from 'path';
import { NextResponse } from 'next/server';
import { dbKind } from '@/lib/db/backend';
import { db as productDb, dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { seedPg } from '@/lib/db/pg/seeds';
import { requireRole } from '@/lib/api-auth';
import { listUsers } from '@/lib/db/users';
import { loadRules } from '@/lib/rules';
import { emptyView, viewToSearchParams } from '@/lib/finding-view';
import { deleteAssignmentsOn } from '@/lib/db/role-assignments';
import { GET as viewFindings } from '@/app/api/findings/view/route';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

// Anchored to this file: from the working directory the seeder quietly finds no packs and does nothing.
const DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');

const ID = {
  admin: 'pg-acc-admin',
  viewer: 'pg-acc-viewer',
  editor: 'pg-acc-editor',
  pendingViewer: 'pg-acc-pending-viewer',
  pendingEditor: 'pg-acc-pending-editor',
  withPassword: 'pg-acc-with-password',
  withOid: 'pg-acc-with-oid',
};

const raw = async (statement: string) => (await pgDb!.execute(sql.raw(statement))).rows as Record<string, unknown>[];

async function insertUser(id: string, role: string, oid: string | null = null, epoch = 0): Promise<void> {
  await raw(`
    INSERT INTO users (id, email, oid, name, role, session_epoch, created_at, last_seen_at)
    VALUES ('${id}', '${id}@example.com', ${oid ? `'${oid}'` : 'NULL'}, ${oid ? `'Name ${id}'` : 'NULL'}, '${role}', ${epoch},
      '2026-01-02T03:04:05.000Z', ${oid ? `'2026-02-03T04:05:06.000Z'` : 'NULL'})`);
}

/** The database as the previous release left it: no role_assignments table, no users.access_source. */
async function previousReleaseDatabase(): Promise<void> {
  await dbReady;
  await resetDb();
  await bootstrapPg(pgDb!);
  await raw('DROP TABLE role_assignments');
  await raw('ALTER TABLE users DROP COLUMN access_source');
  await raw('DELETE FROM users');
  await insertUser(ID.admin, 'admin', '00000000-0000-0000-0000-0000000000a1');
  await insertUser(ID.viewer, 'viewer');
  await insertUser(ID.editor, 'editor', null, 3);
  await insertUser(ID.pendingViewer, 'viewer');
  await insertUser(ID.pendingEditor, 'editor');
  await insertUser(ID.withPassword, 'viewer');
  await insertUser(ID.withOid, 'viewer', '00000000-0000-0000-0000-0000000000b1');
  await raw(`
    INSERT INTO local_accounts (user_id, password_hash, must_change_password, failed_attempts, locked_until, password_updated_at, created_at)
    VALUES ('${ID.withPassword}', 'scrypt$salt$hash', true, 2, NULL, '2026-01-03T00:00:00.000Z', '2026-01-02T03:04:05.000Z')`);
}

const rows = () => raw('SELECT user_id, tenant_id, scope, role FROM role_assignments ORDER BY user_id COLLATE "C"');
const sources = async () => Object.fromEntries((await raw('SELECT id, access_source FROM users')).map(r => [r.id, r.access_source]));
const USER_COLUMNS = 'id, email, oid, name, role, session_epoch, created_at, last_seen_at';
const whatMustNotMove = async () => ({
  users: await raw(`SELECT ${USER_COLUMNS} FROM users ORDER BY id COLLATE "C"`),
  accounts: await raw('SELECT * FROM local_accounts ORDER BY user_id COLLATE "C"'),
});

describe.skipIf(dbKind !== 'pg')('bootstrapPg gives existing people their access (#269)', () => {
  afterEach(async () => {
    mockAuth.mockReset();
    vi.unstubAllEnvs();
    await bootstrapPg(pgDb!);
    await resetDb();
  });

  it('gives every Viewer and Editor, pending invites included, one Everything row at their Role and the source manual', async () => {
    await previousReleaseDatabase();

    await bootstrapPg(pgDb!);

    expect(await rows()).toEqual([
      { user_id: ID.editor, tenant_id: '', scope: '/', role: 'editor' },
      { user_id: ID.pendingEditor, tenant_id: '', scope: '/', role: 'editor' },
      { user_id: ID.pendingViewer, tenant_id: '', scope: '/', role: 'viewer' },
      { user_id: ID.viewer, tenant_id: '', scope: '/', role: 'viewer' },
      { user_id: ID.withOid, tenant_id: '', scope: '/', role: 'viewer' },
      { user_id: ID.withPassword, tenant_id: '', scope: '/', role: 'viewer' },
    ]);
    expect(await sources()).toEqual({
      [ID.admin]: null,
      [ID.viewer]: 'manual', [ID.editor]: 'manual', [ID.pendingViewer]: 'manual', [ID.pendingEditor]: 'manual',
      [ID.withPassword]: 'manual', [ID.withOid]: 'manual',
    });
    expect(await raw(`SELECT id FROM users WHERE access_source = 'mirrored'`)).toEqual([]);
  });

  it('changes no user and no local account', async () => {
    await previousReleaseDatabase();
    const before = await whatMustNotMove();

    await bootstrapPg(pgDb!);

    expect(await whatMustNotMove()).toEqual(before);
  });

  it('leaves a second boot with nothing to change, and does not grant Everything again to a person narrowed to no Scope', async () => {
    await previousReleaseDatabase();
    await bootstrapPg(pgDb!);
    await raw(`DELETE FROM role_assignments WHERE user_id = '${ID.viewer}'`);
    const first = { rows: await rows(), sources: await sources(), ...(await whatMustNotMove()) };

    await bootstrapPg(pgDb!);

    expect({ rows: await rows(), sources: await sources(), ...(await whatMustNotMove()) }).toEqual(first);
    expect((await rows()).map(r => r.user_id)).not.toContain(ID.viewer);
  });

  it('clears the rows and the source of a person the bootstrap variable promotes to Admin', async () => {
    await previousReleaseDatabase();
    await raw(`DELETE FROM users WHERE role = 'admin'`);
    vi.stubEnv('RULEBEAT_INITIAL_ADMIN', `${ID.viewer}@example.com`);

    await bootstrapPg(pgDb!);
    await seedPg(pgDb!, DATA_DIR, { skipOwnerBootstrap: true });

    expect(await raw(`SELECT role FROM users WHERE id = '${ID.viewer}'`)).toEqual([{ role: 'admin' }]);
    expect((await rows()).map(r => r.user_id)).not.toContain(ID.viewer);
    expect((await sources())[ID.viewer]).toBeNull();
    expect((await rows()).map(r => r.user_id)).toContain(ID.editor);
  });

  it('lets the upgraded Editor pass the real requireRole for rules:write once the product starts', async () => {
    await previousReleaseDatabase();
    await bootstrapPg(pgDb!);
    mockAuth.mockResolvedValue({ user: { uid: ID.editor, epoch: 3 } });

    const result = await requireRole('rules:write');
    if (result instanceof NextResponse) throw new Error(`refused with ${result.status}`);
    expect(result.access).toMatchObject({ everything: true, source: 'manual' });
    expect(result.access.grants.map(g => g.role)).toEqual(['editor']);

    mockAuth.mockResolvedValue({ user: { uid: ID.viewer } });
    expect(((await requireRole('rules:write')) as NextResponse).status).toBe(403);
    expect(await requireRole('read')).not.toBeInstanceOf(NextResponse);
    expect((await listUsers()).find(u => u.id === ID.viewer)?.accessSource).toBe('manual');
  });

  it('lets an upgraded Viewer read every finding through the findings route, and a person narrowed to no Scope none (#267)', async () => {
    await previousReleaseDatabase();
    await bootstrapPg(pgDb!);
    const ruleId = (await loadRules()).find(r => r.queryBackend === 'resource-graph')!.id;
    await storeScan([
      syntheticFinding('vm-one', [{}], { ruleId, subscriptionId: 'sub-1' }),
      syntheticFinding('vm-two', [{}], { ruleId, subscriptionId: 'sub-2' }),
    ], { scanId: 'scan-after-upgrade', finishedAt: '2026-01-04T00:00:00.000Z' });
    const names = async (uid: string) => {
      mockAuth.mockResolvedValue({ user: { uid } });
      const res = await viewFindings(new Request(`http://localhost/api/findings/view?${viewToSearchParams(emptyView(), { tab: 'results' })}`));
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: { finding: { resourceName: string } }[] }).items.map(i => i.finding.resourceName).sort();
    };

    expect(await names(ID.viewer)).toEqual(['vm-one', 'vm-two']);
    expect(await names(ID.pendingEditor)).toEqual(['vm-one', 'vm-two']);
    await deleteAssignmentsOn(productDb, ID.withOid);
    expect(await names(ID.withOid)).toEqual([]);
  });
});
