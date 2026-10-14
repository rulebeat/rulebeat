import { listAssignmentsFor, listAllAssignments, type RoleAssignment } from '@/lib/db/role-assignments';
import { listUsers, type AppUser } from '@/lib/db/users';
import { buildAccess, everythingAccess, parseScope, type Access, type AccessSource, type ScopeGrant, type ScopeKind } from '@/lib/access-model';
import { listHierarchyNodes } from '@/lib/db/management-group-hierarchy';
import { expandManagementGroups, type HierarchyNode } from '@/lib/management-group-tree';
import { NEVER_MIRRORED, parseOrigins, type MirrorStatus, type MirroredScope } from '@/lib/access-mirror-model';
import { isRole, type Role } from '@/lib/rbac';

/**
 * A person together with the Access they resolve to: what the user routes and the Access page carry.
 * `mirroredScopes` is why each Scope of a mirrored person is held (the Azure roles that gave it), kept apart
 * from `Access`, which findings reads take and which has no use for provenance. Empty for anyone else.
 */
export type AppUserWithAccess = AppUser & { access: Access; mirroredScopes: MirroredScope[] };

/** The Scopes a mirrored person holds with the Azure roles that gave them. Nobody else has any. */
export function mirroredScopesOf(user: Pick<AppUser, 'role' | 'accessSource'>, rows: readonly RoleAssignment[]): MirroredScope[] {
  if (user.role === 'admin' || user.accessSource !== 'mirrored') return [];
  return rows
    .filter(row => parseScope(row.scope) !== null)
    .map(row => ({ scope: row.scope, origins: parseOrigins(row.origin) }));
}

/**
 * Builds a person's Access from the rows they hold. An Admin resolves to Everything without
 * reading any: an Admin is never scoped, so a stale row left by a rollback means nothing. For
 * anyone else a row that is not a Scope, or whose Role is not a Viewer or Editor, is ignored
 * (fail closed), and a person with no usable row holds nothing.
 *
 * `hierarchy` is RuleBeat's copy of the management group tree, and is what each management group grant is
 * expanded against. The grants stay as stored; the expansion is derived from them and from the tree as it is
 * now, so a subscription moved under a group is covered with no change to anyone's rows.
 */
export function accessFromAssignments(
  user: Pick<AppUser, 'role' | 'accessSource'>,
  rows: readonly RoleAssignment[],
  hierarchy: readonly HierarchyNode[] = [],
): Access {
  if (user.role === 'admin') return everythingAccess('admin');
  const grants: ScopeGrant[] = [];
  for (const row of rows) {
    const scope = parseScope(row.scope);
    if (!scope || !isRole(row.role) || row.role === 'admin') continue;
    grants.push({ tenantId: row.tenantId, scope, role: row.role });
  }
  return buildAccess(grants, user.accessSource, expandManagementGroups(grants, hierarchy));
}

const holdsManagementGroup = (rows: readonly RoleAssignment[]): boolean =>
  rows.some(r => parseScope(r.scope)?.kind === 'managementGroup');

/** Resolves one person's Access, once per request. The tree is read once, and only for someone who holds a management group. */
export async function resolveAccess(user: Pick<AppUser, 'id' | 'role' | 'accessSource'>): Promise<Access> {
  if (user.role === 'admin') return everythingAccess('admin');
  const rows = await listAssignmentsFor(user.id);
  return accessFromAssignments(user, rows, holdsManagementGroup(rows) ? await listHierarchyNodes() : []);
}

export async function withAccess(user: AppUser): Promise<AppUserWithAccess> {
  if (user.role === 'admin') return { ...user, access: everythingAccess('admin'), mirroredScopes: [] };
  const rows = await listAssignmentsFor(user.id);
  return {
    ...user,
    access: accessFromAssignments(user, rows, holdsManagementGroup(rows) ? await listHierarchyNodes() : []),
    mirroredScopes: mirroredScopesOf(user, rows),
  };
}

/** Everyone, with their Access, from one read of the assignment rows. */
export async function listUsersWithAccess(): Promise<AppUserWithAccess[]> {
  const [users, rows] = await Promise.all([listUsers(), listAllAssignments()]);
  const hierarchy = holdsManagementGroup(rows) ? await listHierarchyNodes() : [];
  return users.map(user => ({
    ...user,
    access: accessFromAssignments(user, rows.filter(r => r.userId === user.id), hierarchy),
    mirroredScopes: mirroredScopesOf(user, rows.filter(r => r.userId === user.id)),
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
  const linked = (u: AppUserWithAccess | null) => (u?.linkedAccount ? `${u.linkedAccount.tenantId}|${u.linkedAccount.objectId}` : null);
  if (linked(before) !== linked(after)) changed.push('linkedAccount');
  return changed;
}

/** The names of the access fields a removal takes away from the person, for the audit entry. Never their values. */
export function removedAccessFields(before: AppUserWithAccess): string[] {
  const removed = ['role'];
  if (before.accessSource !== null) removed.push('accessSource');
  if (before.role !== 'admin' && before.access.grants.length > 0) removed.push('assignments');
  if (before.linkedAccount) removed.push('linkedAccount');
  return removed;
}

/** One Scope a person holds, as their own access page and the own-access route show it: no tenant id. */
export interface OwnScope {
  kind: ScopeKind;
  path: string;
  role: Role;
}

/** What a person is told about their own access. */
export interface OwnAccess {
  role: Role;
  source: AccessSource | null;
  scopes: OwnScope[];
  /** How the last refresh of their Linked account went: when it last loaded, when it was last tried, and why it failed. Null unless mirrored. */
  mirror: MirrorStatus | null;
}

/**
 * A person's own access, for the page and the route that read it: the Role they hold, where it came from, each
 * Scope with its Role, and for a mirrored person the last refresh. Never the Linked account's object id.
 */
export function ownAccessOf(user: Pick<AppUser, 'role' | 'mirror'>, access: Access): OwnAccess {
  return {
    role: user.role,
    source: access.source,
    scopes: access.grants.map(g => ({ kind: g.scope.kind, path: g.scope.path, role: g.role })),
    mirror: access.source === 'mirrored' ? user.mirror ?? NEVER_MIRRORED : null,
  };
}
