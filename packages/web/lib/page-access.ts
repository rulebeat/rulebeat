import { getCurrentUser } from '@/lib/api-auth';
import { resolveAccess } from '@/lib/access';
import { NO_ACCESS, type Access } from '@/lib/access-model';
import type { AppUser } from '@/lib/db/users';

/**
 * The signed-in person and what they may reach, for a server page. Nobody signed in holds nothing. A
 * page reads this where a route reads `requireRole`: the role is read from the database on every call,
 * never from the session token.
 */
export async function getPageAccess(): Promise<{ user: AppUser | null; access: Access }> {
  const user = await getCurrentUser();
  return { user, access: user ? await resolveAccess(user) : NO_ACCESS };
}
