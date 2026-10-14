import { db } from './client';
import { users, savedQueries, queryRuns, personalRules, personalRuleResults } from './tables';
import { eq, and, asc, count, sql, inArray } from 'drizzle-orm';
import { many, one, run, inTransaction, type DbHandle } from './exec';
import { dbKind } from './backend';
import { isRole, type Role } from '@/lib/rbac';
import { highestRole, isAccessSource, parseScope, type AccessSource, type GrantRole } from '@/lib/access-model';
import {
  isMirrorErrorCode, mirrorError, type MirrorErrorCode, type MirrorStatus, type MirroredScope,
} from '@/lib/access-mirror-model';
import {
  deleteAssignmentsOn, replaceAssignmentsOn, replaceWithEverythingOn, setRoleOnAssignmentsOn, type AssignmentInput,
} from './role-assignments';

export interface AppUser {
  id: string;
  email: string;
  /** Entra object id. Null while the user has been assigned a role but never signed in. */
  oid: string | null;
  name: string | null;
  role: Role;
  /** Where a Viewer's or Editor's access came from. Null for an Admin. */
  accessSource: AccessSource | null;
  /** The Azure account a mirrored person's Scopes follow, and the tenant it was read in. Null unless mirrored. */
  linkedAccount: { tenantId: string; objectId: string } | null;
  /** How the last refresh of a mirrored person went. Null unless mirrored. */
  mirror: MirrorStatus | null;
  /** Bumped by bumpSessionEpoch() on any local-password mutation: see spec 020. */
  sessionEpoch: number;
  createdAt: string;
  lastSeenAt: string | null;
}

type Row = typeof users.$inferSelect;

function rowToUser(row: Row): AppUser {
  const accessSource = isAccessSource(row.accessSource) ? row.accessSource : null;
  const mirrored = accessSource === 'mirrored';
  return {
    id: row.id,
    email: row.email,
    oid: row.oid ?? null,
    name: row.name ?? null,
    role: isRole(row.role) ? row.role : 'viewer',
    accessSource,
    linkedAccount: mirrored && row.linkedObjectId && row.linkedTenantId
      ? { tenantId: row.linkedTenantId, objectId: row.linkedObjectId }
      : null,
    mirror: mirrored
      ? {
        lastSuccessAt: row.mirrorLastSuccessAt ?? null,
        lastAttemptAt: row.mirrorLastAttemptAt ?? null,
        error: isMirrorErrorCode(row.mirrorError) ? mirrorError(row.mirrorError) : null,
      }
      : null,
    sessionEpoch: row.sessionEpoch,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt ?? null,
  };
}

export async function listUsers(): Promise<AppUser[]> {
  const rows = await many(db.select().from(users).orderBy(asc(users.email)));
  return rows.map(rowToUser);
}

/** Everyone on Mirrored access, ordered by email. An Admin never is: their access source is cleared. */
export async function listMirroredUsers(): Promise<AppUser[]> {
  const rows = await many(db.select().from(users).where(eq(users.accessSource, 'mirrored')).orderBy(asc(users.email)));
  return rows.map(rowToUser);
}

export async function getUserByOid(oid: string): Promise<AppUser | null> {
  const row = await one(db.select().from(users).where(eq(users.oid, oid)));
  return row ? rowToUser(row) : null;
}

export async function getUserByEmail(email: string): Promise<AppUser | null> {
  const row = await one(db.select().from(users).where(eq(users.email, email.trim().toLowerCase())));
  return row ? rowToUser(row) : null;
}

async function getUserOn(handle: DbHandle, id: string): Promise<AppUser | null> {
  const row = await one(handle.select().from(users).where(eq(users.id, id)));
  return row ? rowToUser(row) : null;
}

export async function getUser(id: string): Promise<AppUser | null> {
  return getUserOn(db, id);
}

async function countAdminsOn(handle: DbHandle): Promise<number> {
  const row = await one(handle.select({ n: count() }).from(users).where(eq(users.role, 'admin')));
  return row?.n ?? 0;
}

export async function countAdmins(): Promise<number> {
  return countAdminsOn(db);
}

