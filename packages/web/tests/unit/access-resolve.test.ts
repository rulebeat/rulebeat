/**
 * #269: rows resolve into one Access value. An Admin resolves to Everything without reading a row,
 * anyone else from what they hold, and a row that is not a usable Scope or Role is ignored so a bad
 * row never widens anyone's access. The writes (invite, promote, demote, remove) keep the rows and
 * the Role together.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as hierarchyRepo from '@/lib/db/management-group-hierarchy';
import { fakeHierarchy, group, refreshFrom, subscription } from '../helpers/fake-hierarchy';
import { resetDb } from '../helpers/db';
import { createUser, deleteUser, updateUserRole, getUser, setManualAccess, setMirroredAccess, type AppUser } from '@/lib/db/users';
import { deleteAssignmentsOn, grantAssignmentOn, listAssignmentsFor } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { accessFromAssignments, changedAccessFields, listUsersWithAccess, resolveAccess, withAccess } from '@/lib/access';
import type { Role } from '@/lib/rbac';

const SUB = '/subscriptions/00000000-0000-0000-0000-000000000000';
const TENANT = '00000000-0000-0000-0000-000000000001';

async function make(email: string, role: Role): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

beforeEach(async () => { await resetDb(); });

describe('resolveAccess', () => {
  it('resolves an Admin to Everything without reading rows', async () => {
    const admin = await make('admin@example.com', 'admin');
    // A stale row on an Admin (left by a rollback) means nothing to resolution.
    await inTransaction(tx => grantAssignmentOn(tx, admin.id, TENANT, SUB, 'viewer'));

    const access = await resolveAccess(admin);

    expect(access).toMatchObject({ everything: true, directory: false, source: null });
    expect(access.grants).toEqual([{ tenantId: '', scope: { kind: 'everything', path: '/' }, role: 'admin' }]);
  });

  it('resolves an invited Editor to the Editor Role on Everything, source manual', async () => {
    const editor = await make('editor@example.com', 'editor');
    const access = await resolveAccess(editor);
    expect(access).toMatchObject({ everything: true, source: 'manual' });
    expect(access.grants.map(g => [g.scope.kind, g.role])).toEqual([['everything', 'editor']]);
  });

  it('resolves rows at narrower Scopes and sets the Directory flag', async () => {
    const person = await make('viewer@example.com', 'viewer');
    await inTransaction(async tx => {
      await deleteAssignmentsOn(tx, person.id);
      await grantAssignmentOn(tx, person.id, TENANT, SUB, 'editor');
      await grantAssignmentOn(tx, person.id, TENANT, '@directory', 'viewer');
    });

    const access = await resolveAccess((await getUser(person.id))!);

    expect(access).toMatchObject({ everything: false, directory: true, source: 'manual' });
    expect(access.grants.map(g => [g.scope.kind, g.role]).sort()).toEqual([['directory', 'viewer'], ['subscription', 'editor']]);
  });

  it('resolves a person with no rows to no grants, keeping their source', () => {
    const access = accessFromAssignments({ role: 'viewer', accessSource: 'manual' }, []);
    expect(access).toMatchObject({ grants: [], everything: false, directory: false, source: 'manual' });
  });

  it('ignores a row that is not a Scope, a Role it does not know, or an admin Role on a non-Admin', () => {
    const rows = [
      { userId: 'u', tenantId: '', scope: `${SUB}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm`, role: 'editor' },
      { userId: 'u', tenantId: '', scope: SUB, role: 'owner' },
      { userId: 'u', tenantId: '', scope: '/', role: 'admin' },
      { userId: 'u', tenantId: '', scope: `${SUB}/resourceGroups/rg-app`, role: 'viewer' },
    ];
    const access = accessFromAssignments({ role: 'editor', accessSource: 'manual' }, rows);
    expect(access.grants.map(g => g.scope.kind)).toEqual(['resourceGroup']);
    expect(access.everything).toBe(false);
  });
});

describe('writes keep the rows and the Role together', () => {
  it('invites a Viewer or Editor with one Everything row and the source manual', async () => {
    for (const role of ['viewer', 'editor'] as const) {
      const user = await make(`${role}@example.com`, role);
      expect(user.accessSource).toBe('manual');
      expect(await listAssignmentsFor(user.id)).toEqual([{ userId: user.id, tenantId: '', scope: '/', role, origin: null }]);
    }
  });

  it('invites an Admin with no rows and no source', async () => {
    const admin = await make('admin@example.com', 'admin');
    expect(admin.accessSource).toBeNull();
    expect(await listAssignmentsFor(admin.id)).toEqual([]);
  });

  it('sets the Role on the rows when a Viewer becomes an Editor and back', async () => {
    const user = await make('person@example.com', 'viewer');
    await make('admin@example.com', 'admin');

    await updateUserRole(user.id, 'editor');
    expect((await listAssignmentsFor(user.id)).map(r => r.role)).toEqual(['editor']);

    await updateUserRole(user.id, 'viewer');
    expect((await listAssignmentsFor(user.id)).map(r => r.role)).toEqual(['viewer']);
  });

  it('removes the rows and the source when promoting to Admin', async () => {
    const user = await make('person@example.com', 'editor');
    await updateUserRole(user.id, 'admin');
    expect(await listAssignmentsFor(user.id)).toEqual([]);
    expect((await getUser(user.id))!.accessSource).toBeNull();
  });

  it('gives an Everything row at the new Role, source manual, when demoting an Admin', async () => {
    const other = await make('other@example.com', 'admin');
    const admin = await make('admin@example.com', 'admin');
    await updateUserRole(admin.id, 'viewer');
    expect(await listAssignmentsFor(admin.id)).toEqual([{ userId: admin.id, tenantId: '', scope: '/', role: 'viewer', origin: null }]);
    expect((await getUser(admin.id))!.accessSource).toBe('manual');
    expect(other.role).toBe('admin');
  });

  it('removes the rows with the person', async () => {
    const user = await make('person@example.com', 'viewer');
    expect(await deleteUser(user.id)).toBe(true);
    expect(await listAssignmentsFor(user.id)).toEqual([]);
  });
});

describe('listUsersWithAccess and changedAccessFields', () => {
  it('returns every person with their Access from one read', async () => {
    await make('admin@example.com', 'admin');
    await make('viewer@example.com', 'viewer');
    const everyone = await listUsersWithAccess();
    expect(everyone.map(u => [u.email, u.access.everything, u.access.source])).toEqual([
      ['admin@example.com', true, null],
      ['viewer@example.com', true, 'manual'],
    ]);
  });

  it('names fields and never carries a value, a path or a tenant id', async () => {
    const admin = await make('admin@example.com', 'admin');
    const viewer = await make('viewer@example.com', 'viewer');
    const before = await withAccess(viewer);
    await updateUserRole(viewer.id, 'editor');
    const after = await withAccess((await getUser(viewer.id))!);

    expect(changedAccessFields(null, await withAccess(viewer))).toEqual(['role', 'accessSource', 'assignments']);
    expect(changedAccessFields(null, await withAccess(admin))).toEqual(['role']);
    expect(changedAccessFields(before, after)).toEqual(['role', 'assignments']);
    expect(changedAccessFields(after, after)).toEqual([]);
    expect(JSON.stringify(changedAccessFields(before, after))).not.toMatch(/editor|viewer|\/|0000/);
  });

  it('names linkedAccount when a Linked account is set, changed or cleared, and never carries the id', async () => {
    const OBJECT = '00000000-0000-0000-0000-0000000000c1';
    const OTHER = '00000000-0000-0000-0000-0000000000c2';
    const viewer = await make('viewer@example.com', 'viewer');
    const manual = await withAccess(viewer);

    await setMirroredAccess(viewer.id, { role: 'viewer', tenantId: TENANT, objectId: OBJECT, scopes: [], at: '2026-06-02T00:00:00.000Z' });
    const mirrored = await withAccess((await getUser(viewer.id))!);
    expect(changedAccessFields(manual, mirrored)).toEqual(['accessSource', 'assignments', 'linkedAccount']);
    expect(changedAccessFields(mirrored, mirrored)).toEqual([]);

    await setMirroredAccess(viewer.id, { role: 'viewer', tenantId: TENANT, objectId: OTHER, scopes: [], at: '2026-06-02T00:00:00.000Z' });
    const relinked = await withAccess((await getUser(viewer.id))!);
    expect(changedAccessFields(mirrored, relinked)).toEqual(['linkedAccount']);

    await setManualAccess(viewer.id, [{ tenantId: TENANT, scope: SUB, role: 'viewer' }]);
    const turnedManual = await withAccess((await getUser(viewer.id))!);
    const fields = changedAccessFields(relinked, turnedManual);
    expect(fields).toEqual(['accessSource', 'assignments', 'linkedAccount']);
    expect(JSON.stringify(fields)).not.toMatch(/0000|\//);
  });
});

describe('resolveAccess for a management group (#273)', () => {
  /** The fake tree's nodes belong to the tenant the grants in this file are stored under. */
  const inTenant = <T extends { tenantId: string }>(node: T): T => ({ ...node, tenantId: TENANT });

  const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';
  const SUB_IN = '00000000-0000-0000-0000-00000000000a';

  async function holder(): Promise<AppUser> {
    const person = await make('holder@example.com', 'viewer');
    await inTransaction(async tx => {
      await deleteAssignmentsOn(tx, person.id);
      await grantAssignmentOn(tx, person.id, TENANT, GROUP, 'editor');
      await grantAssignmentOn(tx, person.id, TENANT, SUB, 'viewer');
    });
    return (await getUser(person.id))!;
  }

  it('keeps the stored grants as they are and fills in what the group expands to, in the grant\'s Role', async () => {
    const fake = fakeHierarchy([
      inTenant(group(TENANT, 'Root', null)), inTenant(group('mg-example', 'Example', TENANT)), inTenant(group('mg-child', 'Child', 'mg-example')),
      inTenant(subscription(SUB_IN, 'In', 'mg-child')),
    ]);
    await refreshFrom(fake);

    const access = await resolveAccess(await holder());

    expect(access.grants.map(g => [g.scope.kind, g.scope.path, g.role]).sort()).toEqual([
      ['managementGroup', GROUP, 'editor'], ['subscription', SUB, 'viewer'],
    ]);
    expect(access.managementGroups).toEqual([{ tenantId: TENANT, path: GROUP, role: 'editor', groups: ['mg-example', 'mg-child'], subscriptions: [SUB_IN] }]);
  });

  it('expands to nothing while no tree has been read, and still keeps the grant', async () => {
    const access = await resolveAccess(await holder());
    expect(access.grants.map(g => g.scope.kind).sort()).toEqual(['managementGroup', 'subscription']);
    expect(access.managementGroups).toEqual([{ tenantId: TENANT, path: GROUP, role: 'editor', groups: [], subscriptions: [] }]);
  });

  it('reads the tree for someone who holds a management group, and for no one else', async () => {
    const listHierarchy = vi.spyOn(hierarchyRepo, 'listHierarchyNodes');
    await resolveAccess(await holder());
    expect(listHierarchy).toHaveBeenCalledTimes(1);

    listHierarchy.mockClear();
    const plain = await make('plain@example.com', 'editor');
    await resolveAccess((await getUser(plain.id))!);
    await resolveAccess(await make('admin@example.com', 'admin'));
    expect(listHierarchy).not.toHaveBeenCalled();
    listHierarchy.mockRestore();
  });

  it('gives everyone listed the same expansion from one read of the tree', async () => {
    await refreshFrom(fakeHierarchy([inTenant(group(TENANT, 'Root', null)), inTenant(group('mg-example', 'Example', TENANT)), inTenant(subscription(SUB_IN, 'In', 'mg-example'))]));
    const person = await holder();
    const listed = (await listUsersWithAccess()).find(u => u.id === person.id)!;
    expect(listed.access.managementGroups).toEqual([expect.objectContaining({ subscriptions: [SUB_IN] })]);
    expect(listed.access.grants.map(g => g.scope.kind).sort()).toEqual(['managementGroup', 'subscription']);
  });

  it('leaves the audit field names as they were: moving a subscription is not a change to anyone\'s access', async () => {
    const person = await holder();
    const before = await withAccess(person);
    await refreshFrom(fakeHierarchy([inTenant(group(TENANT, 'Root', null)), inTenant(group('mg-example', 'Example', TENANT)), inTenant(subscription(SUB_IN, 'In', 'mg-example'))]));
    expect(changedAccessFields(before, await withAccess(person))).toEqual([]);
  });
});
