import { refreshMirroredUser, type RoleAssignmentReader } from '@/lib/access-mirror';
import { getUser, listMirroredUsers, type AppUser } from '@/lib/db/users';
import { refreshDue } from '@/lib/management-group-tree';

export interface MirrorRefreshDeps {
  /** Defaults to RuleBeat's own Reader credential, resolved by `refreshMirroredUser`. */
  read?: RoleAssignmentReader;
  /** How a throttled read waits before it asks again. */
  wait?: (ms: number) => Promise<void>;
}

/** Whether a person is one a refresh can read: mirrored, not an Admin, and with a Linked account. */
function isRefreshable(user: AppUser | null): user is AppUser {
  return !!user && user.role !== 'admin' && user.accessSource === 'mirrored' && !!user.linkedAccount;
}

/**
 * Refreshes every mirrored person whose last attempt, successful or not, was an hour ago or more (or who has
 * had none), one at a time, so one person's failure never stops the rest. `refreshMirroredUser` records a
 * failed read itself and keeps the last Scopes; nothing here throws. No audit entry is written: the audit log
 * stays at the API route layer. `now`, `read` and `wait` are for tests: a real pass passes none.
 */
export async function refreshMirrorsIfDue(opts: { now?: Date; read?: RoleAssignmentReader; wait?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  let people: AppUser[];
  try {
    people = await listMirroredUsers();
  } catch (err) {
    console.error('[scheduler] listing mirrored people failed:', err);
    return;
  }
  for (const person of people) {
    try {
      if (!isRefreshable(person) || !refreshDue({ lastAttemptAt: person.mirror?.lastAttemptAt ?? null }, now)) continue;
      await refreshMirroredUser(person, { read: opts.read, wait: opts.wait, now: () => now });
    } catch (err) {
      console.error('[scheduler] mirrored access refresh failed:', err);
    }
  }
}

/**
 * Starts a refresh of one person's mirror when they sign in, and never makes the sign-in wait for it: the
 * returned promise is for tests, and a caller does not await it. Does nothing for anyone who is not mirrored,
 * is an Admin or has no Linked account. Every error is logged and swallowed, so a rejection can never fail a
 * sign-in or surface as an unhandled one.
 */
export async function startSignInMirrorRefresh(userId: string, deps: MirrorRefreshDeps = {}): Promise<void> {
  try {
    const user = await getUser(userId);
    if (!isRefreshable(user)) return;
    await refreshMirroredUser(user, { read: deps.read, wait: deps.wait });
  } catch (err) {
    console.error('[RuleBeat] The sign-in refresh of Mirrored access failed:', err);
  }
}
