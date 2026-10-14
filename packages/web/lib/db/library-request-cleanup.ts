import { and, eq } from 'drizzle-orm';
import { many, run, type DbHandle } from './exec';
import { libraryRequests } from './tables';

/**
 * The parts of Library requests (#282) that `deleteUser()` needs, kept apart from `library-requests.ts`
 * (which reads rules) so the users repository does not import the rules repository.
 */

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
 * Detaches every request of the author's from the Personal rules that are being deleted, on the caller's
 * transaction. The requests stay as history: only the pointer to the rule goes.
 */
export async function detachRequestsOfAuthorOn(tx: DbHandle, authorId: string): Promise<void> {
  await run(tx.update(libraryRequests).set({ personalRuleId: null }).where(eq(libraryRequests.authorId, authorId)));
}