/**
 * Takes a row lock on every admin before this transaction counts them, so a second concurrent
 * transaction doing the same last-admin check waits here instead of reading a stale count. A
 * no-op on SQLite: `inTransaction()`'s `BEGIN IMMEDIATE` plus its in-process lock already
 * serialises every writer against the single connection, so a second call never even starts
 * until the first has committed. On Postgres (default READ COMMITTED, where a plain `SELECT
 * COUNT(*)` inside a transaction does NOT by itself see a concurrent transaction's in-flight
 * write), `SELECT ... FOR UPDATE` blocks until any transaction holding the lock finishes; once
 * unblocked, Postgres re-evaluates the row against the WHERE clause against its latest committed
 * version, so a row demoted out of `role = 'admin'` by the transaction that just committed drops
 * out of the lock set here too, and the count taken right after sees the up-to-date state.
 * `.for('update')` isn't reachable through the SQLite-typed builder every repository builds
 * queries on (see tables.ts), hence the raw statement.
 */
async function lockAdminRowsForUpdate(tx: DbHandle): Promise<void> {
  if (dbKind !== 'pg') return;
  await (tx as unknown as { execute(query: unknown): Promise<unknown> }).execute(
    sql`SELECT id FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE`,
  );
}

/** What turning someone to Manual access, or making them an Admin, writes over a Linked account and its status. */
const NO_MIRROR = {
  linkedTenantId: null, linkedObjectId: null, mirrorLastSuccessAt: null, mirrorLastAttemptAt: null, mirrorError: null,
} as const;

/**
 * Creates a person. A Viewer or Editor holds what `access` says: Manual access an Admin chose, and the
 * Role they hold is the highest among its rows. With no `access` they start with Everything at `role`,
 * which is what a caller that has nothing to ask (a test, the Demo) gets; the invite route never leaves
 * it out. An Admin holds Everything without a row and has no source.
 */
export async function createUser(
  data: { email: string; role: Role; oid?: string; name?: string; access?: readonly AssignmentInput[] },
): Promise<{ user: AppUser } | { error: string }> {
  const email = data.email.trim().toLowerCase();
  if (!email) return { error: 'Email is required.' };
  if (!email.includes('@')) return { error: 'Enter a valid email address.' };
  if (await getUserByEmail(email)) return { error: `${email} already has a role assigned.` };

  const id = globalThis.crypto.randomUUID();
  const role = data.role !== 'admin' && data.access ? highestRole(data.access) : data.role;
  await inTransaction(async (tx) => {
    await run(tx.insert(users).values({
      id,
      email,
      oid: data.oid ?? null,
      name: data.name ?? null,
      role,
      accessSource: data.role === 'admin' ? null : 'manual',
      createdAt: new Date().toISOString(),
      lastSeenAt: data.oid ? new Date().toISOString() : null,
    }));
    if (data.role === 'admin') return;
    if (data.access) await replaceAssignmentsOn(tx, id, data.access);
    else await replaceWithEverythingOn(tx, id, data.role);
  });

  return { user: (await getUser(id))! };
}

/**
 * The last-admin check and the role write happen inside one `inTransaction()` call so no second
 * concurrent call can read the same "still 2 admins" count this one just acted on. See
 * `lockAdminRowsForUpdate()` for how that holds on Postgres as well as SQLite.
 */
export async function updateUserRole(
  id: string, role: Role, access?: readonly AssignmentInput[],
): Promise<{ user: AppUser } | { error: string } | null> {
  return inTransaction(async (tx) => {
    const existing = await getUserOn(tx, id);
    if (!existing) return null;
    if (existing.role === role) return { user: existing };

    if (existing.role === 'admin') {
      await lockAdminRowsForUpdate(tx);
      if (await countAdminsOn(tx) === 1) {
        return { error: 'This is the only admin. Promote someone else to admin first.' };
      }
    }

    if (role === 'admin') {
      // An Admin is never scoped: no rows, no source.
      await run(tx.update(users).set({ role, accessSource: null, ...NO_MIRROR }).where(eq(users.id, id)));
      await deleteAssignmentsOn(tx, id);
    } else if (existing.role === 'admin') {
      // Demoting an Admin: the access the caller chose, else Everything at the new Role.
      await run(tx.update(users).set({ role: access ? highestRole(access) : role, accessSource: 'manual', ...NO_MIRROR }).where(eq(users.id, id)));
      if (access) await replaceAssignmentsOn(tx, id, access);
      else await replaceWithEverythingOn(tx, id, role);
    } else {
      await run(tx.update(users).set({ role }).where(eq(users.id, id)));
      await setRoleOnAssignmentsOn(tx, id, role);
    }
    return { user: (await getUserOn(tx, id))! };
  });
}

