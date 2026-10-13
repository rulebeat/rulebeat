import { listAssignmentsFor, listAllAssignments, type RoleAssignment } from '@/lib/db/role-assignments';
import { listUsers, type AppUser } from '@/lib/db/users';
import { buildAccess, everythingAccess, parseScope, type Access, type ScopeGrant } from '@/lib/access-model';
import { isRole } from '@/lib/rbac';

/** A person together with the Access they resolve to: what the user routes and the Access page carry. */
export type AppUserWithAccess = AppUser & { access: Access };

/**
 * Builds a person's Access from the rows they hold. An Admin resolves to Everything without
 * reading any: an Admin is never scoped, so a stale row left by a rollback means nothing. For
 * anyone else a row that is not a Scope, or whose Role is not a Viewer or Editor, is ignored
 * (fail closed), and a person with no usable row holds nothing.
 */
export function accessFromAssignments(
  user: Pick<AppUser, 'role' | 'accessSource'>,
  rows: readonly RoleAssignment[],
): Access {
  if (user.role === 'admin') return everythingAccess('admin');
  const grants: ScopeGrant[] = [];
  for (const row of rows) {
    const scope = parseScope(row.scope);
    if (!scope || !isRole(row.role) || row.role === 'admin') continue;
    grants.push({ tenantId: row.tenantId, scope, role: row.role });
  }
  return buildAccess(grants, user.accessSource);
}

/** Resolves one person's Access, once per request. */
export async function resolveAccess(user: Pick<AppUser, 'id' | 'role' | 'accessSource'>): Promise<Access> {
  if (user.role === 'admin') return everythingAccess('admin');
  return accessFromAssignments(user, await listAssignmentsFor(user.id));
}

export async function withAccess(user: AppUser): Promise<AppUserWithAccess> {
  return { ...user, access: await resolveAccess(user) };
}

/** Everyone, with their Access, from one read of the assignment rows. */
export async function listUsersWithAccess(): Promise<AppUserWithAccess[]> {
  const [users, rows] = await Promise.all([listUsers(), listAllAssignments()]);
  return users.map(user => ({
    ...user,
    access: accessFromAssignments(user, rows.filter(r => r.userId === user.id)),
  }));
}

/**
 * The fields of a person's access that differ between two states, by name only: what the audit log
 * records. A Scope path, a tenant id and a Role value never appear in it. `before` is null for a
 * person who did not exist yet.
 */
export function changedAccessFields(before: AppUserWithAccess | null, after: AppUserWithAccess): string[] {
  const stored = (u: AppUserWithAccess | null) =>
    !u || u.role === 'admin'
      ? []
      : u.access.grants.map(g => `${g.tenantId}|${g.scope.path.toLowerCase()}|${g.role}`).sort();
  const changed: string[] = [];
  if (before?.role !== after.role) changed.push('role');
  if ((before?.accessSource ?? null) !== after.accessSource) changed.push('accessSource');
  if (JSON.stringify(stored(before)) !== JSON.stringify(stored(after))) changed.push('assignments');
  return changed;
}
