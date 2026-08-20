import { db } from './client';
import { localAccounts, users } from './schema';
import { eq, count } from 'drizzle-orm';

/**
 * Local username/password credentials — the break-glass path that exists so RuleBeat can never
 * be a self-hosted install with literally no way in. Never returns a password hash to anything
 * but `lib/password.ts` — same discipline as `AzureCredentialSummary` never carrying a secret.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface LocalAccount {
  userId: string;
  passwordHash: string;
  mustChangePassword: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  passwordUpdatedAt: string | null;
  createdAt: string;
}

type Row = typeof localAccounts.$inferSelect;

function rowToAccount(row: Row): LocalAccount {
  return {
    userId: row.userId,
    passwordHash: row.passwordHash,
    mustChangePassword: row.mustChangePassword,
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil ?? null,
    passwordUpdatedAt: row.passwordUpdatedAt ?? null,
    createdAt: row.createdAt,
  };
}

export function getLocalAccount(userId: string): LocalAccount | null {
  const row = db.select().from(localAccounts).where(eq(localAccounts.userId, userId)).get();
  return row ? rowToAccount(row) : null;
}

/** Which users currently have a local password — for the Users table's status badge. */
export function listUserIdsWithPassword(): string[] {
  return db.select({ userId: localAccounts.userId }).from(localAccounts).all().map(r => r.userId);
}

/** True while a lockout from too many failed attempts is still in effect. */
export function isLockedOut(account: Pick<LocalAccount, 'lockedUntil'>): boolean {
  return !!account.lockedUntil && new Date(account.lockedUntil).getTime() > Date.now();
}

/**
 * Sets (or replaces) a user's local password. Always clears any lockout/failed-attempt state —
 * a fresh password is a fresh start, and an admin resetting a locked-out user's password is the
 * normal way that lockout gets lifted early.
 */
export function setPassword(userId: string, passwordHash: string, opts: { mustChangePassword: boolean }): void {
  const now = new Date().toISOString();
  const existing = db.select().from(localAccounts).where(eq(localAccounts.userId, userId)).get();

  if (existing) {
    db.update(localAccounts).set({
      passwordHash,
      mustChangePassword: opts.mustChangePassword,
      failedAttempts: 0,
      lockedUntil: null,
      passwordUpdatedAt: now,
    }).where(eq(localAccounts.userId, userId)).run();
    return;
  }

  db.insert(localAccounts).values({
    userId,
    passwordHash,
    mustChangePassword: opts.mustChangePassword,
    failedAttempts: 0,
    lockedUntil: null,
    passwordUpdatedAt: now,
    createdAt: now,
  }).run();
}

/** Removes a user's local password entirely — they can only reach RuleBeat through SSO. */
export function clearPassword(userId: string): void {
  db.delete(localAccounts).where(eq(localAccounts.userId, userId)).run();
}

/**
 * Records a failed sign-in attempt, locking the account once `MAX_FAILED_ATTEMPTS` is reached.
 * No-op if the user has no local account at all — the caller (`authorize()`) still burns a dummy
 * password verification in that case, so timing doesn't reveal which emails exist.
 */
export function recordFailedAttempt(userId: string): void {
  const account = getLocalAccount(userId);
  if (!account) return;

  const failedAttempts = account.failedAttempts + 1;
  const lockedUntil = failedAttempts >= MAX_FAILED_ATTEMPTS
    ? new Date(Date.now() + LOCKOUT_MS).toISOString()
    : account.lockedUntil;

  db.update(localAccounts).set({ failedAttempts, lockedUntil })
    .where(eq(localAccounts.userId, userId)).run();
}

/** Resets the failure counter and any lockout — called after a successful sign-in. */
export function clearFailedAttempts(userId: string): void {
  db.update(localAccounts).set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(localAccounts.userId, userId)).run();
}

/**
 * How many admins currently have a local password set — the number that must stay above zero
 * before local sign-in can be restricted, or an install could lock itself out of its own tool.
 */
export function countAdminsWithPassword(): number {
  return db.select({ n: count() })
    .from(localAccounts)
    .innerJoin(users, eq(users.id, localAccounts.userId))
    .where(eq(users.role, 'admin'))
    .get()?.n ?? 0;
}