/**
 * Replaces a Viewer's or Editor's Manual access with exactly `access` and marks it manual, in one
 * transaction. The Role on the person is the highest among the rows (a Viewer when there are none), so
 * a page or sidebar that reads `users.role` has a defined value once Roles differ per Scope. An Admin is
 * never scoped, so they are refused rather than given rows that mean nothing. A mirrored person turned manual
 * here keeps no Linked account, no status and no origins: the mirror can never overwrite a hand-made change.
 */
export async function setManualAccess(
  id: string, access: readonly AssignmentInput[],
): Promise<{ user: AppUser } | 'notfound' | 'admin'> {
  return inTransaction(async (tx) => {
    const existing = await getUserOn(tx, id);
    if (!existing) return 'notfound';
    if (existing.role === 'admin') return 'admin';
    await run(tx.update(users).set({ role: highestRole(access), accessSource: 'manual', ...NO_MIRROR }).where(eq(users.id, id)));
    await replaceAssignmentsOn(tx, id, access);
    return { user: (await getUserOn(tx, id))! };
  });
}

/** The rows a mirror writes: its Scopes at one Role, each with why Azure gave it. Everything and the Directory are never one. */
function mirroredRows(role: GrantRole, tenantId: string, scopes: readonly MirroredScope[]): AssignmentInput[] {
  return scopes
    .filter(s => {
      const kind = parseScope(s.scope)?.kind;
      return kind === 'managementGroup' || kind === 'subscription' || kind === 'resourceGroup';
    })
    .map(s => ({ tenantId, scope: s.scope, role, origins: s.origins }));
}

/**
 * Gives a Viewer or Editor Mirrored access in one transaction: the source, the Role, the Linked account, the
 * Scopes the mirror read with their origins, and the status of this first read. Any Manual rows are replaced.
 * `tenantId` is the one RuleBeat resolved on the server. An Admin is refused: an Admin is never scoped.
 */
export async function setMirroredAccess(
  id: string,
  mirrored: { role: GrantRole; tenantId: string; objectId: string; scopes: readonly MirroredScope[]; at: string },
): Promise<{ user: AppUser } | 'notfound' | 'admin'> {
  return inTransaction(async (tx) => {
    const existing = await getUserOn(tx, id);
    if (!existing) return 'notfound';
    if (existing.role === 'admin') return 'admin';
    await run(tx.update(users).set({
      role: mirrored.role,
      accessSource: 'mirrored',
      linkedTenantId: mirrored.tenantId,
      linkedObjectId: mirrored.objectId,
      mirrorLastSuccessAt: mirrored.at,
      mirrorLastAttemptAt: mirrored.at,
      mirrorError: null,
    }).where(eq(users.id, id)));
    await replaceAssignmentsOn(tx, id, mirroredRows(mirrored.role, mirrored.tenantId, mirrored.scopes));
    return { user: (await getUserOn(tx, id))! };
  });
}

/** Whether a person is still mirrored to this account: what a refresh that took a while must find true before it writes. */
function stillMirroredTo(user: AppUser | null, objectId: string): user is AppUser {
  return !!user && user.role !== 'admin' && user.accessSource === 'mirrored' && user.linkedAccount?.objectId === objectId;
}

/**
 * Stores a successful refresh: replaces the person's rows with the Scopes it read, at the Role they hold now,
 * and records the success. Writes only when the person is still mirrored to the same object id. A refresh
 * that was slow, and found them turned manual, promoted or linked elsewhere in the meantime, writes nothing
 * and answers 'stale', so it can never overwrite a hand-made change.
 */
export async function recordMirrorRefresh(
  id: string, refreshed: { objectId: string; tenantId: string; scopes: readonly MirroredScope[]; at: string },
): Promise<{ user: AppUser } | 'stale'> {
  return inTransaction(async (tx) => {
    const existing = await getUserOn(tx, id);
    if (!stillMirroredTo(existing, refreshed.objectId)) return 'stale';
    await run(tx.update(users).set({
      linkedTenantId: refreshed.tenantId,
      mirrorLastSuccessAt: refreshed.at,
      mirrorLastAttemptAt: refreshed.at,
      mirrorError: null,
    }).where(eq(users.id, id)));
    await replaceAssignmentsOn(tx, id, mirroredRows(existing.role as GrantRole, refreshed.tenantId, refreshed.scopes));
    return { user: (await getUserOn(tx, id))! };
  });
}

