import { db } from './client';
import { users, savedQueries, queryRuns } from './schema';
import { eq, and, asc, count, sql } from 'drizzle-orm';
import { isRole, type Role } from '@/lib/rbac';

export interface AppUser {
  id: string;
  email: string;
  /** Entra object id. Null while the user has been assigned a role but never signed in. */
  oid: string | null;
  name: string | null;
  role: Role;
  /** Reserved for scoped roles ("this team only sees these subscriptions"). Always null today. */
  scope: string | null;
  /** Bumped by bumpSessionEpoch() on any local-password mutation — see spec 020. */
  sessionEpoch: number;
  createdAt: string;
  lastSeenAt: string | null;
}

type Row = typeof users.$inferSelect;

function rowToUser(row: Row): AppUser {
  return {
    id: row.id,
    email: row.email,
    oid: row.oid ?? null,
    name: row.name ?? null,
    role: isRole(row.role) ? row.role : 'viewer',
    scope: row.scope ?? null,
    sessionEpoch: row.sessionEpoch,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt ?? null,
  };
}

export function listUsers(): AppUser[] {
  return db.select().from(users).orderBy(asc(users.email)).all().map(rowToUser);
}

export function getUserByOid(oid: string): AppUser | null {
  const row = db.select().from(users).where(eq(users.oid, oid)).get();
  return row ? rowToUser(row) : null;
}

export function getUserByEmail(email: string): AppUser | null {
  const row = db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
  return row ? rowToUser(row) : null;
}

export function getUser(id: string): AppUser | null {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  return row ? rowToUser(row) : null;
}

export function countAdmins(): number {
  return db.select({ n: count() }).from(users).where(eq(users.role, 'admin')).get()?.n ?? 0;
}

export function createUser(data: { email: string; role: Role; oid?: string; name?: string }): { user: AppUser } | { error: string } {
  const email = data.email.trim().toLowerCase();
  if (!email) return { error: 'Email is required.' };
  if (!email.includes('@')) return { error: 'Enter a valid email address.' };
  if (getUserByEmail(email)) return { error: `${email} already has a role assigned.` };

  const id = globalThis.crypto.randomUUID();
  db.insert(users).values({
    id,
    email,
    oid: data.oid ?? null,
    name: data.name ?? null,
    role: data.role,
    scope: null,
    createdAt: new Date().toISOString(),
    lastSeenAt: data.oid ? new Date().toISOString() : null,
  }).run();

  return { user: getUser(id)! };
}

export function updateUserRole(id: string, role: Role): { user: AppUser } | { error: string } | null {
  const existing = getUser(id);
  if (!existing) return null;
  if (existing.role === role) return { user: existing };
  if (existing.role === 'admin' && countAdmins() === 1) {
    return { error: 'This is the only admin. Promote someone else to admin first.' };
  }

  db.update(users).set({ role }).where(eq(users.id, id)).run();
  return { user: getUser(id)! };
}

export function deleteUser(id: string): boolean | 'notfound' | 'last-admin' {
  const existing = getUser(id);
  if (!existing) return 'notfound';
  if (existing.role === 'admin' && countAdmins() === 1) return 'last-admin';

  // Private saved queries (spec 037) are personal scratch state — delete them with their owner.
  // Shared ones stay (ownerEmail is denormalized precisely so they keep reading correctly afterward).
  db.delete(savedQueries).where(and(eq(savedQueries.ownerId, id), eq(savedQueries.visibility, 'private'))).run();
  // Run history (spec 037 follow-up) has no shared visibility at all — it's always fully personal,
  // so every row goes, not just a 'private' subset.
  db.delete(queryRuns).where(eq(queryRuns.ownerId, id)).run();
  db.delete(users).where(eq(users.id, id)).run();
  return true;
}

/** Binds an Entra object id to a row that was created by email before that person ever signed in. */
export function linkOid(id: string, oid: string, name?: string | null): void {
  db.update(users).set({
    oid,
    ...(name ? { name } : {}),
    lastSeenAt: new Date().toISOString(),
  }).where(eq(users.id, id)).run();
}

export function touchLastSeen(id: string, name?: string | null): void {
  db.update(users).set({
    lastSeenAt: new Date().toISOString(),
    ...(name ? { name } : {}),
  }).where(eq(users.id, id)).run();
}

/** Invalidates every outstanding JWT for this account — see spec 020. */
export function bumpSessionEpoch(id: string): void {
  db.update(users).set({ sessionEpoch: sql`session_epoch + 1` }).where(eq(users.id, id)).run();
}
