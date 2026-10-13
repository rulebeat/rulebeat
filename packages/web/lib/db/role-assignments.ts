import { db } from './client';
import { roleAssignments } from './tables';
import { eq, and, sql } from 'drizzle-orm';
import { many, run, type DbHandle } from './exec';
import {
  EVERYTHING_SCOPE_PATH, EVERYTHING_TENANT_ID, parseScope, type Scope,
} from '@/lib/access-model';
import type { Role } from '@/lib/rbac';

/** One stored row: a Role held at a Scope path, as written. */
export interface RoleAssignment {
  userId: string;
  tenantId: string;
  scope: string;
  role: string;
}

export async function listAssignmentsFor(userId: string): Promise<RoleAssignment[]> {
  return many(db.select().from(roleAssignments).where(eq(roleAssignments.userId, userId)));
}

export async function listAllAssignments(): Promise<RoleAssignment[]> {
  return many(db.select().from(roleAssignments));
}

/** Removes everything a person holds. Takes the handle so it runs inside the caller's transaction. */
export async function deleteAssignmentsOn(tx: DbHandle, userId: string): Promise<void> {
  await run(tx.delete(roleAssignments).where(eq(roleAssignments.userId, userId)));
}

/** Gives a person exactly one row: `role` on Everything, replacing whatever they held. */
export async function replaceWithEverythingOn(tx: DbHandle, userId: string, role: Role): Promise<void> {
  await deleteAssignmentsOn(tx, userId);
  await run(tx.insert(roleAssignments).values({
    userId, tenantId: EVERYTHING_TENANT_ID, scope: EVERYTHING_SCOPE_PATH, role,
  }));
}

/** Sets the Role on every row a person holds, leaving the Scopes as they are. */
export async function setRoleOnAssignmentsOn(tx: DbHandle, userId: string, role: Role): Promise<void> {
  await run(tx.update(roleAssignments).set({ role }).where(eq(roleAssignments.userId, userId)));
}

/**
 * Grants a Role at a Scope, replacing a row for the same Scope in any casing: paths compare
 * case-insensitively and the stored casing is whatever the caller passed. Refuses a path that is
 * not a Scope, such as a single resource.
 */
export async function grantAssignmentOn(
  tx: DbHandle, userId: string, tenantId: string, scopePath: string, role: Role,
): Promise<Scope | null> {
  const scope = parseScope(scopePath);
  if (!scope) return null;
  await run(tx.delete(roleAssignments).where(and(
    eq(roleAssignments.userId, userId),
    eq(roleAssignments.tenantId, tenantId),
    sql`lower(${roleAssignments.scope}) = ${scopePath.toLowerCase()}`,
  )));
  await run(tx.insert(roleAssignments).values({ userId, tenantId, scope: scopePath, role }));
  return scope;
}