/**
 * Records a failed refresh: the attempt and a stable code. The rows and the time of the last success stay as
 * they were. Writes only when the person is still mirrored to the same object id, like a successful one.
 */
export async function recordMirrorFailure(
  id: string, failed: { objectId: string; code: MirrorErrorCode; at: string },
): Promise<{ user: AppUser } | 'stale'> {
  return inTransaction(async (tx) => {
    const existing = await getUserOn(tx, id);
    if (!stillMirroredTo(existing, failed.objectId)) return 'stale';
    await run(tx.update(users).set({ mirrorLastAttemptAt: failed.at, mirrorError: failed.code }).where(eq(users.id, id)));
    return { user: (await getUserOn(tx, id))! };
  });
}

/** Everyone, other than `exceptId`, who is mirrored to this account. A shared account is worth telling an Admin about. */
export async function listUsersLinkedTo(objectId: string, exceptId?: string): Promise<{ id: string; email: string }[]> {
  const rows = await many(
    db.select({ id: users.id, email: users.email, linked: users.linkedObjectId })
      .from(users).where(eq(users.accessSource, 'mirrored')).orderBy(asc(users.email)),
  );
  const wanted = objectId.toLowerCase();
  return rows
    .filter(r => r.id !== exceptId && r.linked?.toLowerCase() === wanted)
    .map(r => ({ id: r.id, email: r.email }));
}

/**
 * The last-admin check and every delete run inside one transaction: the check can't be
 * raced the same way `updateUserRole`'s can't (see `lockAdminRowsForUpdate()`), and a failure
 * part-way through the deletes rolls every one of them back instead of leaving the user row gone
 * but their saved queries or run history still present, or vice versa.
 */
export async function deleteUser(id: string): Promise<boolean | 'notfound' | 'last-admin'> {
  return inTransaction(async (tx) => {
    const existing = await getUserOn(tx, id);
    if (!existing) return 'notfound';

    if (existing.role === 'admin') {
      await lockAdminRowsForUpdate(tx);
      if (await countAdminsOn(tx) === 1) return 'last-admin';
    }

    // Private saved queries (spec 037) are personal scratch state: delete them with their owner.
    // Shared ones stay (ownerEmail is denormalized precisely so they keep reading correctly afterward).
    await run(tx.delete(savedQueries).where(and(eq(savedQueries.ownerId, id), eq(savedQueries.visibility, 'private'))));
    // Run history (spec 037 follow-up) has no shared visibility at all: it's always fully personal,
    // so every row goes, not just a 'private' subset.
    await run(tx.delete(queryRuns).where(eq(queryRuns.ownerId, id)));
    // Personal rules (#280) and their stored results are the author's alone: both go with them.
    await run(tx.delete(personalRuleResults).where(inArray(
      personalRuleResults.personalRuleId,
      tx.select({ id: personalRules.id }).from(personalRules).where(eq(personalRules.ownerId, id)),
    )));
    await run(tx.delete(personalRules).where(eq(personalRules.ownerId, id)));
    await deleteAssignmentsOn(tx, id);
    await run(tx.delete(users).where(eq(users.id, id)));
    return true;
  });
}

/** Binds an Entra object id to a row that was created by email before that person ever signed in. */
export async function linkOid(id: string, oid: string, name?: string | null): Promise<void> {
  await run(db.update(users).set({
    oid,
    ...(name ? { name } : {}),
    lastSeenAt: new Date().toISOString(),
  }).where(eq(users.id, id)));
}

export async function touchLastSeen(id: string, name?: string | null): Promise<void> {
  await run(db.update(users).set({
    lastSeenAt: new Date().toISOString(),
    ...(name ? { name } : {}),
  }).where(eq(users.id, id)));
}

/** Invalidates every outstanding JWT for this account: see spec 020. */
export async function bumpSessionEpoch(id: string): Promise<void> {
  await run(db.update(users).set({ sessionEpoch: sql`session_epoch + 1` }).where(eq(users.id, id)));
}
