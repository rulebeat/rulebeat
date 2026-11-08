/**
 * Who a Shared dashboard or saved view can be handed to (ADR 0012): an Admin, or anyone who holds an Editor
 * Role at any Scope, which is whoever may act on the kind's write action. The owner it has now is left out.
 * The list carries what a picker shows (a name and an email) and nothing of the Roles or Scopes behind it.
 * The hand-over route asks the same list again, so what is offered and what is accepted cannot drift apart.
 */
import { listUsersWithAccess } from '@/lib/access';
import { mayAct } from '@/lib/rbac';
import type { ItemKind } from '@/lib/item-access-model';

export interface HandOverCandidate { id: string; displayName: string; email: string }

export async function handOverCandidates(kind: ItemKind, currentOwnerId: string | null): Promise<HandOverCandidate[]> {
  const write = kind === 'dashboard' ? 'dashboards:write' : 'views:write';
  return (await listUsersWithAccess())
    .filter(user => user.id !== currentOwnerId && mayAct(user.access, write))
    .map(user => ({ id: user.id, displayName: user.name || user.email, email: user.email }))
    .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) || a.id.localeCompare(b.id));
}
