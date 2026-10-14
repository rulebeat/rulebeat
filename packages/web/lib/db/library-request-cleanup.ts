import { and, eq } from 'drizzle-orm';
import { many, run, type DbHandle } from './exec';
import { libraryRequests } from './tables';

/**
 * The parts of Library requests (#282) that `deleteUser()` needs, kept apart from `library-requests.ts`
 * (which reads rules) so the users repository does not import the rules repository.
 */

/** Taken by every change of a request's status, so two reviewers (or a reviewer and the author) cannot both close it. A no-op on SQLite. */
export const LIBRARY_REQUEST_LOCK_KEY = 7194826034;

/**
 * Withdraws every open request the author has, on the caller's transaction, and returns how many. A request
 * never outlives the person who could withdraw or resubmit it.
 */
export async function withdrawOpenRequestsOn(tx: DbHandle, authorId: string): Promise<number> {
  const open = await many(tx.select({ id: libraryRequests.id }).from(libraryRequests)
    .where(and(eq(libraryRequests.authorId, authorId), eq(libraryRequests.status, 'open'))));
  if (open.length === 0) return 0;
  await run(tx.update(libraryRequests).set({ status: 'withdrawn' })
    .where(and(eq(libraryRequests.authorId, authorId), eq(libraryRequests.status, 'open'))));
  return open.length;
}

/**
 * Withdraws the open request of one of the author's Personal rules, on the caller's transaction, and returns
 * the ids it withdrew. The caller holds `LIBRARY_REQUEST_LOCK_KEY`.
 */
export async function withdrawOpenRequestsOfRuleOn(tx: DbHandle, personalRuleId: string, authorId: string): Promise<string[]> {
  const where = and(
    eq(libraryRequests.personalRuleId, personalRuleId), eq(libraryRequests.authorId, authorId), eq(libraryRequests.status, 'open'),
  );
  const open = await many(tx.select({ id: libraryRequests.id }).from(libraryRequests).where(where));
  if (open.length > 0) await run(tx.update(libraryRequests).set({ status: 'withdrawn' }).where(where));
  return open.map(r => r.id);
}

/**
 * Detaches every request of the author's from the Personal rules that are being deleted, on the caller's
 * transaction. The requests stay as history: only the pointer to the rule goes.
 */
export async function detachRequestsOfAuthorOn(tx: DbHandle, authorId: string): Promise<void> {
  await run(tx.update(libraryRequests).set({ personalRuleId: null }).where(eq(libraryRequests.authorId, authorId)));
}
